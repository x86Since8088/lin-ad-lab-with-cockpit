#!/usr/bin/env python3
"""Full unit tests for the adlab-admin verb API.

Everything effectful goes through adlab_admin.RUN, so a FakeRunner gives the
tests complete control: each test declares what the lab looks like (which
containers run, what samba-tool prints) and asserts on BOTH the JSON the verb
returns and the exact commands it constructed. No podman, no containers, no
root needed.

Run:  python3 -m unittest discover -s tests -v          (from source/)
"""

import base64
import importlib.machinery
import importlib.util
import io
import json
import os
import struct
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "adlab-admin")
_LABSRC = os.path.abspath(os.path.join(HERE, "..", ".."))  # samba-ad-lab/source

# adlab-admin now resolves its configuration per DEPLOY-CONTRACT section 4.3
# (install.conf -> ENV_FILE -> the six ADLAB_* keys) and no longer discovers the
# tree. The tests supply config the sanctioned way: $ADLAB_ENV (section 4.3
# step 1 — honoured only for a non-root caller on a file it owns, which is
# exactly `unittest` run as a normal user). It points the keys at the real,
# checked-in lab.env/rdp.env so LAB matches the lab under test; SECRET_DIR and
# the GPO/sysvol locations are paths the verbs name but the FakeRunner never opens.
_envfd, _ENVPATH = tempfile.mkstemp(prefix="adlab-test-", suffix=".env")
os.write(_envfd, ("\n".join([
    "ADLAB_ROOT=%s" % _LABSRC,
    "ADLAB_LAB_ENV=%s" % os.path.join(_LABSRC, "lab.env"),
    "ADLAB_RDP_ENV=%s" % os.path.join(_LABSRC, "rdp", "rdp.env"),
    "ADLAB_SYSVOL_REPLICATE=%s" % os.path.join(_LABSRC, "sysvol", "sysvol-replicate.sh"),
    "ADLAB_SECRET_DIR=%s" % os.path.join(_LABSRC, "..", ".secrets"),
    "ADLAB_GPO_TEMPLATE_DIR=/var/lib/samba/gpo-templates",
    "",
])).encode())
os.close(_envfd)
os.environ["ADLAB_ENV"] = _ENVPATH

loader = importlib.machinery.SourceFileLoader("adlab_admin", HELPER)
spec = importlib.util.spec_from_loader("adlab_admin", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)


# ---------------------------------------------------------------------------
# fixtures: realistic samba-tool output
# ---------------------------------------------------------------------------

FSMO_OUT = """SchemaMasterRole owner: CN=NTDS Settings,CN=DC2,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
InfrastructureMasterRole owner: CN=NTDS Settings,CN=DC3,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
RidAllocationMasterRole owner: CN=NTDS Settings,CN=DC1,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
PdcEmulationMasterRole owner: CN=NTDS Settings,CN=DC1,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
DomainNamingMasterRole owner: CN=NTDS Settings,CN=DC2,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
DomainDnsZonesMasterRole owner: CN=NTDS Settings,CN=DC4,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
ForestDnsZonesMasterRole owner: CN=NTDS Settings,CN=DC5,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
"""

SHOWREPL_HEALTHY = """Default-First-Site-Name\\DC1
DSA Options: 0x00000001
DSA object GUID: 4a6b8f00-1111-2222-3333-444455556666
DSA invocationId: deadbeef-1111-2222-3333-444455556666

==== INBOUND NEIGHBORS ====

DC=ad,DC=edt1,DC=lab
\tDefault-First-Site-Name\\DC2 via RPC
\t\tDSA object GUID: 12345678-aaaa-bbbb-cccc-dddddddddddd
\t\tLast attempt @ Mon Aug 31 12:00:01 2026 CDT was successful
\t\t0 consecutive failure(s).
\t\tLast success @ Mon Aug 31 12:00:01 2026 CDT

==== OUTBOUND NEIGHBORS ====

CN=Configuration,DC=ad,DC=edt1,DC=lab
\tDefault-First-Site-Name\\DC3 via RPC
\t\tDSA object GUID: 87654321-aaaa-bbbb-cccc-dddddddddddd
\t\tLast attempt @ Mon Aug 31 12:00:05 2026 CDT was successful
\t\t0 consecutive failure(s).
\t\tLast success @ Mon Aug 31 12:00:05 2026 CDT

==== KCC CONNECTION OBJECTS ====
"""

SHOWREPL_BROKEN = SHOWREPL_HEALTHY.replace(
    "Last attempt @ Mon Aug 31 12:00:01 2026 CDT was successful",
    "Last attempt @ Mon Aug 31 12:00:01 2026 CDT failed, result 1722 (WERR_RPC_S_SERVER_UNAVAILABLE)"
).replace("0 consecutive failure(s).", "7 consecutive failure(s).", 1)

USER_SHOW = """dn: CN=Alice Adams,CN=Users,DC=ad,DC=edt1,DC=lab
objectClass: top
objectClass: person
objectClass: user
cn: Alice Adams
sAMAccountName: alice
memberOf: CN=Domain Admins,CN=Users,DC=ad,DC=edt1,DC=lab
memberOf: CN=stress-g1,CN=Users,DC=ad,DC=edt1,DC=lab
userAccountControl: 512
"""

GPO_LISTALL = """GPO          : {31B2F340-016D-11D2-945F-00C04FB984F9}
display name : Default Domain Policy
path         : \\\\ad.edt1.lab\\sysvol\\ad.edt1.lab\\Policies\\{31B2F340-016D-11D2-945F-00C04FB984F9}
dn           : CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=ad,DC=edt1,DC=lab
version      : 3
flags        : NONE

GPO          : {6AC1786C-016F-11D2-945F-00C04FB984F9}
display name : Default Domain Controllers Policy
path         : \\\\ad.edt1.lab\\sysvol\\ad.edt1.lab\\Policies\\{6AC1786C-016F-11D2-945F-00C04FB984F9}
dn           : CN={6AC1786C-016F-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=ad,DC=edt1,DC=lab
version      : 0
flags        : NONE
"""

DNS_ZONELIST = """  2 zone(s) found

  pszZoneName                 : ad.edt1.lab
  Flags                       : DNS_RPC_ZONE_DSINTEGRATED DNS_RPC_ZONE_UPDATE_SECURE
  ZoneType                    : DNS_ZONE_TYPE_PRIMARY

  pszZoneName                 : _msdcs.ad.edt1.lab
  Flags                       : DNS_RPC_ZONE_DSINTEGRATED DNS_RPC_ZONE_UPDATE_SECURE
  ZoneType                    : DNS_ZONE_TYPE_PRIMARY
"""

DNS_QUERY = """  Name=, Records=2, Children=0
    SOA: serial=110, refresh=900, retry=600, expire=86400, minttl=3600, ns=dc1.ad.edt1.lab., email=hostmaster.ad.edt1.lab. (flags=600000f0, serial=110, ttl=3600)
    NS: dc1.ad.edt1.lab. (flags=600000f0, serial=110, ttl=900)
  Name=dc1, Records=1, Children=0
    A: 172.15.4.10 (flags=f0, serial=110, ttl=900)
  Name=dc2, Records=1, Children=0
    A: 172.15.4.11 (flags=f0, serial=110, ttl=900)
"""

PROCESSES = """ Service:                          PID
 --------------------------------------
 cldap_server                     87
 dnssrv                           92
 dnsupdate                        95
 kdc_server                       88
 ldap_server                      85
"""

DOMAIN_INFO = """Forest           : ad.edt1.lab
Domain           : ad.edt1.lab
Netbios domain   : EDT1LAB
DC name          : dc1.ad.edt1.lab
DC netbios name  : DC1
Server site      : Default-First-Site-Name
Client site      : Default-First-Site-Name
"""


# ---------------------------------------------------------------------------
# the fake runner
# ---------------------------------------------------------------------------

class FakeRunner:
    """Routes argv to canned results; records every call for assertions."""

    def __init__(self):
        self.rules = []          # (predicate, (rc, out, err))
        self.calls = []          # (argv, stdin)

    def on(self, pred, rc=0, out="", err=""):
        self.rules.append((pred, (rc, out, err)))
        return self

    def run(self, argv, stdin=None, timeout=120):
        self.calls.append((list(argv), stdin))
        for pred, res in self.rules:
            if pred(argv):
                return res
        return 1, "", "no fake rule for: %s" % " ".join(map(str, argv))

    # -- convenience canned lab -------------------------------------------
    def lab_up(self):
        """All 5 DCs and 10 clients running; fsmo answered by any DC."""
        self.on(lambda a: a[:2] == ["podman", "inspect"] and
                          "--format" in a and "{{.State.Status}}" in a,
                out="running\n")
        self.on(lambda a: a[:2] == ["podman", "inspect"] and
                          any("Networks" in x for x in a),
                out="172.15.4.10\n")
        self.on(lambda a: "fsmo" in a and "show" in a, out=FSMO_OUT)
        return self

    def argv_containing(self, *words):
        """All recorded argvs containing every word (in any element)."""
        hits = []
        for argv, _ in self.calls:
            joined = " ".join(map(str, argv))
            if all(w in joined for w in words):
                hits.append(argv)
        return hits


class Base(unittest.TestCase):
    def setUp(self):
        self.fake = FakeRunner()
        self._old_run = mod.RUN
        mod.RUN = self.fake
        self._audit = tempfile.NamedTemporaryFile(delete=False, suffix=".log")
        self._audit.close()
        self._old_audit = mod.AUDIT_LOG
        mod.AUDIT_LOG = self._audit.name
        # isolate the per-GPO OS-scope store so no test writes to /var/lib/adlab
        self._gpo_os = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        self._gpo_os.close()
        os.unlink(self._gpo_os.name)          # start with no file
        self._old_gpo_os = mod.GPO_OS_FILE
        mod.GPO_OS_FILE = self._gpo_os.name
        # isolate the CA node's host material dir so pki-ca-deploy never touches
        # the real /var/lib/adlab/ca
        self._ca_dir = tempfile.mkdtemp(suffix=".ca")
        self._old_ca_dir = mod.PKI_CA_DIR
        mod.PKI_CA_DIR = self._ca_dir
        # isolate the container-supervisor state file
        self._sup = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        self._sup.close(); os.unlink(self._sup.name)
        self._old_sup = mod.CTR_SUPERVISOR_FILE
        mod.CTR_SUPERVISOR_FILE = self._sup.name

    def tearDown(self):
        mod.RUN = self._old_run
        mod.AUDIT_LOG = self._old_audit
        mod.GPO_OS_FILE = self._old_gpo_os
        mod.PKI_CA_DIR = self._old_ca_dir
        mod.CTR_SUPERVISOR_FILE = self._old_sup
        if os.path.exists(self._sup.name):
            os.unlink(self._sup.name)
        import shutil
        shutil.rmtree(self._ca_dir, ignore_errors=True)
        if os.path.exists(self._gpo_os.name):
            os.unlink(self._gpo_os.name)
        os.unlink(self._audit.name)

    def call_main(self, argv, stdin=""):
        """Invoke main() capturing stdout; returns (exit_code, parsed_json)."""
        old_out, old_in = sys.stdout, sys.stdin
        sys.stdout = io.StringIO()
        sys.stdin = io.StringIO(stdin)
        try:
            rc = mod.main(argv)
            out = sys.stdout.getvalue()
        finally:
            sys.stdout, sys.stdin = old_out, old_in
        self.assertTrue(out.strip(), "verb printed nothing")
        return rc, json.loads(out)


# ---------------------------------------------------------------------------
# 1. schema integrity — the contract that drives every UI control
# ---------------------------------------------------------------------------

KNOWN_TYPES = {"str", "int", "bool", "enum", "password-stdin"}
KNOWN_GROUPS = {"meta", "overview", "fsmo", "users", "groups", "gpo", "objects",
                "sites", "dns", "dcs", "clients", "activity", "domains",
                "members", "rds", "spn", "kerberos", "crypto", "pki",
                "delegation", "authpolicy", "containers"}
DESTRUCTIVE = {"fsmo-transfer", "fsmo-seize", "user-delete", "group-delete",
               "ou-delete", "gpo-delete", "gpo-unlink", "gpo-settings-remove",
               "dns-delete", "dc-restart", "dc-shell", "dc-promote", "dc-demote",
               "dc-decommission", "domain-add", "domain-remove",
               "client-remove", "member-deprovision", "spn-delete",
               "crypto-harden", "crypto-set",
               "domain-trust-create", "domain-trust-delete",
               "pki-ca-destroy", "pki-ca-unpublish", "pki-template-delete",
               "delegation-set-unconstrained", "delegation-set-protocol-transition",
               "delegation-remove-service", "rbcd-remove",
               "protected-users-add", "protected-users-remove",
               "authpolicy-delete", "authsilo-delete", "authsilo-member-revoke",
               "container-stop", "container-restart", "container-supervise-disable"}


class TestSchema(Base):
    def test_every_verb_is_complete(self):
        for name, spec_ in mod.VERBS.items():
            self.assertTrue(callable(spec_["fn"]), name)
            self.assertTrue(spec_["help"], "%s: empty help" % name)
            self.assertIn(spec_["group"], KNOWN_GROUPS, name)
            for a in spec_.get("args", []):
                self.assertIn(a["type"], KNOWN_TYPES, "%s.%s" % (name, a["name"]))
                self.assertIn("required", a, "%s.%s" % (name, a["name"]))
                if a["type"] == "enum":
                    self.assertTrue(a.get("choices"), "%s.%s: enum without choices"
                                    % (name, a["name"]))

    def test_destructive_verbs_are_flagged_danger(self):
        for name in DESTRUCTIVE:
            self.assertTrue(mod.VERBS[name].get("danger"),
                            "%s must carry danger:true" % name)


class TestDomains(Base):
    """Multi-forest lifecycle: domain-list/add/remove/backup + dc-decommission."""

    def _no_extra_domains(self):
        # list_domains() discovery ('names\trealm') sees no additional forests.
        self.fake.on(lambda a: a[:3] == ["podman", "ps", "-a"]
                     and any("{{.Names}}\t" in x for x in a), out="")

    def _one_extra_domain(self, realm="CORP.EXAMPLE.LAB", slug="corp",
                          prefix="10.44.1", dcs=("corp-dc1",)):
        self.fake.on(lambda a: a[:3] == ["podman", "ps", "-a"]
                     and any("{{.Names}}\t" in x for x in a),
                     out="%s\t%s\n" % (dcs[0], realm))
        self.fake.on(lambda a: a[:3] == ["podman", "ps", "-a"]
                     and ("label=adlab.realm=%s" % realm) in a,
                     out="\n".join(dcs) + "\n")
        labels = {"adlab.realm": realm, "adlab.slug": slug,
                  "adlab.domain_nb": slug.upper(), "adlab.net": "adlab-" + slug,
                  "adlab.net_prefix": prefix, "adlab.dc_base": "10"}
        for k, v in labels.items():
            self.fake.on(
                (lambda key, val: (lambda a: a[:2] == ["podman", "inspect"]
                                   and any(('"%s"' % key) in x for x in a)))(k, v),
                out=v + "\n")

    def test_domain_list_primary_only(self):
        self.fake.lab_up()
        self._no_extra_domains()
        rc, out = self.call_main(["domain-list"])
        self.assertEqual(rc, 0, out)
        prim = [d for d in out["domains"] if d["primary"]]
        self.assertEqual(len(prim), 1)
        self.assertEqual(prim[0]["realm"], mod.PRIMARY_LAB["REALM"])
        self.assertEqual(prim[0]["dc_count"], mod.PRIMARY_LAB["DC_COUNT"])

    def test_domain_list_discovery_uses_ps_label_field(self):
        # Regression: `podman ps --format` exposes labels as .Labels; .Config.Labels
        # is an INSPECT-only field and comes back empty in ps, which silently hid
        # every additional forest. Pin the discovery template to a ps-valid field.
        self.fake.lab_up()
        self._no_extra_domains()
        self.call_main(["domain-list"])
        # The DISCOVERY ps is the one that reads the realm label (all_dcs' plain
        # `{{.Names}}` primary-DC probe also runs now, so filter on the label field).
        disc = [a for a, _ in self.fake.calls
                if a[:3] == ["podman", "ps", "-a"] and any(".Labels" in x for x in a)]
        self.assertTrue(disc, "domain-list must run a label-based discovery `podman ps`")
        for a in disc:
            joined = " ".join(a)
            self.assertNotIn(".Config.Labels", joined,
                             "ps --format must use .Labels, not inspect's .Config.Labels")
            self.assertIn(".Labels", joined)

    def test_domain_add_creates_network_and_provisions(self):
        self.fake.lab_up()
        self._no_extra_domains()
        self.fake.on(lambda a: a[:3] == ["podman", "network", "create"], out="net\n")
        self.fake.on(lambda a: a[:2] == ["podman", "run"], out="ctrid\n")
        rc, out = self.call_main(["domain-add", "--realm", "CORP.EXAMPLE.LAB",
                                  "--domain_nb", "CORP"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["domain"], "CORP.EXAMPLE.LAB")
        self.assertEqual(out["network"], "adlab-corp")
        self.assertEqual(out["dc"], "corp-dc1")
        self.assertEqual(out["subnet"], "10.44.1.0/24")
        self.assertTrue(self.fake.argv_containing("network", "create", "adlab-corp", "10.44.1.0/24"))
        self.assertTrue(self.fake.argv_containing("podman", "run", "ROLE=provision", "REALM=CORP.EXAMPLE.LAB"))
        self.assertTrue(self.fake.argv_containing("adlab.realm=CORP.EXAMPLE.LAB"))
        self.assertTrue(self.fake.argv_containing("--network", "adlab-corp"))

    def test_domain_add_refuses_primary_realm(self):
        self.fake.lab_up()
        self._no_extra_domains()
        rc, out = self.call_main(["domain-add", "--realm", mod.PRIMARY_LAB["REALM"],
                                  "--domain_nb", "X"])
        self.assertEqual(rc, 1)
        self.assertIn("primary", out["error"])

    def test_domain_add_refuses_duplicate(self):
        self.fake.lab_up()
        self._one_extra_domain()
        rc, out = self.call_main(["domain-add", "--realm", "CORP.EXAMPLE.LAB",
                                  "--domain_nb", "CORP"])
        self.assertEqual(rc, 1)
        self.assertIn("already exists", out["error"])

    def test_dc_decommission_refuses_primary_dc1(self):
        self.fake.lab_up()
        self._no_extra_domains()
        rc, out = self.call_main(["dc-decommission", "--dc", "dc1"])
        self.assertEqual(rc, 1)
        self.assertIn("dc1", out["error"])

    # -- child domain via a parent (forest trust) -------------------------
    def test_domain_add_parent_places_child_on_parent_network(self):
        self.fake.lab_up()
        self._no_extra_domains()
        self.fake.on(lambda a: a[:2] == ["podman", "run"], out="ctrid\n")
        parent = mod.PRIMARY_LAB["REALM"]
        rc, out = self.call_main(["domain-add", "--realm", "CORP." + parent,
                                  "--domain_nb", "CORP", "--parent", parent])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["parent"], parent)
        self.assertTrue(out["shared_with_parent"])
        self.assertTrue(out["contiguous_namespace"])
        self.assertEqual(out["network"], mod.PRIMARY_LAB["NET"])
        self.assertEqual(out["ip"], mod.PRIMARY_LAB["NET_PREFIX"] + ".50")
        self.assertTrue(self.fake.argv_containing("--network", mod.PRIMARY_LAB["NET"]))
        self.assertTrue(self.fake.argv_containing("adlab.parent=" + parent))
        self.assertTrue(self.fake.argv_containing("ROLE=provision"))
        self.assertEqual(self.fake.argv_containing("network", "create"), [])  # no new net

    def test_domain_add_parent_unknown(self):
        self.fake.lab_up()
        self._no_extra_domains()
        rc, out = self.call_main(["domain-add", "--realm", "X.NOPE.LAB",
                                  "--domain_nb", "X", "--parent", "NOPE.LAB"])
        self.assertEqual(rc, 1)
        self.assertIn("no such domain", out["error"])

    def test_trust_create_rejects_self(self):
        self.fake.lab_up()
        self._no_extra_domains()
        p = mod.PRIMARY_LAB["REALM"]
        rc, out = self.call_main(["domain-trust-create", "--realm", p, "--parent", p])
        self.assertEqual(rc, 1)
        self.assertIn("itself", out["error"])

    def test_trust_create_missing_parent(self):
        self.fake.lab_up()
        self._no_extra_domains()
        rc, out = self.call_main(["domain-trust-create", "--realm", mod.PRIMARY_LAB["REALM"]])
        self.assertEqual(rc, 1)
        self.assertIn("no recorded parent", out["error"])

    def test_trust_list_parses(self):
        self.fake.lab_up()
        self._no_extra_domains()
        self.fake.on(lambda a: "trust" in a and "list" in a,
                     out="Type[Forest] Transitive[Yes] Direction[BOTH] Name[corp.ad.edt1.lab]\n")
        rc, out = self.call_main(["domain-trust-list"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["trusts"][0]["name"], "corp.ad.edt1.lab")
        self.assertEqual(out["trusts"][0]["direction"], "BOTH")
        self.assertEqual(out["trusts"][0]["type"], "Forest")

    def test_domain_remove_keeps_shared_parent_network(self):
        # a child domain shares the parent's network; removing it must NOT tear
        # down that network (only its DCs).
        self.fake.lab_up()
        realm = "CORP.AD.EDT1.LAB"
        parent = mod.PRIMARY_LAB["REALM"]
        self.fake.on(lambda a: a[:3] == ["podman", "ps", "-a"]
                     and any("{{.Names}}\t" in x for x in a), out="corp-dc1\t%s\n" % realm)
        self.fake.on(lambda a: a[:3] == ["podman", "ps", "-a"]
                     and ("label=adlab.realm=%s" % realm) in a, out="corp-dc1\n")
        labels = {"adlab.realm": realm, "adlab.slug": "corp", "adlab.domain_nb": "CORP",
                  "adlab.net": mod.PRIMARY_LAB["NET"],
                  "adlab.net_prefix": mod.PRIMARY_LAB["NET_PREFIX"],
                  "adlab.dc_base": "50", "adlab.parent": parent}
        for k, v in labels.items():
            self.fake.on((lambda key, val: (lambda a: a[:2] == ["podman", "inspect"]
                          and any(('"%s"' % key) in x for x in a)))(k, v), out=v + "\n")
        self.fake.on(lambda a: a[:2] == ["podman", "rm"], out="")
        rc, out = self.call_main(["domain-remove", "--realm", realm])
        self.assertEqual(rc, 0, out)
        self.assertIsNone(out["network_removed"])
        self.assertEqual(out["network_kept"], mod.PRIMARY_LAB["NET"])
        self.assertEqual(self.fake.argv_containing("network", "rm"), [])  # never removed
        self.assertIn("corp-dc1", out["removed_dcs"])

    def test_trust_create_happy_path(self):
        self.fake.lab_up()
        self._one_extra_domain(realm="CORP.AD.EDT1.LAB", slug="corp",
                               prefix="172.15.4", dcs=("corp-dc1",))
        self.fake.on(lambda a: "bash" in a and any("domain trust create" in str(x) for x in a),
                     out="Success\n")
        rc, out = self.call_main(["domain-trust-create", "--realm", "CORP.AD.EDT1.LAB",
                                  "--parent", mod.PRIMARY_LAB["REALM"], "--type", "forest"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["partner"], mod.PRIMARY_LAB["REALM"])
        self.assertTrue(out["created"])
        script = next(c[0] for c in self.fake.calls
                      if any("domain trust create" in str(x) for x in c[0]))
        j = " ".join(map(str, script))
        self.assertIn("--type=forest", j)
        self.assertIn("--create-location=both", j)
        self.assertIn('-A "$af"', j)                    # creds via authfile, not argv

    def test_dc_decommission_refuses_last_dc_of_forest(self):
        self.fake.lab_up()
        self._one_extra_domain(dcs=("corp-dc1",))
        rc, out = self.call_main(["dc-decommission", "--dc", "corp-dc1"])
        self.assertEqual(rc, 1)
        self.assertIn("last DC", out["error"])

    def test_dc_list_dynamic_for_additional_forest(self):
        # Regression: an additional forest with ONE DC must show ONE DC on the
        # DCs tab, not five inherited from PRIMARY_LAB["DC_COUNT"].
        self.fake.lab_up()
        self._one_extra_domain(realm="CORP.EXAMPLE.LAB", slug="corp", dcs=("corp-dc1",))
        rc, out = self.call_main(["--domain", "CORP.EXAMPLE.LAB", "dc-list"])
        self.assertEqual(rc, 0, out)
        self.assertEqual([d["dc"] for d in out["dcs"]], ["corp-dc1"])

    def test_dc_list_primary_uses_configured_topology(self):
        self.fake.lab_up()
        self._no_extra_domains()
        rc, out = self.call_main(["dc-list"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(out["dcs"]), mod.PRIMARY_LAB["DC_COUNT"])

    def test_dc_list_primary_includes_promoted_dc6(self):
        # Regression [6]: a primary DC promoted beyond DC_COUNT must not be
        # invisible, and only real primary DCs (^dc\d+$) count — not the CA node,
        # clients, or another forest's <slug>-dcN containers.
        self.fake.lab_up()
        self._no_extra_domains()
        self.fake.on(lambda a: a[:3] == ["podman", "ps", "-a"] and a[-1] == "{{.Names}}",
                     out="dc1\ndc2\ndc3\ndc4\ndc5\ndc6\nclient1\nadlab-ca\nad2-dc1\n")
        rc, out = self.call_main(["dc-list"])
        self.assertEqual(rc, 0, out)
        names = [d["dc"] for d in out["dcs"]]
        self.assertIn("dc6", names)
        self.assertEqual(names, ["dc1", "dc2", "dc3", "dc4", "dc5", "dc6"])

    def test_domain_remove_refuses_primary(self):
        self.fake.lab_up()
        self._no_extra_domains()
        rc, out = self.call_main(["domain-remove", "--realm", mod.PRIMARY_LAB["REALM"]])
        self.assertEqual(rc, 1)
        self.assertIn("primary", out["error"])

    def test_domain_remove_destroys_forest(self):
        self.fake.lab_up()
        self._one_extra_domain(dcs=("corp-dc1", "corp-dc2"))
        self.fake.on(lambda a: a[:3] == ["podman", "rm", "-f"], out="")
        self.fake.on(lambda a: a[:3] == ["podman", "network", "rm"], out="")
        rc, out = self.call_main(["domain-remove", "--realm", "CORP.EXAMPLE.LAB"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(set(out["removed_dcs"]), {"corp-dc1", "corp-dc2"})
        self.assertEqual(out["network_removed"], "adlab-corp")
        self.assertNotIn("backup", out)
        self.assertTrue(self.fake.argv_containing("podman", "rm", "-f", "corp-dc1"))
        self.assertTrue(self.fake.argv_containing("podman", "network", "rm", "adlab-corp"))

    def test_password_args_never_travel_on_argv(self):
        for name, spec_ in mod.VERBS.items():
            for a in spec_.get("args", []):
                if "password" in a["name"]:
                    self.assertEqual(a["type"], "password-stdin",
                                     "%s.%s" % (name, a["name"]))

    def test_schema_verb_dumps_the_whole_table(self):
        rc, out = self.call_main(["schema"])
        self.assertEqual(rc, 0)
        self.assertEqual(set(out["verbs"]), set(mod.VERBS))
        for name, v in out["verbs"].items():
            self.assertIn("help", v)
            self.assertIn("group", v)
            self.assertIn("danger", v)
            json.dumps(v)   # everything serializable

    def test_version_verb(self):
        rc, out = self.call_main(["version"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["realm"], mod.LAB["REALM"])

    def test_config_verb_reports_resolved_paths(self):
        # config is a meta verb; README.md and .envdefault point operators at it,
        # so it must be computed (never go stale). It reports which .env was read,
        # how it was found, and every resolved path with whether it exists.
        rc, out = self.call_main(["config"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["version"], mod.VERSION)
        self.assertEqual(out["env_file"], mod.ENV_FILE)
        self.assertEqual(out["env_file_source"], "env:ADLAB_ENV")  # tests use the 4.3 override
        self.assertEqual(out["install_conf"], mod.INSTALL_CONF)
        for key in ("lab_env", "rdp_env", "sysvol_replicate", "secret_dir",
                    "admin_pass_file", "gpo_template_dir", "audit_log"):
            self.assertIn(key, out["paths"])
            self.assertIn("exists", out["paths"][key])
        # the credential file is joined onto ADLAB_SECRET_DIR, never lab.env's literal
        apf = out["paths"]["admin_pass_file"]["path"]
        self.assertTrue(apf.endswith("/administrator.pass"))
        self.assertNotIn("$", apf)

    def test_lab_verb_fails_loudly_without_config(self):
        # DEPLOY-CONTRACT 4.3 step 3: with no resolved .env a LAB verb fails,
        # naming install.conf, while meta verbs stay usable for diagnosis.
        old_ef, old_le = mod.ENV_FILE, mod.LAB_ENV
        mod.ENV_FILE, mod.LAB_ENV = None, ""
        try:
            rc, out = self.call_main(["status"])
            self.assertEqual(rc, 1)
            self.assertIn("install.conf", out["error"])
            rc2, _ = self.call_main(["config"])   # meta verb unaffected
            self.assertEqual(rc2, 0)
        finally:
            mod.ENV_FILE, mod.LAB_ENV = old_ef, old_le


# ---------------------------------------------------------------------------
# 2. argument parsing / validation
# ---------------------------------------------------------------------------

class TestParseArgs(Base):
    SPEC = {"args": [mod.arg("name"), mod.arg("lines", "int", required=False,
                                              default=80),
                     mod.arg("dc", "enum", required=False,
                             choices=["dc1", "dc2"]),
                     mod.arg("password", "password-stdin")]}

    def test_happy_path_with_default(self):
        got = mod.parse_args(self.SPEC, ["--name", "alice"])
        self.assertEqual(got, {"name": "alice", "lines": 80})

    def test_int_coercion_and_enum(self):
        got = mod.parse_args(self.SPEC, ["--name", "x", "--lines", "5",
                                         "--dc", "dc2"])
        self.assertEqual(got["lines"], 5)
        self.assertEqual(got["dc"], "dc2")

    def test_missing_required(self):
        with self.assertRaisesRegex(mod.Fail, "missing required --name"):
            mod.parse_args(self.SPEC, [])

    def test_bad_int(self):
        with self.assertRaisesRegex(mod.Fail, "--lines must be an integer"):
            mod.parse_args(self.SPEC, ["--name", "x", "--lines", "many"])

    def test_bad_enum(self):
        with self.assertRaisesRegex(mod.Fail, "--dc must be one of"):
            mod.parse_args(self.SPEC, ["--name", "x", "--dc", "dc9"])

    def test_unknown_argument_rejected(self):
        with self.assertRaisesRegex(mod.Fail, "unknown argument"):
            mod.parse_args(self.SPEC, ["--name", "x", "--nope", "1"])

    def test_password_never_accepted_on_argv(self):
        with self.assertRaisesRegex(mod.Fail, "unknown argument"):
            mod.parse_args(self.SPEC, ["--name", "x", "--password", "pw"])

    def test_dangling_flag(self):
        with self.assertRaisesRegex(mod.Fail, "missing value"):
            mod.parse_args(self.SPEC, ["--name"])


# ---------------------------------------------------------------------------
# 3. parsers against fixtures
# ---------------------------------------------------------------------------

class TestParsers(Base):
    def test_fsmo(self):
        roles = mod.parse_fsmo(FSMO_OUT)
        self.assertEqual(len(roles), 7)
        self.assertEqual(roles["PdcEmulationMasterRole"], "dc1")
        self.assertEqual(roles["ForestDnsZonesMasterRole"], "dc5")

    def test_showrepl_healthy(self):
        rep = mod.parse_showrepl(SHOWREPL_HEALTHY)
        self.assertEqual(len(rep["neighbors"]), 2)
        self.assertTrue(all(n["ok"] for n in rep["neighbors"]))
        dirs = {n["direction"] for n in rep["neighbors"]}
        self.assertEqual(dirs, {"inbound", "outbound"})
        self.assertIn("DC2", rep["neighbors"][0]["partner"])

    def test_showrepl_broken(self):
        rep = mod.parse_showrepl(SHOWREPL_BROKEN)
        bad = [n for n in rep["neighbors"] if not n["ok"]]
        self.assertEqual(len(bad), 1)
        self.assertEqual(bad[0]["consecutive_failures"], 7)

    def test_ldif(self):
        ents = mod.parse_ldif_entries(USER_SHOW)
        self.assertEqual(len(ents), 1)
        self.assertEqual(ents[0]["sAMAccountName"], ["alice"])
        self.assertEqual(len(ents[0]["memberOf"]), 2)

    def test_gpo_listall(self):
        gpos = mod.parse_gpo_listall(GPO_LISTALL)
        self.assertEqual(len(gpos), 2)
        self.assertEqual(gpos[0]["display_name"], "Default Domain Policy")
        self.assertTrue(gpos[1]["gpo"].startswith("{6AC1786C"))

    def test_dns_zonelist(self):
        self.assertEqual(mod.parse_dns_zonelist(DNS_ZONELIST),
                         ["_msdcs.ad.edt1.lab", "ad.edt1.lab"])

    def test_dns_query(self):
        recs = mod.parse_dns_query(DNS_QUERY)
        a = [r for r in recs if r["type"] == "A"]
        self.assertEqual(len(a), 2)
        self.assertEqual(a[0], {"name": "dc1", "type": "A",
                                "data": "172.15.4.10", "ttl": 900})
        ns = [r for r in recs if r["type"] == "NS"]
        self.assertEqual(ns[0]["name"], "@")

    def test_processes(self):
        procs = mod.parse_processes(PROCESSES)
        self.assertIn({"service": "kdc_server", "pid": 88}, procs)
        self.assertEqual(len(procs), 5)

    def test_domain_info(self):
        info = mod.parse_domain_info(DOMAIN_INFO)
        self.assertEqual(info["netbios_domain"], "EDT1LAB")
        self.assertEqual(info["dc_name"], "dc1.ad.edt1.lab")

    def test_name_list(self):
        self.assertEqual(mod.parse_name_list("b\n\na\n"), ["a", "b"])


# ---------------------------------------------------------------------------
# 4. handlers: command construction, targeting, secrets, errors
# ---------------------------------------------------------------------------

class TestHandlers(Base):
    def test_fsmo_show(self):
        self.fake.lab_up()
        rc, out = self.call_main(["fsmo-show"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["roles"]["PdcEmulationMasterRole"], "dc1")

    def test_user_create_targets_pdc_and_keeps_password_off_argv(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "user" in a and "create" in a, out="User 'bob' added successfully\n")
        rc, out = self.call_main(["user-create", "--name", "bob"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["created"], "bob")
        self.assertTrue(out["password"])
        creates = self.fake.argv_containing("user create")
        self.assertEqual(len(creates), 1)
        argv, stdin = next((c for c in self.fake.calls if "create" in c[0]), (None, None))
        self.assertNotIn(out["password"], " ".join(argv))
        self.assertIn(out["password"], stdin or "")
        self.assertIn("dc1", argv)   # the PDC emulator

    def test_user_setpassword_reads_stdin(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "setpassword" in a, out="Changed password OK\n")
        rc, out = self.call_main(["user-setpassword", "--name", "bob"],
                                 stdin="S3cret-pw!\n")
        self.assertEqual(rc, 0)
        _, stdin = next(c for c in self.fake.calls if "setpassword" in c[0])
        self.assertIn("S3cret-pw!", stdin)

    def test_user_setpassword_requires_stdin(self):
        self.fake.lab_up()
        rc, out = self.call_main(["user-setpassword", "--name", "bob"], stdin="")
        self.assertEqual(rc, 1)
        self.assertIn("stdin", out["error"])

    def test_gpo_create_goes_to_pdc_with_authfile(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo create" in str(x) for x in a),
                     out="GPO 'test' created as {AAAAAAAA-1111-2222-3333-444455556666}\n")
        rc, out = self.call_main(["gpo-create", "--name", "test", "--os", "Windows"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["on"], "dc1")
        self.assertTrue(out["gpo"].startswith("{AAAAAAAA"))
        self.assertEqual(out["os"], "Windows")
        # the OS scope is recorded, keyed by the created GUID (upper-cased)
        self.assertEqual(mod._declared_gpo_os(out["gpo"]), "Windows")
        argv = self.fake.argv_containing("gpo create")[0]
        joined = " ".join(argv)
        self.assertIn("/run/adminpass", joined)      # password read in-container
        # authfile is UNIQUE per invocation (mktemp) — no shared-path race —
        # and is cleaned up via the per-call variable, not a fixed path.
        self.assertIn("mktemp /run/adlab.auth.XXXXXX", joined)
        self.assertIn('rm -f "$af"', joined)
        self.assertNotIn("rm -f /run/adlab.auth ", joined)  # not the old fixed path
        self.assertNotIn(mod.LAB["ADMIN_PASS_FILE"], joined)

    def test_dns_add_targets_pdc(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("dns add" in str(x) for x in a),
                     out="Record added successfully\n")
        rc, out = self.call_main(["dns-add", "--zone", "ad.edt1.lab",
                                  "--name", "www", "--type", "A",
                                  "--data", "172.15.4.99"])
        self.assertEqual(rc, 0)
        argv = self.fake.argv_containing("dns add")[0]
        self.assertEqual(argv[2], "dc1")

    def test_dns_type_is_validated(self):
        rc, out = self.call_main(["dns-add", "--zone", "z", "--name", "n",
                                  "--type", "BOGUS", "--data", "d"])
        self.assertEqual(rc, 2)
        self.assertIn("--type must be one of", out["error"])

    def test_dc_demote_refuses_dc1(self):
        self.fake.lab_up()
        rc, out = self.call_main(["dc-demote", "--dc", "dc1"])
        self.assertEqual(rc, 1)
        self.assertIn("refusing", out["error"])

    def test_dc_promote_picks_next_free_slot(self):
        # dc1..dc5 exist; dc6 missing -> promote creates dc6 at .15
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"] and "dc6" in a,
                     rc=1, out="")
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"],
                     out="running\n")
        self.fake.on(lambda a: a[:2] == ["podman", "run"], out="abc123\n")
        rc, out = self.call_main(["dc-promote"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["promoting"], "dc6")
        self.assertEqual(out["ip"], "172.15.4.15")
        argv = self.fake.argv_containing("podman run")[0]
        self.assertIn("--ip", argv)
        self.assertIn("172.15.4.15", argv)
        self.assertIn("ROLE=join", " ".join(argv))

    def test_client_remove_validates_name(self):
        rc, out = self.call_main(["client-remove", "--name", "dc1"])
        self.assertEqual(rc, 1)
        self.assertIn("clientN", out["error"])

    def test_dc_debug_range(self):
        self.fake.lab_up()
        rc, out = self.call_main(["dc-debug", "--dc", "dc2", "--level", "99"])
        self.assertEqual(rc, 1)
        self.assertIn("0..10", out["error"])

    def test_dc_logs(self):
        self.fake.on(lambda a: a[:2] == ["podman", "logs"], out="line1\nline2\n")
        rc, out = self.call_main(["dc-logs", "--dc", "dc3"])
        self.assertEqual(rc, 0)
        self.assertIn("line2", out["log"])
        argv = self.fake.argv_containing("podman logs")[0]
        self.assertEqual(argv[argv.index("--tail") + 1], "80")   # default applied

    def test_health_rolls_up_broken_replication(self):
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], out="running\n")
        self.fake.on(lambda a: "showrepl" in a, out=SHOWREPL_BROKEN)
        rc, out = self.call_main(["health"])
        self.assertEqual(rc, 0)
        self.assertTrue(all(r["failures"] == 1 for r in out["dcs"]))

    def test_no_dc_running_is_a_clean_error(self):
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], out="exited\n")
        rc, out = self.call_main(["fsmo-show"])
        self.assertEqual(rc, 1)
        self.assertIn("no DC container is running", out["error"])

    def test_repl_status_single_dc(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "showrepl" in a, out=SHOWREPL_HEALTHY)
        rc, out = self.call_main(["repl-status", "--dc", "dc2"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(out["replication"]), 1)
        self.assertEqual(out["replication"][0]["dc"], "dc2")

    def test_sysvol_status_flags_divergence(self):
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], out="running\n")
        seq = iter(["aaaa\n", "5\n", "bbbb\n", "5\n", "aaaa\n", "5\n",
                    "aaaa\n", "5\n", "aaaa\n", "5\n"])
        self.fake.on(lambda a: "bash" in a, out="")  # placeholder, replaced below
        self.fake.rules[-1] = (lambda a: "bash" in a and "-c" in a,
                               None)  # dynamic below

        def dyn(argv, stdin=None, timeout=120):
            self.fake.calls.append((list(argv), stdin))
            if argv[:2] == ["podman", "inspect"]:
                return 0, "running\n", ""
            if argv[:2] == ["podman", "ps"]:
                return 0, "", ""   # all_dcs' primary-DC discovery — not part of the hash seq
            return 0, next(seq), ""
        mod.RUN = type("R", (), {"run": staticmethod(dyn)})()
        rc, out = self.call_main(["sysvol-status"])
        self.assertEqual(rc, 0)
        self.assertFalse(out["identical"])

    def test_dc_shell_returns_rc_and_both_streams(self):
        self.fake.on(lambda a: "bash" in a, rc=3, out="OUT", err="ERR")
        rc, out = self.call_main(["dc-shell", "--dc", "dc4",
                                  "--command", "false"])
        self.assertEqual(rc, 0)          # the verb succeeded; the command's rc is data
        self.assertEqual(out["rc"], 3)
        self.assertEqual(out["stdout"], "OUT")
        self.assertEqual(out["stderr"], "ERR")


# ---------------------------------------------------------------------------
# 5. main(): contract — JSON always, correct exit codes, audit hygiene
# ---------------------------------------------------------------------------

class TestMainContract(Base):
    def test_unknown_verb(self):
        rc, out = self.call_main(["frobnicate"])
        self.assertEqual(rc, 2)
        self.assertIn("unknown verb", out["error"])
        self.assertIn("status", out["verbs"])

    def test_no_verb_usage(self):
        rc, out = self.call_main([])
        self.assertEqual(rc, 2)
        self.assertIn("usage", out["error"])

    def test_arg_error_is_json_exit_2(self):
        rc, out = self.call_main(["user-show"])
        self.assertEqual(rc, 2)
        self.assertIn("missing required --name", out["error"])

    def test_internal_error_still_prints_json(self):
        self.fake.lab_up()
        orig = mod.VERBS["status"]["fn"]
        mod.VERBS["status"]["fn"] = lambda a: 1 / 0
        try:
            rc, out = self.call_main(["status"])
            self.assertEqual(rc, 3)
            self.assertIn("internal", out["error"])
        finally:
            mod.VERBS["status"]["fn"] = orig

    def test_audit_written_and_never_contains_passwords(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "user" in a and "create" in a, out="ok\n")
        rc, out = self.call_main(["user-create", "--name", "carol"])
        self.assertEqual(rc, 0)
        with open(mod.AUDIT_LOG) as f:
            log = f.read()
        self.assertIn("user-create", log)
        self.assertIn("carol", log)
        self.assertNotIn(out["password"], log)

    def test_every_readonly_verb_survives_a_dead_lab(self):
        """With nothing running, every no-arg verb must still return JSON
        (success or a clean error), never crash."""
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], rc=1, out="")
        for name, spec_ in mod.VERBS.items():
            if any(a.get("required") for a in spec_.get("args", [])):
                continue
            rc, out = self.call_main([name])
            self.assertIsInstance(out, dict, name)
            self.assertIn(rc, (0, 1, 2, 3), name)


# ---------------------------------------------------------------------------
# 6. Group Policy: PReg / ADMX parsers + the stacking verbs
# ---------------------------------------------------------------------------

import struct as _struct


def _u16(s):
    return s.encode("utf-16-le") + b"\x00\x00"


def _preg(entries):
    """Build a PReg blob from [(key,val,type_id,data_bytes)]."""
    blob = b"PReg" + _struct.pack("<I", 1)
    for key, val, tid, data in entries:
        blob += (b"[\x00" + _u16(key) + b";\x00" + _u16(val) + b";\x00"
                 + _struct.pack("<I", tid) + b";\x00"
                 + _struct.pack("<I", len(data)) + b";\x00" + data + b"]\x00")
    return blob


class TestPReg(Base):
    def test_roundtrip_types(self):
        blob = _preg([
            ("Software\\A", "Str", 1, "hello".encode("utf-16-le") + b"\x00\x00"),
            ("Software\\A", "Dw", 4, _struct.pack("<I", 7)),
            ("Software\\A", "Qw", 11, _struct.pack("<Q", 99)),
            ("Software\\A", "Multi", 7,
             "a\x00b\x00".encode("utf-16-le") + b"\x00\x00"),
        ])
        out = mod.parse_preg(blob)
        self.assertEqual(len(out), 4)
        self.assertEqual(out[0], {"keyname": "Software\\A", "valuename": "Str",
                                  "type": "REG_SZ", "data": "hello"})
        self.assertEqual(out[1]["data"], 7)
        self.assertEqual(out[1]["type"], "REG_DWORD")
        self.assertEqual(out[2]["data"], 99)
        self.assertEqual(out[3]["data"], ["a", "b"])

    def test_not_preg_returns_empty(self):
        self.assertEqual(mod.parse_preg(b"notpreg...."), [])
        self.assertEqual(mod.parse_preg(b""), [])

    def test_truncated_is_safe(self):
        blob = _preg([("K", "V", 4, _struct.pack("<I", 1))])[:-6]
        self.assertIsInstance(mod.parse_preg(blob), list)   # no exception


class TestAdmx(Base):
    ADMX = ('<policyDefinitions><policies>'
            '<policy name="Pbool" class="Machine" key="Software\\P" valueName="On">'
            '<enabledValue><decimal value="1"/></enabledValue>'
            '<disabledValue><decimal value="0"/></disabledValue></policy>'
            '<policy name="Pstr" class="User" key="Software\\Q" valueName="S">'
            '<enabledValue><string>yes</string></enabledValue></policy>'
            '<policy name="Pelem" class="Both" key="Software\\R">'
            '<elements><text id="t1" valueName="TextVal"/>'
            '<decimal id="d1" valueName="NumVal"/></elements></policy>'
            '</policies></policyDefinitions>')

    def test_enabled_disabled_values(self):
        pols = {p["id"]: p for p in mod.parse_admx(self.ADMX)}
        self.assertEqual(set(pols), {"Pbool", "Pstr", "Pelem"})
        self.assertEqual(pols["Pbool"]["enabled_type"], "REG_DWORD")
        self.assertEqual(pols["Pbool"]["enabled_data"], 1)
        self.assertEqual(pols["Pbool"]["disabled_data"], 0)
        self.assertEqual(pols["Pstr"]["enabled_type"], "REG_SZ")
        self.assertEqual(pols["Pstr"]["enabled_data"], "yes")

    def test_elements_typed(self):
        pols = {p["id"]: p for p in mod.parse_admx(self.ADMX)}
        el = pols["Pelem"]["elements"]
        kinds = {e["valuename"]: e["type"] for e in el}
        self.assertEqual(kinds["TextVal"], "REG_SZ")
        self.assertEqual(kinds["NumVal"], "REG_DWORD")

    def test_bad_xml_returns_empty(self):
        self.assertEqual(mod.parse_admx("<not xml"), [])


class TestAdml(Base):
    ADML = ('<policyDefinitionResources><resources><stringTable>'
            '<string id="POL_Foo">Disable Printing</string>'
            '<string id="POL_Bar">Whitelisted Accounts</string>'
            '</stringTable></resources></policyDefinitionResources>')

    def test_parse_adml_strings(self):
        t = mod.parse_adml(self.ADML)
        self.assertEqual(t["POL_Foo"], "Disable Printing")
        self.assertEqual(t["POL_Bar"], "Whitelisted Accounts")

    def test_resolve_ref(self):
        strings = mod.parse_adml(self.ADML)
        # a $(string.POL_Foo) displayName arrives as "string.POL_Foo"
        self.assertEqual(mod._resolve_ref("string.POL_Foo", strings), "Disable Printing")
        # unknown ref stays as-is (so the UI can flag it unresolved)
        self.assertEqual(mod._resolve_ref("string.POL_Missing", strings), "string.POL_Missing")
        # a literal name is untouched
        self.assertEqual(mod._resolve_ref("Already Text", strings), "Already Text")

    def test_bad_adml_returns_empty(self):
        self.assertEqual(mod.parse_adml("<broken"), {})


class TestGpoVerbs(Base):
    def _mock_sysvol_preg(self, machine_entries):
        """Make base64 reads of Machine/registry.pol return machine_entries."""
        blob = _preg(machine_entries)
        b64 = _b64(blob)
        # the helper runs bash -c 'find .../Machine ... base64 -w0 ...'
        self.fake.on(lambda a: "bash" in a and any("/Machine" in str(x) for x in a),
                     out=b64)
        self.fake.on(lambda a: "bash" in a and any("/User" in str(x) for x in a),
                     out="")

    def test_settings_apply_builds_gpo_load_with_stdin(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="Success\n")
        entries = ('[{"keyname":"Software\\\\P","valuename":"On",'
                   '"class":"MACHINE","type":"REG_DWORD","data":1}]')
        rc, out = self.call_main(["gpo-settings-apply",
                                  "--gpo", "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--entries", entries])
        self.assertEqual(rc, 0)
        self.assertEqual(out["applied"], 1)
        # command targets the PDC (dc1) and passes the registry CSE + JSON stdin
        argv, stdin = next(c for c in self.fake.calls
                           if any("gpo load" in str(x) for x in c[0]))
        self.assertIn("dc1", argv)
        self.assertIn("35378EAC", " ".join(argv))
        self.assertIn('"valuename": "On"', stdin)

    def test_settings_apply_rejects_bad_class(self):
        self.fake.lab_up()
        entries = '[{"keyname":"K","valuename":"V","class":"NOPE","type":"REG_SZ","data":"x"}]'
        rc, out = self.call_main(["gpo-settings-apply", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--entries", entries])
        self.assertEqual(rc, 1)
        self.assertIn("MACHINE|USER|BOTH", out["error"])

    def test_settings_apply_rejects_bad_guid(self):
        self.fake.lab_up()
        rc, out = self.call_main(["gpo-settings-apply", "--gpo", "not-a-guid",
                                  "--entries", "[]"])
        self.assertEqual(rc, 1)
        self.assertIn("GUID", out["error"])

    def test_registry_list_parses_sysvol(self):
        self.fake.lab_up()
        self._mock_sysvol_preg([("Software\\P", "On", 4, _struct.pack("<I", 1))])
        rc, out = self.call_main(["gpo-registry-list", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(out["settings"]), 1)
        self.assertEqual(out["settings"][0]["class"], "MACHINE")
        self.assertEqual(out["settings"][0]["data"], 1)

    def test_template_stack_merges_sources(self):
        self.fake.lab_up()
        self._mock_sysvol_preg([("Software\\P", "On", 4, _struct.pack("<I", 1))])
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="ok\n")
        rc, out = self.call_main(["gpo-template-stack",
                                  "--target", "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--sources", "{6AC1786C-016F-11D2-945F-00C04FB984F9}"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["applied"], 1)
        self.assertEqual(out["layers"][0]["settings"], 1)

    def test_pref_set_builds_manage_command(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo manage smb_conf set" in str(x) for x in a),
                     out="")
        rc, out = self.call_main(["gpo-pref-set", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--cse", "smb_conf", "--entry", "apply group policies",
                                  "--value", "yes"])
        self.assertEqual(rc, 0)
        argv = next(c[0] for c in self.fake.calls
                    if any("gpo manage smb_conf set" in str(x) for x in c[0]))
        joined = " ".join(argv)
        self.assertIn("apply group policies", joined)
        self.assertIn("yes", joined)

    def test_pref_set_rejects_unknown_cse(self):
        self.fake.lab_up()
        rc, out = self.call_main(["gpo-pref-set", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--cse", "bogus"])
        self.assertEqual(rc, 2)   # enum validation at parse time
        self.assertIn("--cse must be one of", out["error"])

    def test_admxload_reports_central_store(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo admxload" in str(x) for x in a), out="done\n")
        self.fake.on(lambda a: "bash" in a and any("PolicyDefinitions" in str(x) for x in a),
                     out="samba.admx GNOME_Settings.admx\n")
        rc, out = self.call_main(["gpo-admxload"])
        self.assertEqual(rc, 0)
        self.assertTrue(out["loaded"])
        self.assertIn("samba.admx", out["central_store"])


import base64 as _base64
def _b64(blob):
    return _base64.b64encode(blob).decode()


class TestCrypto(Base):
    """Crypto control plane: schema catalog, per-account/bulk Kerberos etypes,
    and server crypto settings."""
    def test_etype_presets(self):
        self.assertEqual(mod.CRYPTO_ETYPE_PRESETS["aes-only"], 0x18)
        self.assertEqual(mod.CRYPTO_ETYPE_PRESETS["rc4-only"], 0x4)
        self.assertIsNone(mod.CRYPTO_ETYPE_PRESETS["clear"])

    def test_account_etypes_get(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=(
            "dn: CN=svc,CN=Users,DC=ad,DC=edt1,DC=lab\nsAMAccountName: svc\n"
            "msDS-SupportedEncryptionTypes: 24\n\n"))
        rc, out = self.call_main(["crypto-account-etypes", "--account", "svc"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["supported_etypes_value"], 24)
        self.assertTrue(out["aes_only"]); self.assertFalse(out["rc4_allowed"])

    def test_account_etypes_set_replaces(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=(
            "dn: CN=svc,CN=Users,DC=ad,DC=edt1,DC=lab\nsAMAccountName: svc\n"
            "msDS-SupportedEncryptionTypes: 24\n\n"))
        self.fake.on(lambda a: "ldbmodify" in a, out="Modified 1")
        rc, out = self.call_main(["crypto-account-etypes", "--account", "svc", "--set", "aes-only"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["set"], "aes-only")
        mc = next(c for c in self.fake.calls if "ldbmodify" in c[0])
        self.assertIn("replace: msDS-SupportedEncryptionTypes", mc[1])
        self.assertIn("msDS-SupportedEncryptionTypes: 24", mc[1])   # 0x18

    def test_account_etypes_clear_deletes(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=(
            "dn: CN=svc,CN=Users,DC=ad,DC=edt1,DC=lab\nsAMAccountName: svc\n\n"))
        self.fake.on(lambda a: "ldbmodify" in a, out="ok")
        rc, out = self.call_main(["crypto-account-etypes", "--account", "svc", "--set", "clear"])
        self.assertEqual(rc, 0, out)
        mc = next(c for c in self.fake.calls if "ldbmodify" in c[0])
        self.assertIn("delete: msDS-SupportedEncryptionTypes", mc[1])

    def test_harden_dryrun_excludes_krbtgt_and_compliant(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=(
            "dn: CN=a,DC=x\nsAMAccountName: a\nmsDS-SupportedEncryptionTypes: 0\n\n"
            "dn: CN=krbtgt,DC=x\nsAMAccountName: krbtgt\nmsDS-SupportedEncryptionTypes: 0\n\n"
            "dn: CN=b,DC=x\nsAMAccountName: b\nmsDS-SupportedEncryptionTypes: 24\n\n"))
        rc, out = self.call_main(["crypto-harden", "--scope", "spn-users"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["commit"])
        self.assertEqual(out["would_change"], 1)          # only 'a' (0 != 24)
        self.assertEqual(out["applied"], 0)
        self.assertEqual(out["changes"][0]["account"], "a")

    def test_harden_commit_applies(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=(
            "dn: CN=a,DC=x\nsAMAccountName: a\nmsDS-SupportedEncryptionTypes: 0\n\n"))
        self.fake.on(lambda a: "ldbmodify" in a, out="ok")
        rc, out = self.call_main(["crypto-harden", "--scope", "spn-users", "--commit", "true"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["commit"]); self.assertEqual(out["applied"], 1)

    def test_crypto_set_writes_and_reloads(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "python3" in a, out="")
        self.fake.on(lambda a: "smbcontrol" in a and "reload-config" in a, out="")
        self.fake.on(lambda a: "bash" in a and any("testparm" in str(x) for x in a),
                     out="\tkerberos encryption types = strong\n")
        rc, out = self.call_main(["crypto-set", "--id", "kerberos-encryption-types", "--value", "strong"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["effective"], "strong")
        pc = next(c for c in self.fake.calls if "python3" in c[0])
        self.assertIn("kerberos encryption types", " ".join(map(str, pc[0])))

    def test_crypto_set_rejects_bad_value(self):
        self.fake.lab_up()
        rc, out = self.call_main(["crypto-set", "--id", "ntlm-auth", "--value", "bogus"])
        self.assertEqual(rc, 1)
        self.assertIn("must be one of", out["error"])

    def test_crypto_set_rejects_unknown_id(self):
        self.fake.lab_up()
        rc, out = self.call_main(["crypto-set", "--id", "nope", "--value", "x"])
        self.assertEqual(rc, 1)
        self.assertIn("unknown crypto setting", out["error"])

    def test_catalog_server_and_accounts(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "bash" in a and any("testparm" in str(x) for x in a), out=(
            "\tkerberos encryption types = all\n\tntlm auth = ntlmv2-only\n"
            "\tserver smb encrypt = default\n"))
        self.fake.on(lambda a: "ldbsearch" in a, out=(
            "dn: CN=a,DC=x\nsAMAccountName: a\nobjectClass: user\n"
            "servicePrincipalName: HTTP/a\nmsDS-SupportedEncryptionTypes: 0\n\n"
            "dn: CN=b,DC=x\nsAMAccountName: b\nobjectClass: user\n"
            "msDS-SupportedEncryptionTypes: 24\n\n"))
        rc, out = self.call_main(["crypto-catalog"])
        self.assertEqual(rc, 0, out)
        ids = {s["id"]: s for s in out["server"]}
        self.assertEqual(ids["kerberos-encryption-types"]["value"], "all")
        self.assertFalse(ids["kerberos-encryption-types"]["compliant"])   # all != strong
        self.assertTrue(ids["ntlm-auth"]["compliant"])                    # ntlmv2-only
        self.assertEqual(out["kerberos_accounts"]["total"], 2)
        self.assertEqual(out["kerberos_accounts"]["rc4_allowed"], 1)      # a (unset)
        self.assertEqual(out["kerberos_accounts"]["aes_only"], 1)         # b
        self.assertEqual(out["kerberos_accounts"]["rc4_spn_users"], 1)    # a: spn user, rc4


class TestKerberos(Base):
    """Kerberos ticket anomaly detection: KDC-audit parse, RC4 downgrade + bulk
    TGS, and static roast exposure."""
    def _tgs(self, client, spn, etype="18/18", etypes="18,17", auth=None):
        import time as _t
        auth = auth if auth is not None else int(_t.time())
        return ("  Kerberos: TGS-REQ SUCCESS ipv4:10.0.0.9:5 %s %s etype=%s "
                "pac_attributes=2 canon_client_name=%s end=1 auth=%d etypes=%s "
                "renew=1 elapsed=0.001 flags=canonicalize start=1 armor_client_name=%s"
                % (client, spn, etype, client, auth, etypes, client))

    def _grep_tgs(self, blob):
        self.fake.on(lambda a: "bash" in a and any("TGS-REQ SUCCESS" in str(x) for x in a),
                     out=blob)

    # -- pure parsers ------------------------------------------------------
    def test_parse_tgs_requested_rc4_issued_aes(self):
        rec = mod._parse_tgs_success(
            "  Kerberos: TGS-REQ SUCCESS ipv4:127.0.0.1:35242 krbu@AD.EDT1.LAB "
            "HOST/dc1.ad.edt1.lab@AD.EDT1.LAB etype=18/18 pac_attributes=2 "
            "canon_client_name=krbu@AD.EDT1.LAB end=1 auth=1789865502 etypes=23 "
            "renew=1 elapsed=0.004 flags=canonicalize start=1 armor_client_name=x")
        self.assertEqual(rec["client"], "krbu@AD.EDT1.LAB")
        self.assertEqual(rec["spn"], "HOST/dc1.ad.edt1.lab@AD.EDT1.LAB")
        self.assertEqual(rec["ip"], "ipv4:127.0.0.1:35242")
        self.assertEqual(rec["issued_etype"], 18)
        self.assertEqual(rec["requested_etypes"], [23])
        self.assertTrue(rec["rc4_requested"])       # asked for RC4 (downgrade)
        self.assertFalse(rec["rc4_issued"])         # KDC still gave AES
        self.assertEqual(rec["auth"], 1789865502)

    def test_parse_tgs_issued_rc4(self):
        rec = mod._parse_tgs_success(
            "Kerberos: TGS-REQ SUCCESS ipv4:1.2.3.4:5 svc@R MSSQLSvc/db@R "
            "etype=23/23 auth=1 etypes=23")
        self.assertTrue(rec["rc4_issued"])
        self.assertEqual(rec["issued_etype_name"], "rc4-hmac")

    def test_parse_non_tgs_is_none(self):
        self.assertIsNone(mod._parse_tgs_success("Kerberos: AS-REQ a from b for krbtgt"))

    def test_decode_supp_etypes(self):
        _, rc4, aes_only, _ = mod._decode_supp_etypes("0")     # unset -> legacy RC4
        self.assertTrue(rc4); self.assertFalse(aes_only)
        names, rc4, aes_only, _ = mod._decode_supp_etypes(str(0x18))   # AES128+256 only
        self.assertFalse(rc4); self.assertTrue(aes_only); self.assertIn("AES256-SHA1", names)
        _, rc4, aes_only, _ = mod._decode_supp_etypes(str(0x1C))       # RC4+AES
        self.assertTrue(rc4); self.assertFalse(aes_only)
        _, rc4, aes_only, _ = mod._decode_supp_etypes(str(0x4))        # RC4 only
        self.assertTrue(rc4); self.assertFalse(aes_only)

    # -- anomalies ---------------------------------------------------------
    def test_anomalies_flags_rc4_and_bulk(self):
        self.fake.lab_up()
        lines = [self._tgs("attacker@AD.EDT1.LAB", "svc%d/h@AD.EDT1.LAB" % i, etypes="23")
                 for i in range(7)]
        lines.append(self._tgs("alice@AD.EDT1.LAB", "HOST/dc1@AD.EDT1.LAB", etypes="18,17"))
        self._grep_tgs("\n".join(lines))
        rc, out = self.call_main(["kerberos-anomalies", "--dc", "dc1",
                                  "--window", "60", "--distinct_spn_threshold", "5"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["rc4_count"], 7)
        self.assertEqual(out["bulk_count"], 1)
        self.assertEqual(out["bulk_tgs"][0]["client"], "attacker@AD.EDT1.LAB")
        self.assertEqual(out["bulk_tgs"][0]["distinct_spns"], 7)
        self.assertTrue(out["bulk_tgs"][0]["rc4_any"])

    def test_anomalies_window_excludes_old(self):
        import time as _t
        self.fake.lab_up()
        self._grep_tgs(self._tgs("x@R", "svc/h@R", etypes="23", auth=int(_t.time()) - 3600 * 5))
        rc, out = self.call_main(["kerberos-anomalies", "--dc", "dc1", "--window", "60"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["considered"], 0)
        self.assertEqual(out["rc4_count"], 0)

    def test_ticket_requests_parses(self):
        self.fake.lab_up()
        self._grep_tgs(self._tgs("alice@R", "HTTP/web@R", etypes="18") + "\n" +
                       self._tgs("bob@R", "CIFS/fs@R", etypes="23"))
        rc, out = self.call_main(["kerberos-ticket-requests", "--dc", "dc1"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["count"], 2)
        self.assertIn("bob@R", [r["client"] for r in out["requests"]])

    # -- static exposure ---------------------------------------------------
    def test_roast_exposure_classifies(self):
        self.fake.lab_up()
        ldif = ("dn: CN=svc1,CN=Users,DC=ad,DC=edt1,DC=lab\n"
                "sAMAccountName: svc1\nobjectClass: user\n"
                "servicePrincipalName: MSSQLSvc/db@R\n\n"
                "dn: CN=svc2,CN=Users,DC=ad,DC=edt1,DC=lab\n"
                "sAMAccountName: svc2\nobjectClass: user\n"
                "servicePrincipalName: HTTP/web@R\n"
                "msDS-SupportedEncryptionTypes: 24\n\n")   # 0x18 = AES only
        self.fake.on(lambda a: "ldbsearch" in a, out=ldif)
        rc, out = self.call_main(["kerberos-roast-exposure"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["total"], 2)
        by = {x["account"]: x for x in out["accounts"]}
        self.assertTrue(by["svc1"]["rc4_allowed"])     # unset -> roastable
        self.assertFalse(by["svc2"]["rc4_allowed"])    # AES-only
        self.assertTrue(by["svc2"]["aes_only"])
        self.assertEqual(out["roastable"], 1)

    # -- audit enable/status ----------------------------------------------
    def test_audit_status_reports_level(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "bash" in a and any(":88 " in str(x) for x in a), out="31\n36\n")
        self.fake.on(lambda a: "smbcontrol" in a and "debuglevel" in a,
                     out="PID 31: all:1 kerberos:3 kdc:1")
        self.fake.on(lambda a: "bash" in a and any("grep -ac 'TGS-REQ SUCCESS'" in str(x) for x in a),
                     out="5\n")
        rc, out = self.call_main(["kerberos-audit-status", "--dc", "dc1"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["dcs"][0]["audit_active"])
        self.assertEqual(out["dcs"][0]["kerberos_level"], 3)
        self.assertEqual(out["dcs"][0]["tgs_records"], 5)

    def test_audit_status_zero_records_no_crash(self):
        # regression: grep -c prints "0" on no matches; a stray double line
        # ("0\n0") must not make int() throw — take the first number.
        self.fake.lab_up()
        self.fake.on(lambda a: "bash" in a and any(":88 " in str(x) for x in a), out="31\n")
        self.fake.on(lambda a: "smbcontrol" in a and "debuglevel" in a, out="PID 31: kerberos:1")
        self.fake.on(lambda a: "bash" in a and any("grep -ac 'TGS-REQ SUCCESS'" in str(x) for x in a),
                     out="0\n0")
        rc, out = self.call_main(["kerberos-audit-status", "--dc", "dc1"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["dcs"][0]["tgs_records"], 0)

    def test_audit_enable_smbcontrols_workers(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "bash" in a and any(":88 " in str(x) for x in a), out="31\n36\n")
        self.fake.on(lambda a: "smbcontrol" in a and "debug" in a, out="")
        rc, out = self.call_main(["kerberos-audit-enable", "--dc", "dc1"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["enabled_on"][0]["set_ok"], 2)
        self.assertTrue(any("kerberos:3" in " ".join(map(str, c[0]))
                            for c in self.fake.calls if "smbcontrol" in c[0]))


class TestSpn(Base):
    """setspn-compatible SPN verbs: list / list-all / add / delete / query /
    find-duplicates."""
    ONE = ("dn: CN=web01,CN=Computers,DC=ad,DC=edt1,DC=lab\n"
           "sAMAccountName: WEB01$\n"
           "objectClass: computer\n"
           "servicePrincipalName: HTTP/web01.ad.edt1.lab\n"
           "servicePrincipalName: HOST/web01\n\n")
    TWO = (ONE +
           "dn: CN=svc-sql,CN=Users,DC=ad,DC=edt1,DC=lab\n"
           "sAMAccountName: svc-sql\n"
           "objectClass: user\n"
           "servicePrincipalName: MSSQLSvc/db01.ad.edt1.lab:1433\n\n")
    # same SPN (HTTP/dup) on two accounts -> a duplicate
    DUP = ("dn: CN=a,CN=Computers,DC=ad,DC=edt1,DC=lab\n"
           "sAMAccountName: A$\nobjectClass: computer\n"
           "servicePrincipalName: HTTP/dup.ad.edt1.lab\n"
           "servicePrincipalName: HOST/a\n\n"
           "dn: CN=b,CN=Computers,DC=ad,DC=edt1,DC=lab\n"
           "sAMAccountName: B$\nobjectClass: computer\n"
           "servicePrincipalName: HTTP/dup.ad.edt1.lab\n\n")

    # -- units -------------------------------------------------------------
    def test_valid_spn(self):
        self.assertEqual(mod._valid_spn(" HTTP/web01 "), "HTTP/web01")
        for bad in ("", "noSlash", "has space/x"):
            with self.assertRaises(mod.Fail):
                mod._valid_spn(bad)

    # -- setspn -L ---------------------------------------------------------
    def test_spn_list_returns_sorted_spns(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=self.ONE)
        rc, out = self.call_main(["spn-list", "--account", "web01"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["account"], "WEB01$")
        self.assertEqual(out["spns"], ["HOST/web01", "HTTP/web01.ad.edt1.lab"])

    def test_spn_list_unknown_account(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out="")
        rc, out = self.call_main(["spn-list", "--account", "ghost"])
        self.assertEqual(rc, 1)
        self.assertIn("no user or computer account", out["error"])

    # -- list-all ----------------------------------------------------------
    def test_spn_list_all_groups_and_counts(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=self.TWO)
        rc, out = self.call_main(["spn-list-all"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["account_count"], 2)
        self.assertEqual(out["spn_count"], 3)
        by = {r["account"]: r for r in out["accounts"]}
        self.assertEqual(by["WEB01$"]["class"], "computer")
        self.assertEqual(by["svc-sql"]["class"], "user")

    # -- setspn -S / -A ----------------------------------------------------
    def test_spn_add_targets_pdc_dup_checked(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "spn" in a and "add" in a, out="")
        rc, out = self.call_main(["spn-add", "--account", "WEB01$",
                                  "--spn", "HTTP/web01.ad.edt1.lab"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["forced"])
        argv = next(c[0] for c in self.fake.calls if "add" in c[0] and "spn" in c[0])
        self.assertIn("dc1", argv)                      # PDC emulator
        self.assertEqual(argv[-3:], ["add", "HTTP/web01.ad.edt1.lab", "WEB01$"])
        self.assertNotIn("--force", argv)

    def test_spn_add_force_uses_ldbmodify(self):
        # samba-tool spn add has NO --force, so the -A path writes the value
        # directly with ldbmodify (bypassing the uniqueness check).
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=self.ONE)       # account resolves
        self.fake.on(lambda a: "ldbmodify" in a, out="Modified 1 record")
        rc, out = self.call_main(["spn-add", "--account", "WEB01$",
                                  "--spn", "HTTP/web01.new", "--force", "true"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["forced"])
        self.assertEqual([c for c in self.fake.calls
                          if "add" in c[0] and "spn" in c[0]], [])   # NOT samba-tool spn add
        mod_call = next(c for c in self.fake.calls if "ldbmodify" in c[0])
        self.assertIn("add: servicePrincipalName", mod_call[1])       # stdin LDIF
        self.assertIn("servicePrincipalName: HTTP/web01.new", mod_call[1])
        self.assertIn("CN=web01", mod_call[1])                        # the resolved DN

    def test_spn_add_force_surfaces_uniqueness_error(self):
        # samba's samldb enforces SPN uniqueness even for a direct ldbmodify, so
        # --force cannot create a duplicate; the constraint error must surface.
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=self.ONE)
        self.fake.on(lambda a: "ldbmodify" in a, rc=1,
                     err="samldb_spn_uniqueness_check: failed direct uniqueness "
                         "check\nERR: (Constraint violation)")
        rc, out = self.call_main(["spn-add", "--account", "WEB01$",
                                  "--spn", "HTTP/dup.ad.edt1.lab", "--force", "true"])
        self.assertEqual(rc, 1)
        self.assertIn("uniqueness", out["error"].lower())

    def test_spn_list_unfolds_long_spn(self):
        # ldbsearch folds values >79 chars onto continuation lines (leading
        # space); parse_ldif_full must UNFOLD them (parse_ldif_entries truncated).
        folded = ("dn: CN=DC1,OU=Domain Controllers,DC=ad,DC=edt1,DC=lab\n"
                  "sAMAccountName: DC1$\n"
                  "objectClass: computer\n"
                  "servicePrincipalName: E3514235-4B06-11D1-AB04-00C04FC2DCD2/"
                  "7f750fb1-21cf-4eaa-\n"
                  " bb60-bd681bea50dd/ad.edt1.lab\n\n")
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=folded)
        rc, out = self.call_main(["spn-list", "--account", "DC1$"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["spns"], ["E3514235-4B06-11D1-AB04-00C04FC2DCD2/"
                                       "7f750fb1-21cf-4eaa-bb60-bd681bea50dd/ad.edt1.lab"])

    def test_spn_add_rejects_bad_spn(self):
        self.fake.lab_up()
        rc, out = self.call_main(["spn-add", "--account", "x", "--spn", "noslash"])
        self.assertEqual(rc, 1)
        self.assertIn("SPN must look like", out["error"])

    # -- setspn -D ---------------------------------------------------------
    def test_spn_delete_builds_command(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "spn" in a and "delete" in a, out="")
        rc, out = self.call_main(["spn-delete", "--account", "WEB01$",
                                  "--spn", "HOST/web01"])
        self.assertEqual(rc, 0, out)
        argv = next(c[0] for c in self.fake.calls if "delete" in c[0] and "spn" in c[0])
        self.assertIn("dc1", argv)
        self.assertEqual(argv[-3:], ["delete", "HOST/web01", "WEB01$"])

    # -- setspn -Q ---------------------------------------------------------
    def test_spn_query_finds_and_flags_duplicate(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=self.DUP)
        rc, out = self.call_main(["spn-query", "--spn", "HTTP/dup.ad.edt1.lab"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["count"], 2)
        self.assertTrue(out["duplicate"])
        # the queried SPN is escaped into the ldbsearch filter
        argv = next(c[0] for c in self.fake.calls if "ldbsearch" in c[0])
        self.assertTrue(any("servicePrincipalName=HTTP/dup.ad.edt1.lab" in x for x in argv))

    # -- setspn -X ---------------------------------------------------------
    def test_spn_find_duplicates(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=self.DUP)
        rc, out = self.call_main(["spn-find-duplicates"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["count"], 1)
        d = out["duplicates"][0]
        self.assertEqual(d["spn"], "HTTP/dup.ad.edt1.lab")
        self.assertEqual(d["accounts"], ["A$", "B$"])

    def test_spn_find_duplicates_none(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=self.TWO)   # all SPNs unique
        rc, out = self.call_main(["spn-find-duplicates"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["count"], 0)


class TestGpoOsScope(Base):
    """OS-exclusive GPOs: a GPO is created Windows- or Linux-exclusive and the
    write verbs refuse a setting whose OS crosses that scope."""
    WGPO = "{31B2F340-016D-11D2-945F-00C04FB984F9}"
    LGPO = "{6AC1786C-016F-11D2-945F-00C04FB984F9}"

    def _win_entries(self):
        return ('[{"keyname":"Software\\\\Policies\\\\Microsoft\\\\Windows",'
                '"valuename":"X","class":"MACHINE","type":"REG_DWORD","data":1}]')

    def _lnx_entries(self):
        return ('[{"keyname":"Software\\\\Policies\\\\Ubuntu\\\\dconf",'
                '"valuename":"Y","class":"USER","type":"REG_SZ","data":"z"}]')

    def _shared_entries(self):
        # certificate auto-enrollment: Microsoft-rooted but consumed on both OSes
        return ('[{"keyname":"Software\\\\Policies\\\\Microsoft\\\\Cryptography'
                '\\\\AutoEnrollment","valuename":"AEPolicy","class":"MACHINE",'
                '"type":"REG_DWORD","data":7}]')

    def _mock_source_preg(self, entries):
        """Make the source GPO's registry.pol read (Machine) return `entries`."""
        b64 = _b64(_preg(entries))
        self.fake.on(lambda a: "bash" in a and any("/Machine" in str(x) for x in a),
                     out=b64)
        self.fake.on(lambda a: "bash" in a and any("/User" in str(x) for x in a),
                     out="")

    # -- classifier / normalizer units ------------------------------------
    def test_setting_os_classifies_by_root(self):
        self.assertEqual(mod._setting_os("Software\\Policies\\Ubuntu\\dconf"), "Linux")
        self.assertEqual(mod._setting_os("software/policies/gnome/x"), "Linux")
        self.assertEqual(mod._setting_os("Software\\Policies\\Microsoft\\Windows"), "Windows")
        self.assertEqual(mod._setting_os(""), "Windows")
        # cert auto-enrollment is shared (applies on Windows AND Linux)
        self.assertEqual(mod._setting_os(
            "Software\\Policies\\Microsoft\\Cryptography\\AutoEnrollment"), "shared")
        self.assertEqual(mod._setting_os(
            "software\\policies\\microsoft\\cryptography\\policyservers\\x"), "shared")

    def test_norm_gpo_os(self):
        self.assertEqual(mod._norm_gpo_os("windows"), "Windows")
        self.assertEqual(mod._norm_gpo_os("LINUX"), "Linux")
        with self.assertRaises(mod.Fail):
            mod._norm_gpo_os("plan9")

    # -- create records scope; list reflects it ---------------------------
    def test_create_requires_os(self):
        self.fake.lab_up()
        rc, out = self.call_main(["gpo-create", "--name", "x"])
        self.assertEqual(rc, 2)              # required enum missing -> parse error
        self.assertIn("os", out["error"])

    def test_create_records_scope_and_list_reflects_it(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo create" in str(x) for x in a),
                     out="GPO 'l' created as %s\n" % self.LGPO)
        rc, out = self.call_main(["gpo-create", "--name", "l", "--os", "Linux"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["os"], "Linux")
        self.assertEqual(mod._declared_gpo_os(self.LGPO), "Linux")
        self.fake.on(lambda a: any("gpo listall" in str(x) for x in a), out=GPO_LISTALL)
        rc, lst = self.call_main(["gpo-list"])
        self.assertEqual(rc, 0)
        scopes = {g["gpo"]: g["os_scope"] for g in lst["gpos"]}
        self.assertEqual(scopes[self.LGPO], "Linux")
        self.assertEqual(scopes[self.WGPO], "")          # undeclared -> blank

    # -- settings-apply enforcement ---------------------------------------
    def test_settings_apply_refuses_cross_os(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.WGPO, "Windows")
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="ok\n")
        rc, out = self.call_main(["gpo-settings-apply", "--gpo", self.WGPO,
                                  "--entries", self._lnx_entries()])
        self.assertEqual(rc, 1)
        self.assertIn("Windows-exclusive", out["error"])
        self.assertIn("Ubuntu", out["error"])
        self.assertEqual(self.fake.argv_containing("gpo load"), [])   # never ran

    def test_settings_apply_allows_matching_os(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.WGPO, "Windows")
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="ok\n")
        rc, out = self.call_main(["gpo-settings-apply", "--gpo", self.WGPO,
                                  "--entries", self._win_entries()])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["applied"], 1)
        self.assertEqual(out["os_scope"], "Windows")

    def test_settings_apply_allows_shared_setting_on_either_scope(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.LGPO, "Linux")
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="ok\n")
        rc, out = self.call_main(["gpo-settings-apply", "--gpo", self.LGPO,
                                  "--entries", self._shared_entries()])
        self.assertEqual(rc, 0, out)         # cert auto-enroll allowed on a Linux GPO
        self.assertEqual(out["applied"], 1)

    def test_settings_apply_undeclared_gpo_not_enforced(self):
        # back-compat: a GPO the plugin did not create carries no scope, so any
        # setting is accepted (no inference on the write path, no extra reads).
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="ok\n")
        rc, out = self.call_main(["gpo-settings-apply", "--gpo", self.WGPO,
                                  "--entries", self._lnx_entries()])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["applied"], 1)
        self.assertEqual(out["os_scope"], "")

    # -- preferences (samba Unix CSEs are Linux-only) ---------------------
    def test_pref_set_refused_on_windows_gpo(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.WGPO, "Windows")
        rc, out = self.call_main(["gpo-pref-set", "--gpo", self.WGPO,
                                  "--cse", "motd", "--value", "hi"])
        self.assertEqual(rc, 1)
        self.assertIn("Linux-only", out["error"])
        self.assertEqual(self.fake.argv_containing("gpo manage"), [])

    def test_pref_set_allowed_on_linux_gpo(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.LGPO, "Linux")
        self.fake.on(lambda a: any("gpo manage motd set" in str(x) for x in a), out="")
        rc, out = self.call_main(["gpo-pref-set", "--gpo", self.LGPO,
                                  "--cse", "motd", "--value", "hi"])
        self.assertEqual(rc, 0, out)

    # -- template-stack enforcement ---------------------------------------
    def test_template_stack_refuses_cross_os(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.WGPO, "Windows")           # target is Windows
        self._mock_source_preg([("Software\\Policies\\Ubuntu\\dconf", "On", 4,
                                 _struct.pack("<I", 1))])
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="ok\n")
        rc, out = self.call_main(["gpo-template-stack", "--target", self.WGPO,
                                  "--sources", self.LGPO])
        self.assertEqual(rc, 1)
        self.assertIn("Windows-exclusive", out["error"])
        self.assertEqual(self.fake.argv_containing("gpo load"), [])

    # -- gpo-set-os --------------------------------------------------------
    def test_set_os_persists_and_verifies_existence(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo show" in str(x) for x in a),
                     out="GPO          : %s\ndisplay name : t\n" % self.WGPO)
        rc, out = self.call_main(["gpo-set-os", "--gpo", self.WGPO, "--os", "Linux"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["os"], "Linux")
        self.assertEqual(mod._declared_gpo_os(self.WGPO), "Linux")

    def test_set_os_rejects_bad_os(self):
        rc, out = self.call_main(["gpo-set-os", "--gpo", self.WGPO, "--os", "BeOS"])
        self.assertEqual(rc, 2)             # enum validated at parse time

    def test_set_os_fails_when_gpo_missing(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo show" in str(x) for x in a), rc=1,
                     err="GPO does not exist\n")
        rc, out = self.call_main(["gpo-set-os", "--gpo", self.WGPO, "--os", "Windows"])
        self.assertEqual(rc, 1)
        self.assertIsNone(mod._declared_gpo_os(self.WGPO))   # not recorded

    def test_delete_clears_scope(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.WGPO, "Windows")
        self.fake.on(lambda a: any("gpo del" in str(x) for x in a), out="Deleted\n")
        rc, out = self.call_main(["gpo-delete", "--gpo", self.WGPO])
        self.assertEqual(rc, 0, out)
        self.assertIsNone(mod._declared_gpo_os(self.WGPO))

    # -- gpo-show inference (display only) ---------------------------------
    def test_show_infers_linux_from_settings(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo show" in str(x) for x in a),
                     out="GPO : %s\nversion : 1\n" % self.WGPO)
        self.fake.on(lambda a: any("listcontainers" in str(x) for x in a), out="")
        self._mock_source_preg([("Software\\Policies\\Ubuntu\\x", "On", 4,
                                 _struct.pack("<I", 1))])
        rc, out = self.call_main(["gpo-show", "--gpo", self.WGPO])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["os_scope"], "Linux")
        self.assertEqual(out["os_source"], "inferred")

    def test_show_uses_declared_scope(self):
        self.fake.lab_up()
        mod._set_gpo_os(self.WGPO, "Windows")
        self.fake.on(lambda a: any("gpo show" in str(x) for x in a),
                     out="GPO : %s\n" % self.WGPO)
        self.fake.on(lambda a: any("listcontainers" in str(x) for x in a), out="")
        self.fake.on(lambda a: "bash" in a, out="")     # registry read empty
        rc, out = self.call_main(["gpo-show", "--gpo", self.WGPO])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["os_scope"], "Windows")
        self.assertEqual(out["os_source"], "declared")


class TestCatalog(Base):
    def setUp(self):
        super().setUp()
        self._cat = tempfile.NamedTemporaryFile(delete=False, suffix=".json")
        self._cat.close()
        os.unlink(self._cat.name)   # start with no file
        self._old_cat = mod.CATALOG_TAGS_FILE
        mod.CATALOG_TAGS_FILE = self._cat.name

    def tearDown(self):
        mod.CATALOG_TAGS_FILE = self._old_cat
        if os.path.exists(self._cat.name):
            os.unlink(self._cat.name)
        super().tearDown()

    def test_derive_tags(self):
        self.assertEqual(mod._derive_tags("admx", "GNOME_Settings.admx"), ("Linux", ["gnome", "kde", "wayland"]))
        self.assertEqual(mod._derive_tags("admx", "samba.admx")[0], "Linux")
        self.assertEqual(mod._derive_tags("admx", "Microsoft.Windows.admx"), ("Windows", ["WinPC", "WinServer"]))
        self.assertEqual(mod._derive_tags("cse", "sudoers")[0], "Linux")

    def test_catalog_tag_validate_and_persist(self):
        rc, out = self.call_main(["gpo-catalog-tag", "--id", "admx:x:y",
                                  "--os_type", "Linux", "--subsystems", "vnc,xfreerdp3"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["subsystems"], ["vnc", "xfreerdp3"])
        # persisted and merged on next read
        self.assertEqual(mod._read_catalog_tags()["admx:x:y"]["os_type"], "Linux")

    def test_catalog_tag_rejects_bad_os_and_subsystem(self):
        rc, out = self.call_main(["gpo-catalog-tag", "--id", "z", "--os_type", "BeOS"])
        self.assertEqual(rc, 2)   # enum validation at parse time
        rc, out = self.call_main(["gpo-catalog-tag", "--id", "z", "--subsystems", "gnome,bogus"])
        self.assertEqual(rc, 1)
        self.assertIn("unknown subsystem", out["error"])

    def test_catalog_lists_cse_entries_and_facets(self):
        # no ADMX loaded -> catalog is just the CSE preferences, all Linux
        self.fake.lab_up()
        self.fake.on(lambda a: "bash" in a and any("*.admx" in str(x) for x in a), out="")
        rc, out = self.call_main(["gpo-catalog"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["os_types"], mod.OS_TYPES)
        self.assertEqual(out["subsystems"], mod.SUBSYSTEMS)
        cse = [e for e in out["entries"] if e["source"] == "cse"]
        self.assertEqual(len(cse), len(mod.GPO_CSES))
        self.assertTrue(all(e["os_type"] == "Linux" for e in cse))

    def test_catalog_applies_saved_override(self):
        mod._write_catalog_tags({"cse:motd": {"os_type": "Linux", "subsystems": ["kde"]}})
        self.fake.lab_up()
        self.fake.on(lambda a: "bash" in a and any("*.admx" in str(x) for x in a), out="")
        rc, out = self.call_main(["gpo-catalog"])
        motd = next(e for e in out["entries"] if e.get("cse") == "motd")
        self.assertEqual(motd["subsystems"], ["kde"])   # override wins over derived


# ---------------------------------------------------------------------------
# AD objects + schema (dsa.msc object editor)
# ---------------------------------------------------------------------------

# Three classSchema entries forming a tiny inheritance chain user->person->top
# plus the attributeSchema and displaySpecifier the schema verb consults.
CLS_USER = """dn: CN=User,CN=Schema,CN=Configuration,DC=ad,DC=edt1,DC=lab
lDAPDisplayName: user
subClassOf: person
mustContain: cn
mayContain: sn
mayContain: givenName
mayContain: description
mayContain: memberOf
mayContain: userAccountControl
mayContain: sAMAccountName
mayContain: userPrincipalName
"""
CLS_PERSON = """dn: CN=Person,CN=Schema,CN=Configuration,DC=ad,DC=edt1,DC=lab
lDAPDisplayName: person
subClassOf: top
mayContain: telephoneNumber
"""
CLS_TOP = """dn: CN=Top,CN=Schema,CN=Configuration,DC=ad,DC=edt1,DC=lab
lDAPDisplayName: top
subClassOf: top
"""

def _attrschema(ln, syn, single="TRUE", rng="64", sysonly="FALSE", sysflags="0"):
    return ("dn: CN=%s,CN=Schema,CN=Configuration,DC=ad,DC=edt1,DC=lab\n"
            "lDAPDisplayName: %s\nattributeSyntax: %s\noMSyntax: 64\n"
            "isSingleValued: %s\nrangeUpper: %s\nsystemOnly: %s\nsystemFlags: %s\n"
            % (ln, ln, syn, single, rng, sysonly, sysflags))

ATTRS_LDIF = "\n".join([
    _attrschema("cn", "2.5.5.12"),
    _attrschema("sn", "2.5.5.12"),
    _attrschema("givenName", "2.5.5.12"),
    _attrschema("description", "2.5.5.12", single="FALSE", rng="1024"),   # -> multitext, multi
    _attrschema("telephoneNumber", "2.5.5.12"),
    _attrschema("memberOf", "2.5.5.1", single="FALSE", sysonly="TRUE"),   # dn, read-only
    _attrschema("userAccountControl", "2.5.5.9"),                        # int
    _attrschema("sAMAccountName", "2.5.5.12"),
    _attrschema("userPrincipalName", "2.5.5.12"),
])

USER_DISPLAY = """dn: CN=user-Display,CN=409,CN=DisplaySpecifiers,CN=Configuration,DC=ad,DC=edt1,DC=lab
classDisplayName: User
attributeDisplayNames: givenName,First name
attributeDisplayNames: sn,Last name
adminPropertyPages: 1,{6dfe6485-a212-11d0-bcd5-00c04fd8d5b6}
"""

def _schema_lab(fake):
    """Wire a FakeRunner to answer the schema/display queries for the chain."""
    fake.lab_up()
    fake.on(lambda a: any("lDAPDisplayName=user)" in str(x) for x in a), out=CLS_USER)
    fake.on(lambda a: any("lDAPDisplayName=person)" in str(x) for x in a), out=CLS_PERSON)
    fake.on(lambda a: any("lDAPDisplayName=top)" in str(x) for x in a), out=CLS_TOP)
    fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a), out=ATTRS_LDIF)
    fake.on(lambda a: any("user-Display" in str(x) for x in a), out=USER_DISPLAY)
    return fake


class TestLdifParse(Base):
    def test_folding_and_base64_text(self):
        text = ("dn: CN=X,DC=ad,DC=edt1,DC=lab\n"
                "cn:: %s\n"
                "description: line one\n line two\n"
                "\n" % _b64(b"Hello"))
        ents = mod.parse_ldif_full(text)
        self.assertEqual(len(ents), 1)
        self.assertEqual(ents[0]["dn"], "CN=X,DC=ad,DC=edt1,DC=lab")
        self.assertEqual(ents[0]["attrs"]["cn"], ["Hello"])          # base64 decoded to text
        self.assertFalse(ents[0]["b64"]["cn"][0])
        self.assertEqual(ents[0]["attrs"]["description"], ["line oneline two"])  # folded

    def test_binary_base64_becomes_hex(self):
        text = ("dn: CN=Y,DC=ad,DC=edt1,DC=lab\n"
                "blob:: %s\n\n" % _b64(b"\x00\x01\x02"))
        ents = mod.parse_ldif_full(text)
        self.assertEqual(ents[0]["attrs"]["blob"], ["000102"])
        self.assertTrue(ents[0]["b64"]["blob"][0])

    def test_referral_blocks_skipped(self):
        text = ("dn: CN=Z,DC=ad,DC=edt1,DC=lab\ncn: Z\n\n"
                "# Referral\nref: ldap://ad.edt1.lab/CN=Configuration\n\n")
        ents = mod.parse_ldif_full(text)
        self.assertEqual([e["dn"] for e in ents], ["CN=Z,DC=ad,DC=edt1,DC=lab"])


class TestSchemaResolution(Base):
    def test_control_type_map(self):
        self.assertEqual(mod.AD_SYNTAX["2.5.5.8"], "bool")
        self.assertEqual(mod.AD_SYNTAX["2.5.5.9"], "int")
        self.assertEqual(mod.AD_SYNTAX["2.5.5.1"], "dn")
        self.assertEqual(mod.AD_SYNTAX["2.5.5.12"], "text")

    def test_resolve_class_walks_chain_and_terminates(self):
        _schema_lab(self.fake)
        res = mod._resolve_class_attrs("dc1", "user")
        self.assertEqual(res["mandatory"], {"cn"})
        self.assertIn("telephoneNumber", res["optional"])   # inherited from person
        self.assertIn("sn", res["optional"])
        self.assertEqual(res["chain"], ["user", "person", "top"])   # stops at top

    def test_attr_meta_types(self):
        _schema_lab(self.fake)
        meta = mod._attr_meta("dc1", ["cn", "description", "memberOf", "userAccountControl"])
        self.assertEqual(meta["cn"]["type"], "text")
        self.assertEqual(meta["description"]["type"], "multitext")   # rangeUpper > 256
        self.assertTrue(meta["description"]["multi"])
        self.assertEqual(meta["userAccountControl"]["type"], "int")
        self.assertTrue(meta["memberOf"]["readonly"])               # systemOnly


class TestObjectSchemaVerb(Base):
    def test_tabs_built_and_validated_against_schema(self):
        _schema_lab(self.fake)
        rc, out = self.call_main(["object-schema", "--class", "user"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["structural_class"], "user")
        self.assertEqual(out["class_label"], "User")
        tabs = {t["id"]: t for t in out["tabs"]}
        # address/profile/telephones/organization drop out — none of their
        # attributes are in this reduced schema; general/account/memberof stay
        self.assertEqual(set(tabs), {"general", "account", "memberof"})
        gen = [f["attr"] for f in tabs["general"]["fields"]]
        self.assertEqual(gen, ["givenName", "sn", "description", "telephoneNumber"])
        # friendly label came from the displaySpecifier
        gn = next(f for f in tabs["general"]["fields"] if f["attr"] == "givenName")
        self.assertEqual(gn["label"], "First name")
        # composite kind survives
        uac = next(f for f in tabs["account"]["fields"] if f["attr"] == "userAccountControl")
        self.assertEqual(uac["kind"], "uac")
        # full allowed-attribute catalog powers the Attribute Editor
        self.assertEqual(len(out["attributes"]), 9)
        self.assertEqual(sorted(out["mandatory"]), ["cn"])


class TestObjectVerbs(Base):
    def test_list_builds_class_and_search_filter(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a,
                     out="dn: CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab\n"
                         "objectClass: top\nobjectClass: person\nobjectClass: user\n"
                         "cn: Bob\nsAMAccountName: bob\n\n")
        rc, out = self.call_main(["object-list", "--base", "CN=Users,DC=ad,DC=edt1,DC=lab",
                                  "--classes", "user,group", "--search", "bob"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["count"], 1)
        self.assertEqual(out["objects"][0]["class"], "user")
        f = " ".join(self.fake.argv_containing("ldbsearch")[0])
        self.assertIn("(!(objectClass=computer))", f)     # user excludes computers
        self.assertIn("(objectClass=group)", f)
        self.assertIn("sAMAccountName=*bob*", f)

    def test_list_excludes_the_base_object(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a,
                     out="dn: CN=Users,DC=ad,DC=edt1,DC=lab\nobjectClass: container\n\n"
                         "dn: CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab\nobjectClass: user\ncn: Bob\n\n")
        rc, out = self.call_main(["object-list", "--base", "CN=Users,DC=ad,DC=edt1,DC=lab",
                                  "--classes", "user"])
        self.assertEqual([o["name"] for o in out["objects"]], ["Bob"])

    def test_tree_hides_system_unless_requested(self):
        tree = ("dn: DC=ad,DC=edt1,DC=lab\nobjectClass: domainDNS\n\n"
                "dn: CN=Users,DC=ad,DC=edt1,DC=lab\nobjectClass: container\ncn: Users\n\n"
                "dn: CN=System,DC=ad,DC=edt1,DC=lab\nobjectClass: container\ncn: System\n\n")
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a, out=tree)
        rc, out = self.call_main(["object-tree"])
        names = [n["name"] for n in out["nodes"]]
        self.assertIn("Users", names)
        self.assertNotIn("System", names)          # hidden by default
        rc, out = self.call_main(["object-tree", "--system", "yes"])
        self.assertIn("System", [n["name"] for n in out["nodes"]])

    def test_modify_builds_ldif_changetype(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=_attrschema("sn", "2.5.5.12") + _attrschema("description", "2.5.5.12"))
        self.fake.on(lambda a: "ldbmodify" in a, out="Modified 1 record\n")
        self.fake.on(lambda a: "ldbsearch" in a and "base" in a,
                     out="dn: CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab\nsn: Smith\n")
        changes = json.dumps([{"attr": "sn", "op": "replace", "values": ["Smith"]},
                              {"attr": "description", "op": "delete", "values": []}])
        rc, out = self.call_main(["object-modify", "--dn", "CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab",
                                  "--changes", changes])
        self.assertEqual(rc, 0)
        self.assertEqual(out["changes"], 2)
        call = next((argv, stdin) for argv, stdin in self.fake.calls if "ldbmodify" in argv)
        ldif = call[1]
        self.assertIn("changetype: modify", ldif)
        self.assertIn("replace: sn", ldif)
        self.assertIn("sn: Smith", ldif)
        self.assertIn("delete: description", ldif)

    def test_modify_rejects_bad_op(self):
        self.fake.lab_up()
        rc, out = self.call_main(["object-modify", "--dn", "CN=Bob,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps([{"attr": "sn", "op": "frobnicate"}])])
        self.assertEqual(rc, 1)
        self.assertIn("bad op", out["error"])

    def test_rename_and_delete_build_ldb_commands(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbrename" in a, out="")
        self.fake.on(lambda a: "ldbdel" in a, out="")
        rc, out = self.call_main(["object-rename", "--dn", "CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab",
                                  "--new_dn", "CN=Bobby,CN=Users,DC=ad,DC=edt1,DC=lab"])
        self.assertEqual(rc, 0)
        self.assertTrue(self.fake.argv_containing("ldbrename", "CN=Bobby,CN=Users,DC=ad,DC=edt1,DC=lab"))
        rc, out = self.call_main(["object-delete", "--dn", "OU=Old,DC=ad,DC=edt1,DC=lab",
                                  "--recursive", "yes"])
        self.assertEqual(rc, 0)
        self.assertTrue(self.fake.argv_containing("ldbdel", "--recursive"))

    def test_modify_escapes_ldif_injection(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=_attrschema("description", "2.5.5.12"))
        self.fake.on(lambda a: "ldbmodify" in a, out="Modified 1 record\n")
        self.fake.on(lambda a: "ldbsearch" in a and "base" in a,
                     out="dn: CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab\n")
        evil = "inj\nreplace: displayName\ndisplayName: PWNED\n-"
        rc, out = self.call_main(["object-modify", "--dn", "CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps([{"attr": "description", "op": "replace", "values": [evil]}])])
        self.assertEqual(rc, 0)
        ldif = next(stdin for argv, stdin in self.fake.calls if "ldbmodify" in argv)
        # the value is base64-wrapped, so the injected ops never appear as LDIF
        self.assertIn("description:: ", ldif)
        self.assertNotIn("displayName", ldif)
        self.assertNotIn("PWNED", ldif)          # it is inside the base64, not plaintext
        self.assertEqual(ldif.count("replace: "), 1)

    def test_modify_rejects_non_dict_change(self):
        self.fake.lab_up()
        rc, out = self.call_main(["object-modify", "--dn", "CN=Bob,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps(["notadict"])])
        self.assertEqual(rc, 1)          # clean Fail, not an internal exit-3
        self.assertIn("must be an object", out["error"])

    def test_delete_and_rename_guard_critical_objects(self):
        # no lab needed — the guard raises before any DC work
        for dn in ("DC=ad,DC=edt1,DC=lab",
                   "CN=Administrator,CN=Users,DC=ad,DC=edt1,DC=lab",
                   "OU=Domain Controllers,DC=ad,DC=edt1,DC=lab"):
            rc, out = self.call_main(["object-delete", "--dn", dn])
            self.assertEqual(rc, 1, dn)
            self.assertIn("critical", out["error"])
            rc, out = self.call_main(["object-rename", "--dn", dn, "--new_dn", "CN=X,DC=ad,DC=edt1,DC=lab"])
            self.assertEqual(rc, 1, dn)
            self.assertIn("critical", out["error"])

    def test_attr_meta_flags_backlink_readonly(self):
        self.fake.lab_up()
        # a back-link (odd linkID) with systemOnly FALSE and no constructed bit
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=("dn: CN=Is-Member-Of-DL,CN=Schema,CN=Configuration,DC=ad,DC=edt1,DC=lab\n"
                          "lDAPDisplayName: memberOf\nattributeSyntax: 2.5.5.1\noMSyntax: 127\n"
                          "isSingleValued: FALSE\nsystemOnly: FALSE\nsystemFlags: 0\nlinkID: 3\n"))
        meta = mod._attr_meta("dc1", ["memberOf"])
        self.assertTrue(meta["memberOf"]["readonly"])   # odd linkID -> read-only

    def test_relative_ou_strips_domain(self):
        self.assertEqual(mod._relative_ou("DC=ad,DC=edt1,DC=lab"), "")
        self.assertEqual(mod._relative_ou("OU=Sales,DC=ad,DC=edt1,DC=lab"), "OU=Sales")
        self.assertEqual(mod._relative_ou("OU=Team,OU=Sales,DC=ad,DC=edt1,DC=lab"), "OU=Team,OU=Sales")

    def test_create_ou_uses_full_dn(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ou" in a and "create" in a, out="")
        rc, out = self.call_main(["object-create", "--class", "organizationalUnit",
                                  "--name", "Sales", "--parent", "DC=ad,DC=edt1,DC=lab"])
        self.assertEqual(rc, 0)
        self.assertTrue(self.fake.argv_containing("samba-tool", "ou", "create", "OU=Sales,DC=ad,DC=edt1,DC=lab"))

    def test_create_user_placed_and_returns_password(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "user" in a and "create" in a, out="")
        rc, out = self.call_main(["object-create", "--class", "user", "--name", "jdoe",
                                  "--parent", "OU=Sales,DC=ad,DC=edt1,DC=lab",
                                  "--given", "Jane", "--surname", "Doe"])
        self.assertEqual(rc, 0)
        self.assertIn("password", out)          # generated password returned once
        call = next((argv, stdin) for argv, stdin in self.fake.calls
                    if "user" in argv and "create" in argv)
        argv, stdin = call
        self.assertIn("--userou", argv)
        self.assertEqual(argv[argv.index("--userou") + 1], "OU=Sales")   # domain stripped
        self.assertIn("--given-name", argv)
        self.assertTrue(stdin and stdin.count("\n") >= 2)                # pw entered twice

    def test_create_group_relative_ou(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "group" in a and "add" in a, out="")
        rc, out = self.call_main(["object-create", "--class", "group", "--name", "Eng",
                                  "--parent", "OU=Team,OU=Sales,DC=ad,DC=edt1,DC=lab"])
        self.assertEqual(rc, 0)
        argv = self.fake.argv_containing("samba-tool", "group", "add")[0]
        self.assertEqual(argv[argv.index("--groupou") + 1], "OU=Team,OU=Sales")

    def test_create_rejects_unknown_class(self):
        rc, out = self.call_main(["object-create", "--class", "printQueue", "--name", "p1"])
        self.assertEqual(rc, 2)      # enum validation at parse time

    def test_create_rejects_dn_metacharacters(self):
        # a crafted name must not be able to redirect the DN (silent-redirect bug)
        self.fake.lab_up()
        rc, out = self.call_main(["object-create", "--class", "organizationalUnit",
                                  "--name", "x,OU=elsewhere", "--parent", "DC=ad,DC=edt1,DC=lab"])
        self.assertEqual(rc, 1)
        self.assertIn("must not contain", out["error"])
        self.assertFalse(self.fake.argv_containing("samba-tool", "ou", "create"))  # never issued

    def test_create_ou_returns_real_dn(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ou" in a and "create" in a, out="")
        rc, out = self.call_main(["object-create", "--class", "organizationalUnit",
                                  "--name", "Sales", "--parent", "DC=ad,DC=edt1,DC=lab"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["dn"], "OU=Sales,DC=ad,DC=edt1,DC=lab")

    # -- P0: honest writes ------------------------------------------------
    def test_modify_rejects_readonly_attribute(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=_attrschema("objectSid", "2.5.5.17", sysonly="TRUE"))
        rc, out = self.call_main(["object-modify", "--dn", "CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps([{"attr": "objectSid", "op": "replace", "values": ["x"]}])])
        self.assertEqual(rc, 1)
        self.assertIn("read-only", out["error"])
        self.assertFalse(self.fake.argv_containing("ldbmodify"))   # never dispatched

    def test_modify_reports_not_applied(self):
        # ldbmodify accepts, but read-back shows the value did not take -> all_ok False
        self.fake.lab_up()
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=_attrschema("description", "2.5.5.12"))
        self.fake.on(lambda a: "ldbmodify" in a, out="Modified 1 record\n")
        self.fake.on(lambda a: "ldbsearch" in a and "base" in a,
                     out="dn: CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab\ndescription: OLD\n")
        rc, out = self.call_main(["object-modify", "--dn", "CN=Bob,CN=Users,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps([{"attr": "description", "op": "replace", "values": ["NEW"]}])])
        self.assertEqual(rc, 0)
        self.assertFalse(out["all_ok"])
        self.assertFalse(out["applied"][0]["ok"])
        self.assertEqual(out["applied"][0]["observed"], ["OLD"])

    def test_modify_readonly_guard_is_case_insensitive(self):
        # a lowercase name must not slip past the read-only guard (LDAP is CI)
        self.fake.lab_up()
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=_attrschema("whenCreated", "2.5.5.11", sysonly="TRUE"))
        rc, out = self.call_main(["object-modify", "--dn", "OU=x,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps([{"attr": "whencreated", "op": "replace",
                                                            "values": ["20200101000000.0Z"]}])])
        self.assertEqual(rc, 1)
        self.assertIn("read-only", out["error"])
        self.assertFalse(self.fake.argv_containing("ldbmodify"))

    def test_modify_dn_value_verified_normalised(self):
        # a DN written lowercase is stored canonical; verify must still say ok
        self.fake.lab_up()
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=_attrschema("managedBy", "2.5.5.1"))
        self.fake.on(lambda a: "ldbmodify" in a, out="Modified 1 record\n")
        self.fake.on(lambda a: "ldbsearch" in a and "base" in a,
                     out="dn: OU=x,DC=ad,DC=edt1,DC=lab\nmanagedBy: CN=Administrator,CN=Users,DC=ad,DC=edt1,DC=lab\n")
        rc, out = self.call_main(["object-modify", "--dn", "OU=x,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps([{"attr": "managedBy", "op": "replace",
                                                            "values": ["cn=administrator,cn=users,DC=ad,DC=edt1,DC=lab"]}])])
        self.assertEqual(rc, 0)
        self.assertTrue(out["all_ok"])                 # normalised DN compare -> ok
        self.assertTrue(out["applied"][0]["ok"])

    def test_modify_b64_change_is_verified(self):
        # a b64 change is now actually verified, not blindly reported ok
        self.fake.lab_up()
        self.fake.on(lambda a: any(str(x).startswith("(&(objectClass=attributeSchema)") for x in a),
                     out=_attrschema("description", "2.5.5.12"))
        self.fake.on(lambda a: "ldbmodify" in a, out="Modified 1 record\n")
        self.fake.on(lambda a: "ldbsearch" in a and "base" in a,
                     out="dn: OU=x,DC=ad,DC=edt1,DC=lab\ndescription: STILL_OLD\n")
        rc, out = self.call_main(["object-modify", "--dn", "OU=x,DC=ad,DC=edt1,DC=lab",
                                  "--changes", json.dumps([{"attr": "description", "op": "replace",
                                                            "b64": True, "values": [_b64(b"NEWVAL")]}])])
        self.assertEqual(rc, 0)
        self.assertFalse(out["all_ok"])                # value did not take -> honest
        self.assertFalse(out["applied"][0]["ok"])

    # -- P1: protect from accidental deletion -----------------------------
    _PROTECTED_SDDL = "O:DAG:DAD:AI(D;;DTSD;;;WD)(A;;LC;;;RU)"

    def test_protect_on_and_off(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "dsacl" in a and "set" in a, out="")
        self.fake.on(lambda a: "dsacl" in a and "delete" in a, out="")
        self.fake.on(lambda a: "dsacl" in a and "get" in a, out=self._PROTECTED_SDDL)
        rc, out = self.call_main(["object-protect", "--dn", "OU=x,DC=ad,DC=edt1,DC=lab", "--state", "on"])
        self.assertEqual(rc, 0)
        self.assertTrue(out["protected"])
        self.assertTrue(self.fake.argv_containing("dsacl", "set", "(D;;SDDT;;;WD)"))
        rc, out = self.call_main(["object-protect", "--dn", "OU=x,DC=ad,DC=edt1,DC=lab", "--state", "off"])
        self.assertEqual(rc, 0)
        self.assertTrue(self.fake.argv_containing("dsacl", "delete", "(D;;SDDT;;;WD)"))

    def test_delete_refused_when_protected(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "dsacl" in a and "get" in a, out=self._PROTECTED_SDDL)
        rc, out = self.call_main(["object-delete", "--dn", "OU=keep,DC=ad,DC=edt1,DC=lab"])
        self.assertEqual(rc, 1)
        self.assertIn("protected", out["error"])
        self.assertFalse(self.fake.argv_containing("ldbdel"))      # never deleted

    def test_object_get_protection_is_opt_in(self):
        # object-get must not spend a dsacl subprocess unless asked (perf)
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a and "base" in a,
                     out="dn: OU=x,DC=ad,DC=edt1,DC=lab\nobjectClass: top\nobjectClass: organizationalUnit\nou: x\n")
        self.fake.on(lambda a: "dsacl" in a and "get" in a, out=self._PROTECTED_SDDL)
        rc, out = self.call_main(["object-get", "--dn", "OU=x,DC=ad,DC=edt1,DC=lab"])
        self.assertEqual(rc, 0)
        self.assertNotIn("protected", out)                        # not computed by default
        self.assertFalse(self.fake.argv_containing("dsacl", "get"))
        rc, out = self.call_main(["object-get", "--dn", "OU=x,DC=ad,DC=edt1,DC=lab", "--protected", "yes"])
        self.assertTrue(out["protected"])
        self.assertTrue(self.fake.argv_containing("dsacl", "get"))


ADMX_TMPL = """<?xml version="1.0" encoding="{enc}"?>
<policyDefinitions revision="1.0" schemaVersion="1.0"
    xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <policyNamespaces>
    <target prefix="{pfx}" namespace="{ns}"/>
    <using prefix="windows" namespace="Microsoft.Policies.Windows"/>
  </policyNamespaces>
  <resources minRequiredRevision="1.0"/>
  <categories><category name="LocalCat" displayName="$(string.LocalCat)"/></categories>
  <policies>{policies}</policies>
</policyDefinitions>
"""
POL_TMPL = """
    <policy name="{name}" class="{cls}" displayName="$(string.{name})"
            key="Software\\Policies\\Test" valueName="{name}Value">
      <parentCategory ref="LocalCat"/>
      <supportedOn ref="windows:SUPPORTED_Windows10"/>
      <enabledValue><decimal value="1"/></enabledValue>
      <disabledValue><decimal value="0"/></disabledValue>
    </policy>"""
ADML_TMPL = """<?xml version="1.0" encoding="utf-8"?>
<policyDefinitionResources revision="1.0" schemaVersion="1.0"
    xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">
  <displayName/><description/>
  <resources><stringTable>{strings}</stringTable><presentationTable/></resources>
</policyDefinitionResources>
"""


def _mk_admx(d, stem, names, ns=None, adml_stem=None, enc="utf-8", encoding_bytes=None):
    """Write one ADMX plus its ADML into d. adml_stem lets a test create a
    case-mismatched pair; encoding_bytes lets it write real UTF-16."""
    import os as _os
    ns = ns or ("Test.Policies." + stem)
    xml = ADMX_TMPL.format(enc=enc, pfx=stem.lower(), ns=ns,
                           policies="".join(POL_TMPL.format(name=n, cls="Machine") for n in names))
    path = _os.path.join(d, stem + ".admx")
    if encoding_bytes:
        open(path, "wb").write(xml.encode(encoding_bytes))
    else:
        open(path, "w").write(xml)
    _os.makedirs(_os.path.join(d, "en-US"), exist_ok=True)
    strings = "".join('<string id="%s">%s text</string>' % (n, n) for n in names)
    strings += '<string id="LocalCat">Local Category</string>'
    open(_os.path.join(d, "en-US", (adml_stem or stem) + ".adml"), "w").write(
        ADML_TMPL.format(strings=strings))
    return path


class AdmxImportNaming(unittest.TestCase):
    """Retired files must keep valid .admx/.adml extensions -- the suffix goes on
    the STEM. A file named EAIME.admx_retired is not readable by the store."""

    def test_suffix_is_on_the_stem(self):
        self.assertEqual(mod.admx_retired_names("EAIME.admx"),
                         ("EAIME_retired.admx", "EAIME_retired.adml"))
        self.assertEqual(mod.admx_retired_names("WindowsDefender.admx"),
                         ("WindowsDefender_retired.admx", "WindowsDefender_retired.adml"))

    def test_extensions_are_valid(self):
        for src in ("a.admx", "Some.Long.Name.admx"):
            admx, adml = mod.admx_retired_names(src)
            self.assertTrue(admx.endswith(".admx"), admx)
            self.assertTrue(adml.endswith(".adml"), adml)
            self.assertNotIn(".admx_", admx)


class AdmxLint(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.d, ignore_errors=True)

    def test_clean_tree_passes(self):
        _mk_admx(self.d, "Alpha", ["PolA", "PolB"])
        r = mod.admx_lint(self.d)
        self.assertEqual(r["errors"], [], r["errors"])
        self.assertEqual(r["files"], 1)

    def test_adml_case_mismatch_is_an_error(self):
        # kdc.admx + KDC.adml is Microsoft's own shipping pattern; on a
        # case-sensitive SYSVOL it silently unresolves every name in the file.
        _mk_admx(self.d, "kdc", ["PolA"], adml_stem="KDC")
        r = mod.admx_lint(self.d)
        # A warning, not an error: this reader pairs case-insensitively, and
        # Microsoft's own set ships this way, so failing the batch would reject
        # every real import.
        self.assertTrue(any("case mismatch" in w for w in r["warnings"]), r["warnings"])
        self.assertEqual(r["errors"], [], r["errors"])

    def test_namespace_claimed_twice_is_an_error(self):
        _mk_admx(self.d, "One", ["PolA"], ns="Dup.Namespace")
        _mk_admx(self.d, "Two", ["PolB"], ns="Dup.Namespace")
        r = mod.admx_lint(self.d)
        self.assertTrue(any("already claimed by" in e for e in r["errors"]), r["errors"])

    def test_dangling_string_reference_is_an_error(self):
        _mk_admx(self.d, "Beta", ["PolA"])
        import os as _os
        open(_os.path.join(self.d, "en-US", "Beta.adml"), "w").write(
            ADML_TMPL.format(strings='<string id="LocalCat">c</string>'))
        r = mod.admx_lint(self.d)
        self.assertTrue(any("$(string.PolA)" in e for e in r["errors"]), r["errors"])

    def test_unregistered_encoding_declaration_warns(self):
        # Search.admx ships exactly like this: UTF-16 declaring encoding='unicode'.
        _mk_admx(self.d, "Gamma", ["PolA"], enc="unicode", encoding_bytes="utf-16")
        r = mod.admx_lint(self.d)
        self.assertTrue(any("not a registered codec" in w for w in r["warnings"]), r["warnings"])
        self.assertEqual([e for e in r["errors"] if "unparseable" in e], [])


class AdmxPlan(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.a = tempfile.mkdtemp()
        self.b = tempfile.mkdtemp()

    def tearDown(self):
        import shutil
        shutil.rmtree(self.a, ignore_errors=True)
        shutil.rmtree(self.b, ignore_errors=True)

    def test_same_batch_is_a_no_op(self):
        _mk_admx(self.a, "Alpha", ["PolA", "PolB"])
        inv = mod.admx_inventory(self.a)
        p = mod.admx_plan(inv, inv)
        self.assertEqual(p["counts"], {"add": 0, "update": 0,
                                       "retire_files": 0, "retire_policies": 0})

    def test_dropped_policy_is_retired(self):
        _mk_admx(self.a, "Alpha", ["PolA"])              # new batch
        _mk_admx(self.b, "Alpha", ["PolA", "PolGone"])   # what the store holds
        p = mod.admx_plan(mod.admx_inventory(self.a), mod.admx_inventory(self.b))
        self.assertEqual(p["retire"], {"Alpha.admx": ["PolGone"]})

    def test_policy_moved_between_files_is_not_retired(self):
        # PolA leaves Alpha but arrives in Beta. Retiring it would create a second
        # definition writing the same registry target once it is re-added.
        _mk_admx(self.a, "Alpha", [])
        _mk_admx(self.a, "Beta", ["PolA"])
        _mk_admx(self.b, "Alpha", ["PolA"])
        p = mod.admx_plan(mod.admx_inventory(self.a), mod.admx_inventory(self.b))
        self.assertEqual(p["retire"], {})

    def test_filename_case_change_is_the_same_file(self):
        _mk_admx(self.a, "inkwatson", ["PolA"])
        _mk_admx(self.b, "InkWatson", ["PolA"])
        p = mod.admx_plan(mod.admx_inventory(self.a), mod.admx_inventory(self.b))
        self.assertEqual(p["counts"]["retire_policies"], 0)

    def test_protected_files_are_never_retired(self):
        _mk_admx(self.a, "Alpha", ["PolA"])
        _mk_admx(self.b, "Alpha", ["PolA"])
        _mk_admx(self.b, "samba", ["SambaPol"])
        p = mod.admx_plan(mod.admx_inventory(self.a), mod.admx_inventory(self.b))
        self.assertNotIn("samba.admx", p["retire"])


class AdmxRetirementTranscription(unittest.TestCase):
    def setUp(self):
        import tempfile
        self.d = tempfile.mkdtemp()
        _mk_admx(self.d, "Alpha", ["PolKeep", "PolGone"])

    def tearDown(self):
        import shutil
        shutil.rmtree(self.d, ignore_errors=True)

    def test_targets_are_preserved_exactly(self):
        import os as _os
        src = mod.admx_read_local(_os.path.join(self.d, "Alpha.admx"))
        root, sids, pids, disp = mod.admx_build_retired(src, ["PolGone"], "alpha")
        orig = mod.admx_policy_elements(src)["PolGone"]
        new = mod.admx_policy_elements(root)["PolGone"]
        for attr in ("class", "key", "valueName"):
            self.assertEqual(new.get(attr), orig.get(attr), attr)

    def test_namespace_is_distinct_from_the_source(self):
        import os as _os
        src = mod.admx_read_local(_os.path.join(self.d, "Alpha.admx"))
        root, _s, _p, _d = mod.admx_build_retired(src, ["PolGone"], "alpha")
        self.assertNotEqual(mod.admx_target(root)[1], mod.admx_target(src)[1])
        self.assertTrue(mod.admx_target(root)[1].endswith(".Retired"))

    def test_local_category_ref_becomes_qualified(self):
        import os as _os
        src = mod.admx_read_local(_os.path.join(self.d, "Alpha.admx"))
        root, _s, _p, _d = mod.admx_build_retired(src, ["PolGone"], "alpha")
        new = mod.admx_policy_elements(root)["PolGone"]
        refs = [c.get("ref") for c in new if mod._admx_local(c.tag) == "parentCategory"]
        self.assertTrue(all(":" in r for r in refs), refs)

    def test_only_the_display_name_is_branded(self):
        import os as _os
        src = mod.admx_read_local(_os.path.join(self.d, "Alpha.admx"))
        root, sids, pids, disp = mod.admx_build_retired(src, ["PolGone"], "alpha")
        adml = mod.admx_read_local(_os.path.join(self.d, "en-US", "Alpha.adml"))
        out, missing = mod.admx_build_retired_adml(
            adml, sids, pids, brand={disp["PolGone"]: ["2022"]})
        self.assertEqual(missing, [])
        texts = dict((n.get("id"), n.text) for n in out.iter()
                     if mod._admx_local(n.tag) == "string")
        self.assertTrue(texts[disp["PolGone"]].endswith("(2022)"), texts)
        self.assertFalse((texts.get("LocalCat") or "").endswith("(2022)"))


class TestGpoCatalog(Base):
    def test_source_cse_skips_admx_parse(self):
        # source=cse returns only the CSE preference entries and must NOT parse
        # ADMX (no podman calls). The ADMX parse is the slow path (thousands of
        # policies, tens of seconds) the prefs modal's OS filter must avoid.
        rc, out = self.call_main(["gpo-catalog", "--source", "cse"])
        self.assertEqual(rc, 0, out)
        cse = [e for e in out["entries"] if e.get("source") == "cse"]
        self.assertEqual(len(cse), len(mod.GPO_CSES))
        self.assertEqual([e for e in out["entries"] if e.get("source") == "admx"], [])
        self.assertTrue(all(e["os_type"] == "Linux" for e in cse))
        self.assertTrue(all(e.get("subsystems") for e in cse))
        self.assertIn("Windows", out["os_types"])
        self.assertIn("Linux", out["os_types"])
        # the whole point: nothing was shelled out to build the CSE catalog
        self.assertEqual(self.fake.calls, [])

    def test_source_cse_honours_os_filter(self):
        # Every CSE is Linux, so an OS=Windows filter must yield none — this is
        # exactly what the prefs modal shows when "Windows" is selected.
        rc, out = self.call_main(["gpo-catalog", "--source", "cse", "--os_type", "Windows"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["entries"], [])


class TestCatalogCache(Base):
    A = "/pd/PolicyDefinitions/a.admx"
    B = "/pd/PolicyDefinitions/b.admx"

    def test_diff_reuse_new_and_delete(self):
        cached = {self.A: {"sig": "10:100", "adml_sig": "5:50", "policies": [{"id": "a"}]},
                  "/pd/PolicyDefinitions/gone.admx": {"sig": "1:1", "adml_sig": "", "policies": []}}
        cur = {self.A: "10:100", self.B: "20:200"}
        adml = {"a.adml": ("/pd/PolicyDefinitions/en-US/a.adml", "5:50"),
                "b.adml": ("/pd/PolicyDefinitions/en-US/b.adml", "9:90")}
        to_parse, reused, deleted = mod._catalog_diff(cached, cur, adml)
        self.assertEqual(reused, [self.A])                       # unchanged -> kept
        self.assertEqual(deleted, ["/pd/PolicyDefinitions/gone.admx"])  # unbacked -> purged
        self.assertEqual([t[0] for t in to_parse], [self.B])     # new -> ingested
        self.assertEqual(to_parse[0][1], "/pd/PolicyDefinitions/en-US/b.adml")
        self.assertEqual(to_parse[0][3], "9:90")                 # adml sig threaded through

    def test_diff_reparses_on_admx_mtime_change(self):
        cached = {self.A: {"sig": "10:100", "adml_sig": "5:50", "policies": []}}
        adml = {"a.adml": ("/pd/PolicyDefinitions/en-US/a.adml", "5:50")}
        to_parse, reused, _ = mod._catalog_diff(cached, {self.A: "10:101"}, adml)
        self.assertEqual([t[0] for t in to_parse], [self.A])
        self.assertEqual(reused, [])

    def test_diff_reparses_when_adml_changes(self):
        cached = {self.A: {"sig": "10:100", "adml_sig": "5:50", "policies": []}}
        adml = {"a.adml": ("/pd/PolicyDefinitions/en-US/a.adml", "5:51")}   # adml newer
        to_parse, reused, _ = mod._catalog_diff(cached, {self.A: "10:100"}, adml)
        self.assertEqual([t[0] for t in to_parse], [self.A])
        self.assertEqual(reused, [])

    def test_diff_force_reparses_all(self):
        cached = {self.A: {"sig": "10:100", "adml_sig": "", "policies": []}}
        to_parse, reused, _ = mod._catalog_diff(cached, {self.A: "10:100"}, {}, force=True)
        self.assertEqual([t[0] for t in to_parse], [self.A])
        self.assertEqual(reused, [])

    def test_gpo_catalog_serves_from_cache_without_podman(self):
        import tempfile
        fd, path = tempfile.mkstemp(suffix=".json")
        os.close(fd)
        self.addCleanup(os.unlink, path)
        cache = {"version": mod.CATALOG_CACHE_VERSION, "pol_root": "/x", "lang": "en-US",
                 "built": "2026-01-01T00:00:00Z",
                 "admx": {"/x/PolicyDefinitions/samba.admx": {
                     "sig": "1:1", "adml_sig": "",
                     "policies": [{"id": "P1", "admx": "samba.admx", "display": "Samba P1",
                                   "key": "Software\\Policies", "valuename": "P1",
                                   "class": "MACHINE", "unresolved": False}]}}}
        with open(path, "w") as f:
            json.dump(cache, f)
        old = mod.CATALOG_CACHE_FILE
        mod.CATALOG_CACHE_FILE = path
        try:
            rc, out = self.call_main(["gpo-catalog"])
        finally:
            mod.CATALOG_CACHE_FILE = old
        self.assertEqual(rc, 0, out)
        admx = [e for e in out["entries"] if e["source"] == "admx"]
        self.assertEqual(len(admx), 1)
        self.assertEqual(admx[0]["name"], "Samba P1")
        self.assertEqual(admx[0]["os_type"], "Linux")     # _derive_tags: samba -> Linux
        self.assertEqual(out["cache_file"], path)
        self.assertEqual(out["cached_at"], "2026-01-01T00:00:00Z")
        # serving a warm cache shells out to nothing (this is the whole point)
        self.assertEqual(self.fake.calls, [])


class TestRds(Base):
    USER_DN = "CN=alice,CN=Users,DC=ad,DC=edt1,DC=lab"
    GROUP_DN = "CN=Terminal Server License Servers,CN=Builtin,DC=ad,DC=edt1,DC=lab"

    def _group_found(self):
        self.fake.on(lambda a: "ldbsearch" in a and any("objectSid=S-1-5-32-561" in x for x in a),
                     out="dn: %s\n" % self.GROUP_DN)

    def _user_found(self):
        self.fake.on(lambda a: "ldbsearch" in a and any("(objectCategory=person)" in x for x in a),
                     out="dn: %s\n" % self.USER_DN)

    def _dsacl_get(self, has_ace):
        # The delegation Samba stamps per-user: RPWP on the TS-license property set.
        ace = "(OA;;RPWP;5805bc62-bdc9-4428-a5e2-856a0f4c185e;;S-1-5-32-561)" if has_ace else ""
        self.fake.on(lambda a: "dsacl" in a and "get" in a,
                     out="descriptor for %s:\nO:BAG:BAD:(A;;RPWP;;;WD)%s\n" % (self.USER_DN, ace))

    def _schema_and_scp(self):
        self.fake.on(lambda a: "ldbsearch" in a and "-b" in a and "member" in a, out="")
        self.fake.on(lambda a: "ldbsearch" in a and any("msTSExpireDate" in x for x in a),
                     out="lDAPDisplayName: msTSExpireDate\n")
        self.fake.on(lambda a: "ldbsearch" in a and any("licensingSiteSettings" in x for x in a), out="")

    def test_ace_constant_targets_the_right_objects(self):
        # The remediation ACE targets the "Terminal Server License Server"
        # property set, inherited onto user objects, for the group SID.
        self.assertIn("5805bc62-bdc9-4428-a5e2-856a0f4c185e", mod.RDS_CAL_ACE)   # property set
        self.assertIn("bf967aba-0de6-11d0-a285-00aa003049e2", mod.RDS_CAL_ACE)   # user class
        self.assertIn("S-1-5-32-561", mod.RDS_CAL_ACE)                            # the group
        self.assertTrue(mod.RDS_CAL_ACE.startswith("(OA;CIIO;RPWP;"))

    def test_status_reports_group_schema_and_per_user_delegation(self):
        self.fake.lab_up(); self._group_found(); self._user_found(); self._dsacl_get(True); self._schema_and_scp()
        rc, out = self.call_main(["rds-status"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["group_present"])
        self.assertEqual(out["group_sid"], "S-1-5-32-561")
        self.assertTrue(out["per_user_cal_schema"])
        self.assertTrue(out["per_user_delegation"])       # Samba stamps it per-user by default
        self.assertEqual(out["site_license_scps"], [])

    def test_ensure_is_a_noop_when_delegation_present(self):
        self.fake.lab_up(); self._group_found(); self._user_found(); self._dsacl_get(True)
        rc, out = self.call_main(["rds-ensure"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["delegation_ace_added"])
        self.assertTrue(out["per_user_delegation"])
        self.assertEqual(self.fake.argv_containing("dsacl", "set"), [])   # no SD write on a healthy lab

    def test_ensure_remediates_only_a_genuine_gap(self):
        self.fake.lab_up(); self._group_found(); self._user_found(); self._dsacl_get(False)
        self.fake.on(lambda a: "dsacl" in a and "set" in a, out="")
        rc, out = self.call_main(["rds-ensure"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["delegation_ace_added"])
        self.assertTrue(self.fake.argv_containing("dsacl", "set", "--sddl", mod.RDS_CAL_ACE))

    def test_ensure_refuses_if_group_missing(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a and any("objectSid=S-1-5-32-561" in x for x in a), out="")
        rc, out = self.call_main(["rds-ensure"])
        self.assertEqual(rc, 1)
        self.assertIn("561", out["error"])

    def test_add_server_verifies_then_joins_group(self):
        self.fake.lab_up(); self._group_found(); self._user_found(); self._dsacl_get(True)
        self.fake.on(lambda a: "group" in a and "addmembers" in a, out="Added members")
        rc, out = self.call_main(["rds-add-server", "--server", "RDLIC01$"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["added"], "RDLIC01$")
        self.assertTrue(self.fake.argv_containing("group", "addmembers",
                                                  "Terminal Server License Servers", "RDLIC01$"))


class TestRdsSitePublish(Base):
    """rds-publish-site / rds-site-permission / rds-unpublish-site: register a
    site's Enterprise license server (licensingSiteSettings.siteServer) and grant
    the server write-siteServer so it can maintain its own registration."""

    SITE_DN = "CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab"
    SS_DN = "CN=Licensing Site Settings," + SITE_DN
    COMP_DN = "CN=ws2025-mem2,CN=Computers,DC=ad,DC=edt1,DC=lab"
    COMP_SID = "S-1-5-21-1299215473-3033484451-2070441001-3769"

    def _site_found(self):
        # site resolution: (objectClass=site) under CN=Sites
        self.fake.on(lambda a: "ldbsearch" in a and any("(objectClass=site)" in x for x in a),
                     out="dn: %s\nname: Default-First-Site-Name\n" % self.SITE_DN)

    def _computer_found(self):
        self.fake.on(lambda a: "ldbsearch" in a and any("objectClass=computer" in x for x in a),
                     out="dn: %s\nobjectSid: %s\n" % (self.COMP_DN, self.COMP_SID))

    def _no_site_settings(self):
        self.fake.on(lambda a: "ldbsearch" in a and any("licensingSiteSettings" in x for x in a),
                     out="")

    def _site_settings(self, site_server=None):
        ldif = "dn: %s\ncn: Licensing Site Settings\n" % self.SS_DN
        if site_server:
            ldif += "siteServer: %s\n" % site_server
        self.fake.on(lambda a: "ldbsearch" in a and any("licensingSiteSettings" in x for x in a),
                     out=ldif)

    def _dsacl_perm(self, present):
        ace = "(OA;;WP;%s;;%s)" % (mod.RDS_SITESERVER_ATTR_GUID, self.COMP_SID) if present else ""
        self.fake.on(lambda a: "dsacl" in a and "get" in a,
                     out="descriptor for %s:\nO:BAG:BAD:(A;;RPWP;;;WD)%s\n" % (self.SS_DN, ace))

    def _writes_ok(self):
        self.fake.on(lambda a: "ldbadd" in a, out="")
        self.fake.on(lambda a: "ldbmodify" in a, out="")
        self.fake.on(lambda a: "dsacl" in a and "set" in a, out="")
        self.fake.on(lambda a: "ldbdel" in a, out="")

    def _stdin_of(self, *words):
        for argv, stdin in self.fake.calls:
            if all(w in " ".join(map(str, argv)) for w in words):
                return stdin
        return None

    # -- publish ----------------------------------------------------------
    def test_publish_creates_object_sets_siteserver_and_grants_permission(self):
        self.fake.lab_up(); self._site_found(); self._computer_found()
        self._no_site_settings(); self._dsacl_perm(False); self._writes_ok()
        rc, out = self.call_main(["rds-publish-site", "--server", "ws2025-mem2"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["created"])
        self.assertEqual(out["site"], "Default-First-Site-Name")
        self.assertEqual(out["site_settings_dn"], self.SS_DN)
        self.assertEqual(out["site_server"], self.COMP_DN)
        self.assertTrue(out["permission_added"])
        # the object was created with class, cn and siteServer, in one ldbadd
        add = self._stdin_of("ldbadd")
        self.assertIn("objectClass: licensingSiteSettings", add)
        self.assertIn("cn: Licensing Site Settings", add)
        self.assertIn("siteServer: %s" % self.COMP_DN, add)
        # and the site-level permission is a WP-on-siteServer ACE for the computer SID
        self.assertTrue(self.fake.argv_containing(
            "dsacl", "set", "--sddl", mod._rds_site_permission_ace(self.COMP_SID)))
        self.assertTrue(out["permission_ace"].startswith("(OA;;WP;%s;;" % mod.RDS_SITESERVER_ATTR_GUID))

    def test_publish_accepts_dollar_and_dn_forms(self):
        for server in ("ws2025-mem2$", self.COMP_DN):
            self.setUp()
            self.fake.lab_up(); self._site_found(); self._computer_found()
            self._no_site_settings(); self._dsacl_perm(False); self._writes_ok()
            rc, out = self.call_main(["rds-publish-site", "--server", server])
            self.assertEqual(rc, 0, out)
            self.assertEqual(out["site_server"], self.COMP_DN)

    def test_publish_is_idempotent_when_already_correct(self):
        self.fake.lab_up(); self._site_found(); self._computer_found()
        self._site_settings(self.COMP_DN); self._dsacl_perm(True); self._writes_ok()
        rc, out = self.call_main(["rds-publish-site", "--server", "ws2025-mem2"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["created"])
        self.assertFalse(out["site_server_changed"])
        self.assertFalse(out["permission_added"])
        # a no-op writes nothing
        self.assertEqual(self.fake.argv_containing("ldbadd"), [])
        self.assertEqual(self.fake.argv_containing("ldbmodify"), [])
        self.assertEqual(self.fake.argv_containing("dsacl", "set"), [])

    def test_publish_repoints_siteserver_when_wrong(self):
        self.fake.lab_up(); self._site_found(); self._computer_found()
        self._site_settings("CN=old-ls,CN=Computers,DC=ad,DC=edt1,DC=lab")
        self._dsacl_perm(True); self._writes_ok()
        rc, out = self.call_main(["rds-publish-site", "--server", "ws2025-mem2"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["created"])                 # object already existed
        self.assertTrue(out["site_server_changed"])
        self.assertEqual(self.fake.argv_containing("ldbadd"), [])
        mod_ldif = self._stdin_of("ldbmodify")
        self.assertIn("replace: siteServer", mod_ldif)
        self.assertIn("siteServer: %s" % self.COMP_DN, mod_ldif)

    def test_publish_site_by_name(self):
        self.fake.lab_up(); self._site_found(); self._computer_found()
        self._no_site_settings(); self._dsacl_perm(False); self._writes_ok()
        rc, out = self.call_main(["rds-publish-site", "--server", "ws2025-mem2",
                                  "--site", "Default-First-Site-Name"])
        self.assertEqual(rc, 0, out)
        # the site filter carried the requested name
        self.assertTrue(any("(cn=Default-First-Site-Name)" in x
                            for argv, _ in self.fake.calls for x in argv))

    # -- status -----------------------------------------------------------
    def test_status_reports_published_server(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "ldbsearch" in a and any("objectSid=S-1-5-32-561" in x for x in a),
                     out="dn: CN=Terminal Server License Servers,CN=Builtin,DC=ad,DC=edt1,DC=lab\n")
        self.fake.on(lambda a: "ldbsearch" in a and "-b" in a and "member" in a, out="")
        self.fake.on(lambda a: "ldbsearch" in a and any("msTSExpireDate" in x for x in a),
                     out="lDAPDisplayName: msTSExpireDate\n")
        self.fake.on(lambda a: "ldbsearch" in a and any("(objectCategory=person)" in x for x in a),
                     out="dn: CN=alice,CN=Users,DC=ad,DC=edt1,DC=lab\n")
        self.fake.on(lambda a: "dsacl" in a and "get" in a,
                     out="O:BAG:BAD:(A;;RPWP;;;WD)(OA;;RPWP;5805bc62-bdc9-4428-a5e2-856a0f4c185e;;S-1-5-32-561)\n")
        self.fake.on(lambda a: "ldbsearch" in a and any("licensingSiteSettings" in x for x in a),
                     out="dn: %s\nsiteServer: %s\n" % (self.SS_DN, self.COMP_DN))
        rc, out = self.call_main(["rds-status"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["site_license_scps"], [self.SS_DN])
        self.assertEqual(out["site_license_servers"],
                         [{"site_settings_dn": self.SS_DN, "site_server": self.COMP_DN}])

    # -- site-permission --------------------------------------------------
    def test_site_permission_requires_object(self):
        self.fake.lab_up(); self._site_found(); self._computer_found(); self._no_site_settings()
        rc, out = self.call_main(["rds-site-permission", "--server", "ws2025-mem2"])
        self.assertEqual(rc, 1)
        self.assertIn("rds-publish-site", out["error"])

    def test_site_permission_grants_and_is_idempotent(self):
        self.fake.lab_up(); self._site_found(); self._computer_found()
        self._site_settings(self.COMP_DN); self._dsacl_perm(False); self._writes_ok()
        rc, out = self.call_main(["rds-site-permission", "--server", "ws2025-mem2"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["permission_added"])
        self.assertTrue(self.fake.argv_containing(
            "dsacl", "set", "--sddl", mod._rds_site_permission_ace(self.COMP_SID)))
        # already present -> no dsacl set
        self.setUp()
        self.fake.lab_up(); self._site_found(); self._computer_found()
        self._site_settings(self.COMP_DN); self._dsacl_perm(True); self._writes_ok()
        rc, out = self.call_main(["rds-site-permission", "--server", "ws2025-mem2"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["permission_added"])
        self.assertEqual(self.fake.argv_containing("dsacl", "set"), [])

    # -- unpublish --------------------------------------------------------
    def test_unpublish_deletes_object(self):
        self.fake.lab_up(); self._site_found(); self._site_settings(self.COMP_DN); self._writes_ok()
        rc, out = self.call_main(["rds-unpublish-site"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["removed"])
        self.assertTrue(self.fake.argv_containing("ldbdel", self.SS_DN))

    def test_unpublish_is_noop_when_absent(self):
        self.fake.lab_up(); self._site_found(); self._no_site_settings(); self._writes_ok()
        rc, out = self.call_main(["rds-unpublish-site"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["removed"])
        self.assertEqual(self.fake.argv_containing("ldbdel"), [])


class DecodeOdjTests(unittest.TestCase):
    """_decode_odj is the last place a bad offline-join blob can be caught.

    Windows Setup's offlineServicing pass logs "Successfully applied settings
    override to component Microsoft-Windows-UnattendedJoin" for having WRITTEN
    the settings into the image, not for having joined anything. A blob the OS
    later rejects produces no error on the machine and no error in AD — it just
    boots into a workgroup — so every assertion about blob validity has to
    happen here or nowhere.
    """

    @staticmethod
    def _ndr(payload=b"\x01\x02\x03\x04", objlen=None, ver=1, endian=0x10,
             hdrlen=8, filler=b"\xcc\xcc\xcc\xcc"):
        """Build an NDR type-serialization v1 stream (MS-RPCE 2.2.6)."""
        if objlen is None:
            objlen = len(payload)
        return (bytes([ver, endian]) + struct.pack("<H", hdrlen) + filler
                + struct.pack("<I", objlen) + b"\x00\x00\x00\x00" + payload)

    @staticmethod
    def _savefile(blob_b64):
        """Wrap as djoin/samba write it: UTF-16LE, BOM, NUL-terminated, wrapped."""
        wrapped = "\r\n".join(blob_b64[i:i + 64] for i in range(0, len(blob_b64), 64))
        return base64.b64encode((b"\xff\xfe"
                                 + (wrapped + "\x00").encode("utf-16-le"))).decode()

    def test_round_trip_strips_bom_nul_and_wrapping(self):
        inner = base64.b64encode(self._ndr(b"A" * 200)).decode()
        self.assertEqual(mod._decode_odj(self._savefile(inner)), inner)

    def test_empty_blob_rejected(self):
        empty = base64.b64encode(b"\xff\xfe" + "\x00".encode("utf-16-le")).decode()
        with self.assertRaises(mod.Fail) as c:
            mod._decode_odj(empty)
        self.assertIn("empty", str(c.exception))

    def test_not_base64_rejected(self):
        with self.assertRaises(mod.Fail) as c:
            mod._decode_odj(self._savefile("not!valid!base64!"))
        self.assertIn("not valid base64", str(c.exception))

    def test_too_short_rejected(self):
        short = base64.b64encode(b"\x01\x10\x08\x00").decode()
        with self.assertRaises(mod.Fail) as c:
            mod._decode_odj(self._savefile(short))
        self.assertIn("too short", str(c.exception))

    def test_wrong_ndr_header_rejected(self):
        # Valid base64, right length, wrong structure: the case that used to
        # sail through and fail invisibly inside Windows Setup.
        bad = base64.b64encode(self._ndr(filler=b"\x00\x00\x00\x00")).decode()
        with self.assertRaises(mod.Fail) as c:
            mod._decode_odj(self._savefile(bad))
        self.assertIn("not NDR type-serialization v1", str(c.exception))

    def test_truncated_payload_rejected(self):
        # objlen claims more than the stream carries.
        bad = base64.b64encode(self._ndr(b"A" * 8, objlen=64)).decode()
        with self.assertRaises(mod.Fail) as c:
            mod._decode_odj(self._savefile(bad))
        self.assertIn("truncated", str(c.exception))

    def test_truncated_by_exactly_eight_bytes_rejected(self):
        """Pins an off-by-eight: the payload begins at 16, not 8.

        The object header (2.2.6.3) is eight bytes and objlen is its first
        field, so comparing objlen against len(raw)-8 counts the header itself
        as payload and accepts a stream that is short by exactly the header.
        """
        bad = base64.b64encode(self._ndr(b"A" * 8, objlen=16)).decode()
        with self.assertRaises(mod.Fail) as c:
            mod._decode_odj(self._savefile(bad))
        self.assertIn("truncated", str(c.exception))

    def test_exact_length_payload_accepted(self):
        """The boundary the check must NOT reject: objlen == bytes present."""
        inner = base64.b64encode(self._ndr(b"A" * 32, objlen=32)).decode()
        self.assertEqual(mod._decode_odj(self._savefile(inner)), inner)


class LinuxAdmx(unittest.TestCase):
    """The generated adsys-style Ubuntu Linux ADMX + its faceting."""

    def setUp(self):
        self.admx, self.adml = mod.linux_admx_generate()
        self.d = tempfile.mkdtemp()
        open(os.path.join(self.d, "Ubuntu.admx"), "w").write(self.admx)
        os.makedirs(os.path.join(self.d, "en-US"))
        open(os.path.join(self.d, "en-US", "Ubuntu.adml"), "w").write(self.adml)

    def tearDown(self):
        import shutil
        shutil.rmtree(self.d, ignore_errors=True)

    def test_generated_admx_is_lint_clean_and_self_contained(self):
        # No external category dependency (upstream all/Ubuntu.admx <using>s a base
        # file -- ours must stand alone), single namespace, zero lint errors.
        r = mod.admx_lint(self.d, "en-US")
        self.assertEqual(r["errors"], [], r["errors"])
        self.assertEqual(r["namespaces"], 1)
        self.assertEqual(r["files"], 1)

    def test_policies_parse_and_every_name_resolves(self):
        pols = mod.parse_admx(self.admx)
        self.assertGreaterEqual(len(pols), 20)
        strings = mod.parse_adml(self.adml)
        for p in pols:
            self.assertIn(p["id"], strings, "no ADML string for %s" % p["id"])
            self.assertTrue(strings[p["id"]], p["id"])

    def test_every_key_is_under_the_ubuntu_root(self):
        for p in mod.parse_admx(self.admx):
            self.assertTrue(p["key"].startswith("Software\\Policies\\Ubuntu"),
                            "%s -> %s" % (p["id"], p["key"]))

    def test_mix_of_machine_and_user_and_element_kinds(self):
        pols = {p["id"]: p for p in mod.parse_admx(self.admx)}
        self.assertEqual(pols["ScriptsStartup"]["class"], "Machine")
        self.assertEqual(pols["ScriptsLogon"]["class"], "User")
        self.assertTrue(pols["DconfScreensaverLock"]["has_enabled"])   # bool toggle
        kinds = {e["kind"] for p in pols.values() for e in p["elements"]}
        self.assertTrue({"text", "decimal", "multiText"} <= kinds, kinds)

    def test_derive_tags_recognises_ubuntu_adsys_as_linux(self):
        self.assertEqual(mod._derive_tags("admx", "Ubuntu.admx")[0], "Linux")
        self.assertIn("ubuntu", mod._derive_tags("admx", "Ubuntu.admx")[1])
        self.assertEqual(mod._derive_tags("admx", "adsys-custom.admx")[0], "Linux")
        self.assertEqual(mod._derive_tags("admx", "Canonical.Foo.admx")[0], "Linux")
        # regression: Windows ADMX still Windows
        self.assertEqual(mod._derive_tags("admx", "Explorer.admx")[0], "Windows")

    def test_is_linux_regkey(self):
        self.assertTrue(mod._is_linux_regkey("Software\\Policies\\Ubuntu\\dconf"))
        self.assertTrue(mod._is_linux_regkey("software/policies/ubuntu"))   # fwd slash + case
        self.assertTrue(mod._is_linux_regkey("SOFTWARE\\POLICIES\\GNOME\\x"))
        self.assertFalse(mod._is_linux_regkey("Software\\Policies\\Microsoft\\Windows"))
        self.assertFalse(mod._is_linux_regkey(""))


MINI_WIN_ADMX = ('<policyDefinitions revision="1.0" schemaVersion="1.0" '
    'xmlns="http://schemas.microsoft.com/GroupPolicy/2006/07/PolicyDefinitions">'
    '<policyNamespaces><target prefix="win" namespace="MS.Win"/></policyNamespaces>'
    '<resources minRequiredRevision="1.0"/><categories/>'
    '<policies><policy name="PolWin" class="Machine" displayName="$(string.x)" '
    'key="Software\\Policies\\MS" valueName="v"/></policies></policyDefinitions>')


class AdmxApply(Base):
    """The import-apply step that lands a staged batch in the SYSVOL central
    store. Its load-bearing property: additive by default -- it must NOT act on
    admx_plan's retirements (which treat the batch as authoritative for the WHOLE
    store) unless retirement is explicitly requested."""

    def setUp(self):
        super().setUp()
        self.work = tempfile.mkdtemp()
        self._ow = (mod.ADMX_WORK, mod.ADMX_STATE, mod.ADMX_STAGING)
        mod.ADMX_WORK = self.work
        mod.ADMX_STATE = os.path.join(self.work, "state.json")
        mod.ADMX_STAGING = os.path.join(self.work, "staging")
        # a store holding ONE Windows file, so the Ubuntu-only batch's plan would
        # (wrongly, if acted on) retire it.
        self.fake.lab_up()
        b64win = _base64.b64encode(MINI_WIN_ADMX.encode()).decode()
        self.fake.on(lambda a: "ls" in " ".join(map(str, a)) and "*.admx" in " ".join(map(str, a)),
                     out="/var/lib/samba/sysvol/ad.edt1.lab/Policies/PolicyDefinitions/Explorer.admx\n")
        self.fake.on(lambda a: "base64 -w0" in " ".join(map(str, a)) and "Explorer.admx" in " ".join(map(str, a)),
                     out=b64win + "\n")
        self.fake.on(lambda a: "base64 -w0" in " ".join(map(str, a)), out="")   # adml reads: none
        self.fake.on(lambda a: "base64 -d" in " ".join(map(str, a)), out="")    # writes succeed

    def tearDown(self):
        import shutil
        mod.ADMX_WORK, mod.ADMX_STATE, mod.ADMX_STAGING = self._ow
        shutil.rmtree(self.work, ignore_errors=True)
        super().tearDown()

    def _stage_ubuntu(self):
        admx, adml = mod.linux_admx_generate()
        src = tempfile.mkdtemp()
        open(os.path.join(src, "Ubuntu.admx"), "w").write(admx)
        os.makedirs(os.path.join(src, "en-US"))
        open(os.path.join(src, "en-US", "Ubuntu.adml"), "w").write(adml)
        res, ok = mod._stage_admx_dir("lin", src, "en-US")
        self.assertTrue(ok, res)
        return res

    def test_additive_apply_writes_batch_and_never_retires(self):
        self._stage_ubuntu()
        res = mod._apply_admx_batch("lin", retire=False)
        self.assertTrue(res["applied"])
        self.assertEqual(res["written"], ["Ubuntu.admx"])
        self.assertEqual(res["retired"], [])
        # the plan DID compute a retirement for the unrelated Windows file...
        self.assertIn("Explorer.admx", res["plan"]["retire"])
        # ...but additive apply must not have written any *_retired file.
        self.assertEqual(self.fake.argv_containing("Explorer_retired"), [])
        # it DID push the Ubuntu ADMX into the store.
        self.assertTrue(self.fake.argv_containing("base64 -d", "Ubuntu.admx"))

    def test_apply_is_idempotent(self):
        self._stage_ubuntu()
        mod._apply_admx_batch("lin", retire=False)
        again = mod._apply_admx_batch("lin", retire=False)
        self.assertFalse(again["applied"])
        self.assertIn("already applied", again.get("reason", ""))

    def test_seed_verb_generates_stages_and_applies(self):
        rc, out = self.call_main(["gpo-linux-seed"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out.get("seeded"))
        self.assertEqual(out["admx"], "Ubuntu.admx")
        self.assertEqual(out["retired"], [])
        self.assertGreaterEqual(out["policies"], 20)


class TestPki(Base):
    """AD PKI: CA node, AD directory publish, templates, issuance."""

    def _body(self, argv):
        for i, x in enumerate(argv):
            if x == "-c" and i + 1 < len(argv):
                return argv[i + 1]
        return ""

    # ---- pure encoders, locked against MS-verified octet values ----
    def test_filetime_encoding(self):
        self.assertEqual(mod._filetime_b64(2 * 365 * 86400), "AIByDl3C/f8=")
        self.assertEqual(mod._filetime_b64(6 * 7 * 86400), "AICmCv/e//8=")

    def test_keyusage_is_two_bytes(self):
        self.assertEqual(mod._keyusage_b64("digitalSignature,keyEncipherment"), "oAA=")
        self.assertEqual(mod._keyusage_b64("digitalSignature"), "gAA=")

    def test_template_oid_unique_and_stable(self):
        a0 = mod._template_oid("ad.edt1.lab", 0)
        a1 = mod._template_oid("ad.edt1.lab", 1)
        self.assertNotEqual(a0, a1)
        self.assertEqual(a0, mod._template_oid("ad.edt1.lab", 0))
        self.assertTrue(a0.startswith("1.3.6.1.4.1.311.21.8."))

    def test_template_ldif_shape(self):
        ldif = mod._template_ldif("WebServer", mod.PKI_TEMPLATES["WebServer"])
        self.assertIn("objectClass: pKICertificateTemplate", ldif)
        self.assertIn("CN=WebServer,CN=Certificate Templates,CN=Public Key Services,", ldif)
        self.assertIn("pKIKeyUsage:: oAA=", ldif)
        self.assertIn("pKIExtendedKeyUsage: 1.3.6.1.5.5.7.3.1", ldif)   # serverAuth
        self.assertIn("msPKI-Certificate-Name-Flag: 1", ldif)          # enrollee supplies subject
        self.assertIn("msPKI-Template-Schema-Version: 2", ldif)

    # ---- deploy ----
    def test_ca_deploy_runs_container_and_inits(self):
        f = self.fake
        f.on(lambda a: a[:2] == ["podman", "inspect"] and "adlab-ca" in a, rc=1)  # missing
        f.on(lambda a: a[:2] == ["podman", "run"] and "adlab-ca" in a, out="cid\n")
        f.on(lambda a: a[:2] == ["podman", "exec"] and "adlab-ca" in a, out="created\n")
        f.lab_up()
        rc, out = self.call_main(["pki-ca-deploy"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["root"], "created")
        runs = f.argv_containing("podman", "run", "adlab-ca")
        self.assertTrue(runs)
        self.assertTrue(any(mod.PRIMARY_LAB["IMG_DC"] in x for x in runs[0]))

    # ---- template seed ----
    def test_template_seed_ldbadds_each(self):
        f = self.fake
        f.on(lambda a: "ldbsearch" in a and "-s" in a and "base" in a, rc=1)  # none exist
        f.on(lambda a: "ldbadd" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["pki-template-seed"])
        self.assertEqual(rc, 0, out)
        created = [s for s in out["seeded"] if s["action"] == "created"]
        self.assertEqual(len(created), len(mod.PKI_TEMPLATES))
        adds = [c for c in f.calls if "ldbadd" in c[0]]
        self.assertTrue(adds and all("pKICertificateTemplate" in (c[1] or "") for c in adds))

    # ---- publish to AD ----
    def test_ca_publish_creates_ad_objects(self):
        f, b = self.fake, self._body
        f.on(lambda a: "exec" in a and "adlab-ca" in a and "gencrl" in b(a), out="Q1JMREVS\n")
        f.on(lambda a: "exec" in a and "adlab-ca" in a and "RFC2253" in b(a),
             out="subject=CN=AD.EDT1.LAB Enterprise Root CA,O=EDT1 Lab\n")
        f.on(lambda a: "exec" in a and "adlab-ca" in a and "test -f" in b(a), rc=0)
        f.on(lambda a: "exec" in a and "adlab-ca" in a and "outform DER" in b(a), out="ZGVy\n")
        f.on(lambda a: "ldbsearch" in a, rc=1)     # nothing exists yet / no templates
        f.on(lambda a: "ldbadd" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["pki-ca-publish"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(len(out["steps"]), 4)
        self.assertTrue(all(s["action"] == "created" for s in out["steps"]))
        joined = " ".join((c[1] or "") for c in f.calls if "ldbadd" in c[0])
        self.assertIn("objectClass: certificationAuthority", joined)
        self.assertIn("objectClass: pKIEnrollmentService", joined)
        self.assertIn("cn: NTAuthCertificates", joined)
        # certificationAuthority mustContain: the CRL attrs are supplied at create
        self.assertIn("authorityRevocationList:: ", joined)
        self.assertIn("certificateRevocationList:: ", joined)

    # ---- issuance ----
    def test_issue_signs_leaf_per_template(self):
        f, b = self.fake, self._body
        f.on(lambda a: "exec" in a and "adlab-ca" in a and "test -f" in b(a), rc=0)
        f.on(lambda a: "exec" in a and "adlab-ca" in a and "x509 -req" in b(a),
             out="-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n")
        f.lab_up()
        rc, out = self.call_main(["pki-issue", "--template", "WebServer",
                                  "--cn", "web01.ad.edt1.lab",
                                  "--sans", "DNS:web01.ad.edt1.lab"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["template"], "WebServer")
        self.assertIn("BEGIN CERTIFICATE", out["cert_pem"])
        # the same body generates the CSR and signs it; assert the template's EKU
        # reached the openssl extfile
        signed = [b(c[0]) for c in f.calls if "x509 -req" in b(c[0])]
        self.assertTrue(signed)
        self.assertIn("extendedKeyUsage=1.3.6.1.5.5.7.3.1", signed[0])   # serverAuth


DELEG_LDIF = """dn: CN=DC1,OU=Domain Controllers,DC=ad,DC=edt1,DC=lab
sAMAccountName: DC1$
userAccountControl: 532480
objectClass: computer

dn: CN=edy-adweb,CN=Users,DC=ad,DC=edt1,DC=lab
sAMAccountName: edy-adweb
userAccountControl: 16777216
msDS-AllowedToDelegateTo: ldap/dc1.ad.edt1.lab
objectClass: user

dn: CN=web01,CN=Computers,DC=ad,DC=edt1,DC=lab
sAMAccountName: web01$
userAccountControl: 4096
msDS-AllowedToActOnBehalfOfOtherIdentity:: AQID
objectClass: computer
"""


class TestDelegation(Base):
    """S4U / delegation + Protected Users + authentication policies."""

    def test_delegation_list_classifies_and_ranks(self):
        f = self.fake
        f.on(lambda a: "ldbsearch" in a and "userAccountControl" in a
                       and "msDS-AllowedToDelegateTo" in a, out=DELEG_LDIF)
        f.lab_up()
        rc, out = self.call_main(["delegation-list"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["count"], 3)
        by = {r["account"]: r for r in out["accounts"]}
        self.assertTrue(by["DC1$"]["unconstrained"])
        self.assertEqual(by["DC1$"]["risk"], "high")
        self.assertIn("constrained+protocol-transition", by["edy-adweb"]["kinds"])
        self.assertEqual(by["edy-adweb"]["allowed_to"], ["ldap/dc1.ad.edt1.lab"])
        self.assertTrue(by["web01$"]["rbcd"])
        self.assertIn("rbcd-target", by["web01$"]["kinds"])
        # high-risk sorts first
        self.assertEqual(out["accounts"][0]["account"], "DC1$")

    def _fake_account(self, sam):
        # _spn_account/_deleg_sam does an ldbsearch whose filter embeds the name;
        # return a matching entry (match on the bare name inside the filter).
        bare = sam.rstrip("$")
        self.fake.on(lambda a: "ldbsearch" in a and "servicePrincipalName" in a
                     and any(bare in str(x) for x in a),
                     out="dn: CN=%s,CN=Users,DC=ad,DC=edt1,DC=lab\nsAMAccountName: %s\n" % (bare, sam))

    def test_set_unconstrained_calls_samba_tool(self):
        f = self.fake
        self._fake_account("web01$")
        f.on(lambda a: "samba-tool" in a and "for-any-service" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["delegation-set-unconstrained", "--account", "web01$", "--state", "on"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["unconstrained"])
        hits = f.argv_containing("delegation", "for-any-service", "web01$", "on")
        self.assertTrue(hits and "-H" in hits[0])

    def test_add_service_constrained(self):
        f = self.fake
        self._fake_account("edy-adweb")
        f.on(lambda a: "samba-tool" in a and "add-service" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["delegation-add-service", "--account", "edy-adweb",
                                  "--service", "cifs/fs01.ad.edt1.lab"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["added_service"], "cifs/fs01.ad.edt1.lab")
        self.assertTrue(f.argv_containing("delegation", "add-service", "cifs/fs01.ad.edt1.lab"))

    def test_rbcd_add_principal(self):
        f = self.fake
        self._fake_account("web01$")
        self._fake_account("app01$")
        f.on(lambda a: "samba-tool" in a and "add-principal" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["rbcd-add", "--account", "web01$", "--principal", "app01$"])
        self.assertEqual(rc, 0, out)
        self.assertEqual(out["added_principal"], "app01$")

    def test_protected_users_add(self):
        f = self.fake
        f.on(lambda a: "samba-tool" in a and "addmembers" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["protected-users-add", "--member", "alice"])
        self.assertEqual(rc, 0, out)
        hits = f.argv_containing("group", "addmembers", "Protected Users", "alice")
        self.assertTrue(hits)

    def test_authpolicy_create_defaults_to_audit(self):
        f = self.fake
        f.on(lambda a: "samba-tool" in a and "policy" in a and "create" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["authpolicy-create", "--name", "P1"])
        self.assertEqual(rc, 0, out)
        self.assertFalse(out["enforced"])
        hits = f.argv_containing("auth", "policy", "create", "--audit")
        self.assertTrue(hits)
        self.assertFalse(any("--enforce" in h for h in hits))

    def test_authpolicy_create_enforce(self):
        f = self.fake
        f.on(lambda a: "samba-tool" in a and "policy" in a and "create" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["authpolicy-create", "--name", "P2", "--enforce", "true",
                                  "--tgt_lifetime_mins", "240"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(out["enforced"])
        self.assertTrue(f.argv_containing("auth", "policy", "create", "--enforce"))
        self.assertTrue(f.argv_containing("--user-tgt-lifetime-mins", "240"))

    def test_authsilo_create_binds_policies(self):
        f = self.fake
        f.on(lambda a: "samba-tool" in a and "silo" in a and "create" in a, out="")
        f.lab_up()
        rc, out = self.call_main(["authsilo-create", "--name", "S1",
                                  "--user_policy", "P1", "--enforce", "true"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(f.argv_containing("silo", "create", "--user-authentication-policy", "P1"))
        self.assertTrue(f.argv_containing("silo", "create", "--enforce"))


GPOED_ADMX = """<?xml version="1.0"?>
<policyDefinitions>
  <policyNamespaces>
    <target prefix="test" namespace="Test.Policies"/>
    <using prefix="windows" namespace="Microsoft.Policies.Windows"/>
  </policyNamespaces>
  <categories>
    <category name="Root" displayName="$(string.Root)"/>
    <category name="Child" displayName="$(string.Child)"><parentCategory ref="test:Root"/></category>
  </categories>
  <policies>
    <policy name="DecPol" class="Machine" displayName="$(string.DecPol)" explainText="$(string.DecPolHelp)" presentation="$(presentation.DecPol)" key="Software\\Test">
      <parentCategory ref="test:Child"/>
      <supportedOn ref="windows:SUPPORTED_Windows7"/>
      <elements><decimal id="DecEl" valueName="DecVal" minValue="1" maxValue="100"/></elements>
    </policy>
    <policy name="EnumPol" class="Machine" displayName="$(string.EnumPol)" key="Software\\Test">
      <parentCategory ref="test:Child"/>
      <elements>
        <enum id="EnumEl" valueName="EnumVal">
          <item displayName="$(string.Opt0)"><value><decimal value="0"/></value></item>
          <item displayName="$(string.Opt1)"><value><decimal value="1"/></value></item>
        </enum>
      </elements>
    </policy>
    <policy name="BoolPol" class="Machine" displayName="$(string.BoolPol)" key="Software\\Test" valueName="BoolBase">
      <parentCategory ref="test:Root"/>
      <elements><boolean id="BoolEl" valueName="BoolVal"><trueValue><decimal value="1"/></trueValue><falseValue><decimal value="0"/></falseValue></boolean></elements>
    </policy>
    <policy name="ListPol" class="Machine" displayName="$(string.ListPol)" key="Software\\Test">
      <parentCategory ref="test:Root"/>
      <elements><list id="ListEl" key="Software\\Test\\List" valuePrefix="Item"/></elements>
    </policy>
    <policy name="ELPol" class="Machine" displayName="$(string.ELPol)" key="Software\\Test" valueName="ELBase">
      <parentCategory ref="test:Root"/>
      <enabledList><item key="Software\\Test\\EL" valueName="A"><value><decimal value="1"/></value></item></enabledList>
      <disabledList><item key="Software\\Test\\DL" valueName="B"><value><decimal value="0"/></value></item></disabledList>
    </policy>
    <policy name="KeyPol" class="Machine" displayName="$(string.KeyPol)" key="Software\\Test">
      <parentCategory ref="test:Root"/>
      <elements><text id="KeyEl" key="Software\\Other\\Sub" valueName="TVal"/></elements>
    </policy>
    <policy name="SBoolPol" class="Machine" displayName="$(string.SBoolPol)" key="Software\\Test">
      <parentCategory ref="test:Root"/>
      <elements><boolean id="SBEl" valueName="SBVal"><trueValue><string>yes</string></trueValue><falseValue><string>no</string></falseValue></boolean></elements>
    </policy>
    <policy name="ExpPol" class="Machine" displayName="$(string.ExpPol)" key="Software\\Test">
      <parentCategory ref="test:Root"/>
      <elements><list id="ExpEl" key="Software\\Test\\ExpList" valuePrefix="P" expandable="true"/></elements>
    </policy>
  </policies>
</policyDefinitions>"""

GPOED_ADML = """<?xml version="1.0"?>
<policyDefinitionResources><resources>
  <stringTable>
    <string id="Root">Root Cat</string><string id="Child">Child Cat</string>
    <string id="DecPol">Decimal Policy</string><string id="DecPolHelp">Help text.</string>
    <string id="EnumPol">Enum Policy</string><string id="Opt0">Zero</string><string id="Opt1">One</string>
    <string id="BoolPol">Bool Policy</string><string id="ListPol">List Policy</string>
    <string id="ELPol">EnabledList Policy</string><string id="KeyPol">Key Override Policy</string>
    <string id="SBoolPol">String Bool Policy</string><string id="ExpPol">Expandable List Policy</string>
  </stringTable>
  <presentationTable>
    <presentation id="DecPol"><decimalTextBox refId="DecEl" defaultValue="10">Days:</decimalTextBox></presentation>
  </presentationTable>
</resources></policyDefinitionResources>"""


class TestGpoEditor(unittest.TestCase):
    """The ADMX policy-editor pipeline: parsers, category tree, schema, compiler."""

    def _cache(self):
        strings = mod.parse_adml(GPOED_ADML)
        pols = mod.parse_admx(GPOED_ADMX)
        for p in pols:
            p["admx"] = "Test.admx"
            p["display"] = mod._resolve_ref(p["display"], strings) or p["id"]
            p["explain"] = mod._resolve_ref(p["explain"], strings)
            for el in p.get("elements", []):
                for it in el.get("items", []):
                    it["display"] = mod._resolve_ref(it["display"], strings)
            p["unresolved"] = False
        meta = mod.parse_admx_meta(GPOED_ADMX)
        for c in meta["categories"]:
            c["display"] = mod._resolve_ref(c["display"], strings) or c["name"]
        pres = mod.parse_adml_presentations(GPOED_ADML)
        return {"admx": {"Test.admx": {"policies": pols, "meta": meta, "presentations": pres}}}

    def _pol(self, pols, name):
        return next(p for p in pols if p["id"] == name)

    def test_parse_admx_elements(self):
        pols = mod.parse_admx(GPOED_ADMX)
        dec = self._pol(pols, "DecPol")["elements"][0]
        self.assertEqual((dec["kind"], dec["valuename"], dec["min"], dec["max"], dec["type"]),
                         ("decimal", "DecVal", 1, 100, "REG_DWORD"))
        enum = self._pol(pols, "EnumPol")["elements"][0]
        self.assertEqual([(i["value"], i["type"]) for i in enum["items"]],
                         [(0, "REG_DWORD"), (1, "REG_DWORD")])
        boolp = self._pol(pols, "BoolPol")
        self.assertTrue(boolp["has_enabled"])          # valueName + elements still toggles base
        self.assertEqual(boolp["elements"][0]["true_value"], 1)
        el = self._pol(pols, "ELPol")
        self.assertTrue(el["has_enabled"])
        self.assertEqual(el["enabled_list"][0], {"key": "Software\\Test\\EL", "valuename": "A",
                                                 "type": "REG_DWORD", "data": 1})

    def test_parse_meta_and_presentations(self):
        meta = mod.parse_admx_meta(GPOED_ADMX)
        self.assertEqual(meta["namespace"], "Test.Policies")
        self.assertEqual(meta["prefixes"]["windows"], "Microsoft.Policies.Windows")
        names = {c["name"]: c["parent"] for c in meta["categories"]}
        self.assertEqual(names["Child"], "test:Root")
        pres = mod.parse_adml_presentations(GPOED_ADML)["DecPol"][0]
        self.assertEqual((pres["control"], pres["refId"], pres["label"], pres["default"]),
                         ("decimalTextBox", "DecEl", "Days:", 10))

    def test_category_tree_nesting(self):
        cats, tree = mod._build_category_index(self._cache(), {})
        root = next(n for n in tree if n["name"] == "Root")
        self.assertEqual(root["display"], "Root Cat")
        child = next(c for c in root["children"] if c["name"] == "Child")
        self.assertEqual(child["display"], "Child Cat")
        # DecPol + EnumPol live under Child; Root holds the other 6
        self.assertEqual(len(child["policies"]), 2)
        self.assertEqual(root["count"], 8)             # recursive (6 direct + Child's 2)

    def test_policy_schema_merges_presentation(self):
        schema = mod._policy_schema(self._cache(), {}, "admx:Test.admx:DecPol")
        self.assertEqual(schema["explain"], "Help text.")
        el = schema["elements"][0]
        self.assertEqual((el["control"], el["label"], el["default"], el["min"], el["max"]),
                         ("decimalTextBox", "Days:", 10, 1, 100))
        enum = mod._policy_schema(self._cache(), {}, "admx:Test.admx:EnumPol")["elements"][0]
        self.assertEqual([i["display"] for i in enum["items"]], ["Zero", "One"])

    def test_compile_enabled_decimal_and_enum(self):
        cache = self._cache()
        sch = mod._policy_schema(cache, {}, "admx:Test.admx:DecPol")
        load, remove = mod._compile_policy(sch, "enabled", {"DecEl": 42}, "MACHINE")
        self.assertEqual(load, [{"keyname": "Software\\Test", "valuename": "DecVal",
                                 "class": "MACHINE", "type": "REG_DWORD", "data": 42}])
        sch = mod._policy_schema(cache, {}, "admx:Test.admx:EnumPol")
        load, _ = mod._compile_policy(sch, "enabled", {"EnumEl": 1}, "MACHINE")
        self.assertEqual(load[0]["data"], 1)
        self.assertEqual(load[0]["type"], "REG_DWORD")

    def test_compile_boolean_base_plus_element(self):
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:BoolPol")
        load, _ = mod._compile_policy(sch, "enabled", {"BoolEl": False}, "MACHINE")
        by = {e["valuename"]: e["data"] for e in load}
        self.assertEqual(by["BoolBase"], 1)            # base on/off written
        self.assertEqual(by["BoolVal"], 0)             # unchecked -> false_value

    def test_compile_list_indexed(self):
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:ListPol")
        load, _ = mod._compile_policy(sch, "enabled", {"ListEl": ["aaa", "bbb"]}, "MACHINE")
        self.assertEqual([(e["keyname"], e["valuename"], e["data"]) for e in load],
                         [("Software\\Test\\List", "Item1", "aaa"),
                          ("Software\\Test\\List", "Item2", "bbb")])

    def test_compile_enabledlist_and_notconfigured(self):
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:ELPol")
        load, _ = mod._compile_policy(sch, "enabled", {}, "MACHINE")
        vns = {(e["keyname"], e["valuename"]): e["data"] for e in load}
        self.assertEqual(vns[("Software\\Test\\EL", "A")], 1)      # enabledList row
        self.assertEqual(vns[("Software\\Test", "ELBase")], 1)     # base implicit-enable
        _l, remove = mod._compile_policy(sch, "notconfigured", {}, "MACHINE")
        pairs = {(r["keyname"], r["valuename"]) for r in remove}
        self.assertIn(("Software\\Test", "ELBase"), pairs)
        self.assertIn(("Software\\Test\\EL", "A"), pairs)

    def test_compile_required_element_missing(self):
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:DecPol")
        sch["elements"][0]["required"] = True
        with self.assertRaises(mod.Fail):
            mod._compile_policy(sch, "enabled", {}, "MACHINE")

    def test_compile_element_key_override(self):
        # Regression [1]: an element's own key must be honored, not the policy key.
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:KeyPol")
        load, _ = mod._compile_policy(sch, "enabled", {"KeyEl": "hello"}, "MACHINE")
        self.assertEqual(load[0]["keyname"], "Software\\Other\\Sub")
        self.assertEqual((load[0]["valuename"], load[0]["data"]), ("TVal", "hello"))

    def test_compile_opposite_state_lists_removed(self):
        # Regression [3]: switching state must remove the other state's list rows.
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:ELPol")
        _l, rem = mod._compile_policy(sch, "enabled", {}, "MACHINE")   # removes disabled_list
        self.assertIn(("Software\\Test\\DL", "B"), {(r["keyname"], r["valuename"]) for r in rem})
        _l, rem = mod._compile_policy(sch, "disabled", {}, "MACHINE")  # removes enabled_list
        self.assertIn(("Software\\Test\\EL", "A"), {(r["keyname"], r["valuename"]) for r in rem})

    def test_compile_string_boolean_type(self):
        # Regression [5]: a string trueValue/falseValue must write REG_SZ.
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:SBoolPol")
        load, _ = mod._compile_policy(sch, "enabled", {"SBEl": True}, "MACHINE")
        e = [x for x in load if x["valuename"] == "SBVal"][0]
        self.assertEqual((e["type"], e["data"]), ("REG_SZ", "yes"))

    def test_compile_expandable_list_type(self):
        # Regression [6]: an expandable list writes REG_EXPAND_SZ rows.
        sch = mod._policy_schema(self._cache(), {}, "admx:Test.admx:ExpPol")
        load, _ = mod._compile_policy(sch, "enabled", {"ExpEl": ["x"]}, "MACHINE")
        self.assertEqual(load[0]["type"], "REG_EXPAND_SZ")
        self.assertEqual((load[0]["keyname"], load[0]["valuename"]), ("Software\\Test\\ExpList", "P1"))


class TestContainers(Base):
    """Container supervisor (retry + backoff), controls, classification."""

    def _state(self, name, st):
        # ctr_state does `podman inspect <name> --format {{.State.Status}}`
        self.fake.on(lambda a, n=name: a[:2] == ["podman", "inspect"]
                     and a and a[-1] == "{{.State.Status}}" and n in a, out=st + "\n")

    def _lab(self):
        # lab_up + "no additional forests" (TestContainers doesn't inherit TestDomains)
        self.fake.on(lambda a: a[:3] == ["podman", "ps", "-a"]
                     and any("{{.Names}}\t" in x for x in a), out="")
        self.fake.lab_up()

    def _sup_state(self):
        try:
            return json.load(open(mod.CTR_SUPERVISOR_FILE))
        except Exception:
            return {}

    def _act(self, out, name):
        return next(a for a in out["actions"] if a["name"] == name)

    def test_classify_and_managed(self):
        self.assertEqual(mod._classify_container("dc1"), "dc")
        self.assertEqual(mod._classify_container("ad2-dc1"), "dc")
        self.assertEqual(mod._classify_container("client3"), "client")
        self.assertEqual(mod._classify_container("rdp1"), "rdp")
        self.assertEqual(mod._classify_container("adlab-ca"), "ca")
        self.assertIsNone(mod._classify_container("edy-proxy-go"))
        self.assertIsNone(mod._classify_container("harbor-net"))

    def test_supervise_retry_schedules_backoff(self):
        self._state("dc3", "exited")
        self.fake.on(lambda a: a[:2] == ["podman", "start"] and "dc3" in a, rc=1, err="boom")
        self._lab()
        rc, out = self.call_main(["container-supervise"])
        self.assertEqual(rc, 0, out)
        act = self._act(out, "dc3")
        self.assertEqual((act["action"], act["attempts"], act["next_try_in"]),
                         ("retry-scheduled", 1, 60))          # +1 minute
        self.assertEqual(self._sup_state()["dc3"]["attempts"], 1)

    def test_supervise_starts_down_container(self):
        self._state("dc3", "exited")
        self.fake.on(lambda a: a[:2] == ["podman", "start"] and "dc3" in a, rc=0)
        self._lab()
        rc, out = self.call_main(["container-supervise"])
        self.assertEqual(self._act(out, "dc3")["action"], "started")
        # retry state cleared, but the cumulative auto-start count is kept
        self.assertEqual(self._sup_state()["dc3"], {"starts": 1})

    def test_supervise_start_count_accumulates(self):
        self._state("dc3", "exited")
        self.fake.on(lambda a: a[:2] == ["podman", "start"] and "dc3" in a, rc=0)
        self._lab()
        mod._write_supervisor_state({"dc3": {"starts": 1}})   # already auto-started once
        rc, out = self.call_main(["container-supervise"])
        self.assertEqual(self._act(out, "dc3")["total_starts"], 2)
        self.assertEqual(self._sup_state()["dc3"]["starts"], 2)

    def test_stop_parks_before_podman_stop(self):
        # The HIGH fix: park must be persisted BEFORE `podman stop` so the timer
        # can't race in during the shutdown and restart the container.
        seen = {}
        def run(argv, stdin=None, timeout=120):
            self.fake.calls.append((list(argv), stdin))
            if argv[:2] == ["podman", "stop"] and "dc4" in argv:
                try:
                    seen["parked"] = json.load(open(mod.CTR_SUPERVISOR_FILE)).get("dc4", {}).get("parked")
                except Exception:
                    seen["parked"] = None
                return 0, "", ""
            if argv[:2] == ["podman", "inspect"]:
                return 0, "running\n", ""
            return 0, "", ""
        mod.RUN = type("R", (), {"run": staticmethod(run)})()
        rc, out = self.call_main(["container-stop", "--name", "dc4"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(seen.get("parked"))     # parked on disk at the moment of stop

    def test_supervise_backoff_then_giveup(self):
        self._state("dc3", "exited")
        self.fake.on(lambda a: a[:2] == ["podman", "start"] and "dc3" in a, rc=1)
        self._lab()
        mod._write_supervisor_state({"dc3": {"attempts": 2, "next_try": mod.time.time() + 300}})
        rc, out = self.call_main(["container-supervise"])
        self.assertEqual(self._act(out, "dc3")["action"], "backoff")  # not yet due
        mod._write_supervisor_state({"dc3": {"attempts": 5, "next_try": 0}})
        rc, out = self.call_main(["container-supervise"])
        self.assertEqual(self._act(out, "dc3")["action"], "gave-up")

    def test_supervise_backoff_increments_per_attempt(self):
        self._state("dc3", "exited")
        self.fake.on(lambda a: a[:2] == ["podman", "start"] and "dc3" in a, rc=1)
        self._lab()
        mod._write_supervisor_state({"dc3": {"attempts": 1, "next_try": 0}})  # due
        rc, out = self.call_main(["container-supervise"])
        act = self._act(out, "dc3")
        self.assertEqual((act["attempts"], act["next_try_in"]), (2, 120))     # +2 minutes

    def test_supervise_recovers_running(self):
        self._lab()             # dc3 running
        mod._write_supervisor_state({"dc3": {"attempts": 3, "next_try": 0}})
        rc, out = self.call_main(["container-supervise"])
        self.assertEqual(self._act(out, "dc3")["action"], "recovered")
        self.assertNotIn("dc3", self._sup_state())

    def test_stop_parks_container(self):
        self.fake.on(lambda a: a[:2] == ["podman", "stop"] and "dc4" in a, rc=0)
        self._lab()
        rc, out = self.call_main(["container-stop", "--name", "dc4"])
        self.assertEqual(rc, 0, out)
        self.assertTrue(self._sup_state()["dc4"]["parked"])

    def test_parked_container_not_restarted(self):
        self._state("dc4", "exited")
        self._lab()
        mod._write_supervisor_state({"dc4": {"attempts": 5, "parked": True, "next_try": 0}})
        rc, out = self.call_main(["container-supervise"])
        self.assertEqual(self._act(out, "dc4")["action"], "parked")
        self.assertFalse(self.fake.argv_containing("podman", "start", "dc4"))

    def test_start_clears_retry_state(self):
        self.fake.on(lambda a: a[:2] == ["podman", "start"] and "dc4" in a, rc=0)
        self._lab()
        mod._write_supervisor_state({"dc4": {"attempts": 3, "parked": True}})
        rc, out = self.call_main(["container-start", "--name", "dc4"])
        self.assertEqual(rc, 0, out)
        self.assertNotIn("dc4", self._sup_state())

    def test_reset_clears_state(self):
        mod._write_supervisor_state({"dc3": {"attempts": 2}})
        self.fake.lab_up()
        rc, out = self.call_main(["container-supervise-reset", "--name", "dc3"])
        self.assertTrue(out["was_tracked"])
        self.assertNotIn("dc3", self._sup_state())

    def test_control_rejects_non_lab_container(self):
        self.fake.lab_up()
        rc, out = self.call_main(["container-start", "--name", "harbor-net"])
        self.assertEqual(rc, 1)
        self.assertIn("not a lab-managed", out["error"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
