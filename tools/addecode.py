#!/usr/bin/env python3
"""
addecode.py — decode the binary attributes that ldapsearch hands back as base64.

Active Directory keeps a lot of the interesting state in NDR-packed blobs:
objectSid, objectGUID, nTSecurityDescriptor, and repsFrom (the replication
metadata that `samba-tool drs showrepl` prints). python3-samba already knows how
to unpack all of them, so this reads LDIF on stdin and prints it readable.

    ldapsearch ... | addecode.py entry
    addecode.py repl <dc-fqdn> [<dc-fqdn> ...]

Nothing here writes to the directory.
"""

import base64
import datetime
import subprocess
import sys

UAC_NAMES = [
    (0x00000002, "DISABLED"), (0x00000008, "HOMEDIR_REQUIRED"),
    (0x00000010, "LOCKOUT"), (0x00000020, "PASSWD_NOTREQD"),
    (0x00000040, "PASSWD_CANT_CHANGE"), (0x00000080, "ENCRYPTED_TEXT_PWD_ALLOWED"),
    (0x00000100, "TEMP_DUPLICATE_ACCOUNT"), (0x00000200, "NORMAL_ACCOUNT"),
    (0x00000800, "INTERDOMAIN_TRUST_ACCOUNT"), (0x00001000, "WORKSTATION_TRUST_ACCOUNT"),
    (0x00002000, "SERVER_TRUST_ACCOUNT"), (0x00010000, "DONT_EXPIRE_PASSWORD"),
    (0x00020000, "MNS_LOGON_ACCOUNT"), (0x00040000, "SMARTCARD_REQUIRED"),
    (0x00080000, "TRUSTED_FOR_DELEGATION"), (0x00100000, "NOT_DELEGATED"),
    (0x00200000, "USE_DES_KEY_ONLY"), (0x00400000, "DONT_REQ_PREAUTH"),
    (0x00800000, "PASSWORD_EXPIRED"),
    (0x01000000, "TRUSTED_TO_AUTH_FOR_DELEGATION"),
]


def nttime(v):
    """NT time (100ns ticks since 1601) -> readable UTC, or 'never'."""
    if not v:
        return "never"
    return (datetime.datetime(1601, 1, 1)
            + datetime.timedelta(microseconds=v // 10)).strftime("%Y-%m-%d %H:%M:%SZ")


def decode(attr, raw):
    from samba.ndr import ndr_unpack
    from samba.dcerpc import security, misc, drsblobs
    if attr == "objectSid":
        return str(ndr_unpack(security.dom_sid, raw))
    if attr in ("objectGUID", "invocationId", "schemaIDGUID", "attributeSecurityGUID"):
        return str(ndr_unpack(misc.GUID, raw))
    if attr == "nTSecurityDescriptor":
        sd = ndr_unpack(security.descriptor, raw)
        return "owner=%s group=%s aces=%d\n    %s" % (
            sd.owner_sid, sd.group_sid,
            sd.dacl.num_aces if sd.dacl else 0, sd.as_sddl())
    if attr in ("repsFrom", "repsTo"):
        c = ndr_unpack(drsblobs.repsFromToBlob, raw).ctr
        return ("partner=%s last_success=%s last_attempt=%s failures=%d result=%s"
                % (c.other_info.dns_name, nttime(c.last_success),
                   nttime(c.last_attempt), c.consecutive_sync_failures,
                   c.result_last_attempt[1]))
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return "<binary %d bytes> %s" % (len(raw), raw[:32].hex())


def cmd_entry(stream):
    """Read LDIF on stdin, print it with the blobs decoded."""
    text = stream.read().replace("\n ", "")
    for line in text.splitlines():
        if line.startswith("# ref"):
            # With ldif-wrap=no, ldapsearch prints search references as
            # "# refldap://..." with no separator. Relabel rather than leave the
            # run-together text. These are normal: AD refers subtree searches
            # that cross into the config/DNS naming contexts.
            print("# referral (not followed): " + line[5:])
            continue
        if not line.strip() or line.startswith("#"):
            print(line)
            continue
        attr, _, val = line.partition(":")
        if val.startswith(":"):
            try:
                val = decode(attr, base64.b64decode(val[1:].strip()))
            except Exception as e:
                val = "<undecodable: %s>" % e
            print("%s: %s" % (attr, val))
        elif attr == "userAccountControl":
            n = int(val)
            names = [nm for bit, nm in UAC_NAMES if n & bit]
            print("userAccountControl: 0x%08x  %s" % (n, " ".join(names)))
        elif attr in ("pwdLastSet", "lastLogonTimestamp", "accountExpires",
                      "badPasswordTime", "lastLogon"):
            try:
                print("%s: %s (%s)" % (attr, val.strip(), nttime(int(val))))
            except ValueError:
                print(line)
        else:
            print(line)


def ldif(host, base, scope, filt, attrs):
    p = subprocess.run(
        ["ldapsearch", "-LLL", "-Y", "GSSAPI", "-Q", "-o", "ldif-wrap=no",
         "-H", "ldap://" + host, "-b", base, "-s", scope, filt] + attrs,
        capture_output=True, text=True)
    return p.stdout


def cmd_repl(hosts):
    """Per-DC inbound replication health, read straight out of repsFrom."""
    from samba.ndr import ndr_unpack
    from samba.dcerpc import drsblobs, misc

    # Map NTDS invocation GUIDs to DC names so the report names partners rather
    # than printing bare GUIDs.
    names = {}
    cfg = ldif(hosts[0], "CN=Configuration,DC=ad,DC=edt1,DC=lab", "sub",
               "(objectClass=nTDSDSA)", ["objectGUID"])
    dn = None
    for line in cfg.replace("\n ", "").splitlines():
        if line.startswith("dn: "):
            dn = line[4:]
        elif line.startswith("objectGUID::") and dn:
            g = str(ndr_unpack(misc.GUID, base64.b64decode(line.split("::", 1)[1].strip())))
            names[g] = dn.split(",")[1].replace("CN=", "")

    worst = 0
    for host in hosts:
        print("  %s" % host)
        out = ldif(host, "DC=ad,DC=edt1,DC=lab", "base", "(objectClass=*)", ["repsFrom"])
        found = False
        for line in out.replace("\n ", "").splitlines():
            if not line.startswith("repsFrom::"):
                continue
            found = True
            c = ndr_unpack(drsblobs.repsFromToBlob,
                           base64.b64decode(line.split("::", 1)[1].strip())).ctr
            guid = c.other_info.dns_name.split(".")[0]
            partner = names.get(guid, c.other_info.dns_name)
            fails = c.consecutive_sync_failures
            worst = max(worst, fails)
            print("      <- %-6s last success %s  failures=%d  %s"
                  % (partner, nttime(c.last_success), fails, c.result_last_attempt[1]))
        if not found:
            print("      (no inbound partners reported)")
    print("\n  worst consecutive failure count across all links: %d" % worst)
    return 0 if worst == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) < 2 or sys.argv[1] == "entry":
        cmd_entry(sys.stdin)
    elif sys.argv[1] == "repl":
        sys.exit(cmd_repl(sys.argv[2:] or ["dc1.ad.edt1.lab"]))
    else:
        sys.exit(__doc__)
