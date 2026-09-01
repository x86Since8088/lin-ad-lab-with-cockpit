# Viewing and inspecting the samba-ad-lab directory from edt1

Tooling for looking **into** the 5-DC `AD.EDT1.LAB` forest from the host, without
joining the host to it. Everything here is read-only against the directory.

```
./install-tools.sh      # as root, via submit-job.sh — installs and configures
./inspect.sh ticket     # get a Kerberos ticket without typing a password
./inspect.sh            # the full sweep
./inspect.sh web        # browser UI on http://127.0.0.1:8389/
./inspect.sh help       # every section and action
```

---

## The three things that decide how everything else works

**1. The host is not domain-joined and its resolver is 8.8.8.8.**
GSSAPI authenticates to a *name*, not an address: the service principal is
`ldap/dc1.ad.edt1.lab@AD.EDT1.LAB`. Point a tool at `172.15.4.10` and it tries to
build `ldap/172.15.4.10`, which does not exist, and the bind fails. So the DC
names must resolve locally — see *Host changes* below.

**2. These DCs run `ldap server require strong auth = Yes`.**
A simple bind on port 389 is refused outright:

```
ldap_bind: Strong(er) authentication required (8)
        additional info: BindSimple: Transport encryption required.
```

That leaves exactly three ways in:

| method | port | works |
|---|---|---|
| SASL/GSSAPI (Kerberos) | 389 | yes — this is what everything here uses |
| simple bind over LDAPS | 636 | yes, if you trust the self-signed CA |
| simple bind over StartTLS | 389 | yes, same caveat |
| simple bind, plaintext | 389 | **refused** |

Anonymous gets you the RootDSE and nothing else. Every real query needs a ticket.

**3. `samba-tool` cannot authenticate over `ldap://` on Ubuntu.** See below.

---

## The `samba-tool` trap

`samba-tool <cmd> -H ldap://dc1.ad.edt1.lab` fails on this host no matter how you
authenticate:

```
ERROR(ldb): uncaught exception - 00002020: Operation unavailable without authentication
```

This is not a credential problem. Ubuntu builds Samba against the **system ldb**,
whose LDAP backend (`/usr/lib/x86_64-linux-gnu/samba/ldb/ldap.so`) is plain
OpenLDAP and ignores Samba's credentials object entirely. Every bind it makes is
anonymous. Verified against all of these, all of which failed identically:

- `-k yes`
- `--use-kerberos=required`
- `--use-kerberos=required --use-krb5-ccache=$KRB5CCNAME`
- `--use-kerberos=required -U Administrator`
- `--authentication-file=<file>` (i.e. a **simple bind** with the real password)

The last one is the proof: it is not Kerberos that is broken, it is the whole
credential path. `ldbsearch -H ldap://…` fails the same way and has no
authentication options at all.

**What that means in practice:**

| want | use |
|---|---|
| any LDAP query, authenticated | `ldapsearch -Y GSSAPI` (or `ldapvi`, or `ldap-web.py`) |
| Samba-flavoured LDAP query | `net ads search` — Samba's own client, honours Kerberos |
| `samba-tool` LDAP subcommands (`user list`, `fsmo show`, `drs showrepl`, `gpo`) | `podman exec dc1 samba-tool …` |
| `samba-tool` RPC/CLDAP subcommands (`domain info`, `dns query`) | works from the host |

`inspect.sh` avoids the container round-trip wherever it can. FSMO roles come
from reading `fSMORoleOwner` over LDAP, and replication health comes from
decoding each DC's `repsFrom` attribute with `python3-samba` — the same data
`samba-tool drs showrepl` prints, obtained without touching a container.

---

## CLI tools

### `ldapsearch` (ldap-utils) — the one that actually works

The only tool on the host that does an authenticated LDAP bind to these DCs.

```console
$ kinit Administrator@AD.EDT1.LAB
$ ldapsearch -LLL -Y GSSAPI -H ldap://dc1.ad.edt1.lab \
    -b "OU=Domain Controllers,DC=ad,DC=edt1,DC=lab" "(objectClass=computer)" dNSHostName
SASL/GSSAPI authentication started
SASL username: Administrator@AD.EDT1.LAB
SASL SSF: 256
SASL data security layer installed.
dn: CN=DC1,OU=Domain Controllers,DC=ad,DC=edt1,DC=lab
dNSHostName: dc1.ad.edt1.lab
dn: CN=DC2,OU=Domain Controllers,DC=ad,DC=edt1,DC=lab
dNSHostName: dc2.ad.edt1.lab
…
```

`SASL SSF: 256` is the point — the connection is Kerberos-sealed, which is why
no TLS is needed on 389.

### `krb5-user` — kinit/klist

`./inspect.sh gssapi` is the end-to-end proof. It shows the TGT, performs the
SASL bind, then shows the `ldap/…` **service** ticket that the bind caused the
KDC to issue:

```
Ticket cache: FILE:/run/user/1000/krb5cc_ad_edt1_lab
Default principal: Administrator@AD.EDT1.LAB
SASL/GSSAPI authentication started
SASL username: Administrator@AD.EDT1.LAB
SASL SSF: 256
dn: DC=ad,DC=edt1,DC=lab
service ticket now in the cache:
08/27/2026 10:39:19  08/27/2026 20:35:35  ldap/dc1.ad.edt1.lab@AD.EDT1.LAB
```

Simple bind proves LDAP works. Only this proves Kerberos works.

### `ldapvi` — interactive, and the safe way to edit

Pulls a result set into `$EDITOR` as LDIF and writes back only what you changed;
quitting without edits changes nothing. Speaks GSSAPI natively. Needs `$TERM`
set or it refuses to start (`inspect.sh` handles that).

```console
$ ldapvi --out -h ldap://dc1.ad.edt1.lab -b "CN=Users,DC=ad,DC=edt1,DC=lab" \
    --sasl-mech GSSAPI "(objectClass=group)" cn description
dn: CN=Domain Controllers,CN=Users,DC=ad,DC=edt1,DC=lab
cn: Domain Controllers
description: All domain controllers in the domain
```

`--out` dumps and exits; drop it for the interactive editor. `./inspect.sh edit`.

### `smbclient` and `net` — SMB and Samba's own LDAP client

`net ads search` is the one Samba client path on the host that really does use
the ticket:

```console
$ net ads search -s smb.lab.conf --use-kerberos=required -S dc1.ad.edt1.lab \
    "(sAMAccountName=Administrator)" sAMAccountName objectSid whenCreated
Got 1 replies
whenCreated: 20260827150014.0Z
objectSid: S-1-5-21-1299215473-3033484451-2070441001-500
sAMAccountName: Administrator
```

```console
$ smbclient -s smb.lab.conf --use-kerberos=required //dc1.ad.edt1.lab/sysvol -c 'cd ad.edt1.lab; ls'
  scripts                             D        0  Thu Aug 27 10:00:12 2026
  Policies                            D        0  Thu Aug 27 10:39:22 2026
  probe.txt                           A       19  Thu Aug 27 10:29:40 2026
```

Both need `-s smb.lab.conf` — see *Why `smb.lab.conf` exists* below.

### `python3-samba` — the decoder

LDAP hands back the interesting attributes as base64 NDR blobs. `python3-samba`
unpacks them. `addecode.py` wraps this:

```console
$ ./inspect.sh entry "CN=DC1,OU=Domain Controllers,DC=ad,DC=edt1,DC=lab"
objectGUID: e34aa255-6db9-4dcf-a1d8-15d356340cf0
objectSid: S-1-5-21-1299215473-3033484451-2070441001-1000
userAccountControl: 0x00082000  SERVER_TRUST_ACCOUNT TRUSTED_FOR_DELEGATION
pwdLastSet: 134323164145002785 (2026-08-27 15:00:14Z)
nTSecurityDescriptor: owner=…-512 group=…-512 aces=47
    O:S-1-5-21-…D:AI(A;;CCDCLCSWRPWPDTLOCRSDRCWDWO;;;…)…
```

The same library decodes `repsFrom`, which is how `./inspect.sh repl` reports
replication health with no container access:

```
  dc1.ad.edt1.lab
      <- DC2    last success 2026-08-27 15:48:01Z  failures=0  WERR_OK
      <- DC3    last success 2026-08-27 15:48:01Z  failures=0  WERR_OK
      <- DC4    last success 2026-08-27 15:48:01Z  failures=0  WERR_OK
  …
  worst consecutive failure count across all links: 0
```

Note: `python3-samba`'s **RPC** path (`samba.dcerpc.samr` over `ncacn_np`) fails
against these DCs with `NT_STATUS_INVALID_PARAMETER` at bind time, from both a
default and a lab `smb.conf`. `samba.net.Net.finddc()` (CLDAP) does work. The
decode functions, which is what this repo actually relies on, work fine.

### `ldb-tools` — offline only

`ldbsearch` cannot authenticate over `ldap://` (same backend problem as
`samba-tool`, and it has no auth options at all). Its real use is **offline**:
copy a partition file out of a DC and search it with no network and no
credentials at all.

```console
$ ./inspect.sh offline
   (objectClass=user)       525
   (objectClass=computer)   16
   (objectClass=group)      88
   browse it with:  ldbsearch -H /tmp/adlab-offline/domain.ldb '(sAMAccountName=dc1$)'
```

This reads `sam.ldb.d/DC=AD,DC=EDT1,DC=LAB.ldb` directly, so it needs none of
Samba's dsdb ldb modules. Nothing is written into the container.

*(`objectClass=user` returns 525 here but `inspect.sh users` reports 505 — both
are right. `computer` is a subclass of `user`, so the raw count includes the 16
machine accounts; the live query filters with `objectCategory=person`.)*

---

## GUI: the honest state on Ubuntu 26.04

Short version: **desktop GUI LDAP tooling on modern Ubuntu is a graveyard.** One
package survives, and it is thirteen years old.

| candidate | verdict |
|---|---|
| **Apache Directory Studio** | Best tool in the category. **Not packaged** in Debian or Ubuntu — upstream ships a tarball only. Needs a manual download plus a JRE. Rejected: nothing to `apt install`, and downloading and executing a third-party tarball is a decision for you, not for a setup script. If you want it, the JRE is already installed as a JXplorer dependency, so it is just untar-and-run. |
| **JXplorer** | **Installed.** The only packaged desktop LDAP browser left. Java Swing, upstream dormant since ~2013, but it launches cleanly on OpenJDK 25 under XWayland and renders correctly. Caveats below. |
| **gq** | Removed from the archive. Dead. |
| **luma**, **lbe**, **directory-administrator** | Not in the archive. Dead (PyQt3 / GTK1 era). |
| **phpLDAPadmin** | Packaged as 1.2.6.7 — upstream is from the PHP 5/7 era. The packaged code still calls `create_function()` and `get_magic_quotes_runtime()`, both **removed in PHP 8.0**, and Ubuntu 26.04 ships PHP 8.5. It also drags in Apache. Rejected. |
| **ldap-account-manager** | 9.0, genuinely maintained, PHP 8 clean, has AD modules. But it is 48 packages including Apache and a full PHP stack, and it is an account *management* app, not an inspection tool. Rejected as disproportionate for "view and inspect" — reach for it if you later want real web-based user administration. |
| **Cockpit plugin** | Nothing exists today, but this is the right place to build one. See below. |
| **`ldap-web.py`** (in this directory) | **Written and working.** Covers the actual need with no new packages at all. |

### `ldap-web.py` — the browser UI that works

~350 lines of Python standard library. No node, no npm, no PHP, no Apache, no
build step. It shells out to `ldapsearch -Y GSSAPI`, so it authenticates as
whoever ran it using their existing ticket, and it never handles a password. It
binds to `127.0.0.1` only. It is read-only — there is no write path in the file.

```console
$ ./inspect.sh web
directory browser for DC=ad,DC=edt1,DC=lab
  http://127.0.0.1:8389/
```

Left pane is a lazy-loading tree, right pane shows the entry with SIDs, GUIDs and
security descriptors decoded through `python3-samba`. The filter box takes a raw
LDAP filter. Verified returning live data:

```console
$ curl -s 'http://127.0.0.1:8389/api/children?dn=DC%3Dad%2CDC%3Dedt1%2CDC%3Dlab' | head
[{"dn":"CN=Builtin,DC=ad,DC=edt1,DC=lab","rdn":"CN=Builtin","kind":"builtindomain",…

$ curl -s 'http://127.0.0.1:8389/api/entry?dn=CN%3DAdministrator%2CCN%3DUsers%2C…'
objectSid   S-1-5-21-1299215473-3033484451-2070441001-500
objectGUID  217936de-d483-466e-849f-1ce6f9973ff4
memberOf    CN=Domain Admins,…; CN=Schema Admins,…; CN=Enterprise Admins,…
```

### JXplorer — installed, with caveats

It works, but know these before you reach for it:

- **It cannot use port 389.** These DCs refuse simple binds without encryption,
  and JXplorer's GSSAPI level needs JAAS wiring that is not set up here. Use
  **LDAPS on 636**.
- Its startup log shows `unable to load new security provider:
  com.sun.net.ssl.internal.ssl.Provider` — a class removed from the JDK years
  ago. TLS still works through the platform default, but you must supply the
  truststore yourself.
- `install-tools.sh` builds `dc-ca.jks` from the five DCs' own auto-generated CA
  certs for exactly this. Password `changeit`.

`./inspect.sh gui` prints the settings and launches it:

```
Host      dc1.ad.edt1.lab
Port      636
Protocol  LDAP v3
Base DN   DC=ad,DC=edt1,DC=lab
Level     SSL + User + Password
User DN   CN=Administrator,CN=Users,DC=ad,DC=edt1,DC=lab
```
then Security > Trusted Servers and CAs > `dc-ca.jks`.

Verified: launches on OpenJDK 25 under XWayland and renders its full UI. The
connection itself has to be made by hand — synthetic X input does not reach
Java Swing windows under this compositor, so it could not be driven headlessly
to prove a live bind. `ldap-web.py` is the GUI that is proven end to end.

### Is Cockpit the right home for a directory view? Yes — worth building.

Cockpit is already installed and running on `:9090`, and this host already has
two hand-written plugins (`/usr/share/cockpit/wireguard`, `.../headscale`), so
the pattern is established and proven here.

It fits well:

- A Cockpit plugin is **plain static HTML/CSS/JS plus a `manifest.json`**. No
  build toolchain, no node, no npm — which matters given the 428-package cost of
  node that has been avoided all along.
- `cockpit.spawn()` would run exactly the `ldapsearch -Y GSSAPI` commands that
  already work, so the backend is done.
- Cockpit brings authentication (PAM), TLS, and remote access for free, which
  `ldap-web.py` deliberately does not have — it is loopback-only.
- `manifest.json` supports a `conditions` gate, so the plugin could show itself
  only when the lab tooling is present, the same way the WireGuard plugin gates
  on `path-exists: /usr/bin/wg`.

The one thing to solve first is credentials: Cockpit authenticates you as
*your* Unix user, and that user needs a Kerberos ticket for the lab. Either
reuse the `inspect.sh ticket` approach, or have the plugin prompt and `kinit`.
Recommendation: build it, reusing `ldap-web.py`'s LDIF parsing and
`addecode.py`'s decoders as the model — the hard parts are already solved and
tested here.

---

## Host changes made (all reversible)

Two, both marked and both undone by one command:

```bash
./install-tools.sh --revert-resolution
```

**1. `/etc/hosts`** — a marked block mapping `dc1..dc5.ad.edt1.lab` and
`ad.edt1.lab` to their `172.15.4.x` addresses. This is the smallest change that
makes GSSAPI possible: it affects only these six names, survives reboots and
podman network churn, and leaves every other lookup going to 8.8.8.8. The FQDN
is deliberately first on each line so that **reverse** lookups canonicalise to
the same name — OpenLDAP canonicalises the target host before building the SPN,
and gets it wrong otherwise. A backup is left at `/etc/hosts.samba-ad-lab.bak`.

`systemd-resolved` split-DNS (`resolvectl dns br-static-edt 172.15.4.10` plus
`resolvectl domain br-static-edt '~ad.edt1.lab'`) would also work and would add
SRV-record discovery, but it is runtime-only state that podman can wipe, and it
makes the host meaningfully more domain-aware. `/etc/hosts` was the smaller,
more durable choice.

**2. `/etc/krb5.conf.d/ad-edt1-lab.conf`** — a drop-in naming the five KDCs
explicitly, plus a `[domain_realm]` mapping. `/etc/krb5.conf` already had
`default_realm = AD.EDT1.LAB` but no `[realms]` entry, and SRV discovery
(`_kerberos._udp.ad.edt1.lab`) cannot work through 8.8.8.8. The distribution's
`krb5.conf` is untouched; reverting is deleting one file.

**Not changed:** `/etc/resolv.conf`, systemd-resolved, `/etc/samba/smb.conf`,
and the domain itself. The host is not joined and no computer account exists
for it.

### Why `smb.lab.conf` exists

The host's real `/etc/samba/smb.conf` is a standalone SMB **file server** config:
`workgroup = WORKGROUP`, `security = user`, and no `realm`. Samba's client
credential code reads that file to decide which realm to get a ticket for; with
no realm it silently gives up on Kerberos and binds anonymously.

Rather than edit a production config on a host that is serving files,
`smb.lab.conf` is a client-side config passed explicitly with `--configfile`
(samba-tool, net) or `-s` (smbclient). Nothing reads it unless you point a tool
at it, and `smbd` never sees it.

---

## Credentials

The admin password lives at `/opt/sc/git/samba-ad-lab/.secrets/administrator.pass`,
root-only, mode 600. Nothing here prints it, and nothing here ever puts it on a
command line — `/proc/<pid>/cmdline` is world-readable.

`./inspect.sh ticket` submits a root job that reads the file, runs `kinit` with
the password on **stdin**, and hands back a **ticket** owned by you at
`/run/user/$UID/krb5cc_ad_edt1_lab`. You get ten hours of access without the
password ever being disclosed, echoed, or passed as an argument. `inspect.sh`
picks that cache up automatically.

If you would rather type it: `kinit Administrator@AD.EDT1.LAB`.

---

## Files

| file | what it is |
|---|---|
| `install-tools.sh` | installs packages, writes the two host config changes, builds the TLS trust bundles. Idempotent. `--check`, `--no-gui`, `--revert-resolution`. Needs root — run via `submit-job.sh`. |
| `inspect.sh` | the read-only view. `./inspect.sh help` lists every section and action. |
| `addecode.py` | decodes NDR blobs (SID, GUID, security descriptor, `repsFrom`) and `userAccountControl`/NT-time fields out of LDIF. |
| `ldap-web.py` | the loopback web directory browser. Stdlib only. |
| `smb.lab.conf` | client-side Samba config giving the client tools a realm. Never read by `smbd`. |
| `dc-ca.pem` | the five DCs' CA certs, for OpenLDAP (`LDAPTLS_CACERT`) and `openssl`. |
| `dc-ca.jks` | the same, as a Java truststore for JXplorer. Password `changeit`. |

Both trust bundles are regenerated by `install-tools.sh`; the DC certs expire
2028-07-27, and are re-created if a DC is ever rebuilt, so re-run it if LDAPS
verification starts failing.

## Known gotcha

`submit-job.sh --wait` **always exits 1**, even for a job that succeeded — its
EXIT trap ends on a false test and bash lets the trap's status become the
script's. `inspect.sh` therefore checks for the artefact a job was meant to
produce rather than trusting its exit status. Do the same in anything else you
write against the job runner, until the runner is fixed.
