# SYSVOL replication and Group Policy on a multi-DC Samba forest

**Samba does not replicate SYSVOL. It never has.** It implements neither DFS-R
nor the older FRS, the two mechanisms Windows uses. DRS replicates the
*directory* — the GPO objects in LDAP — and nothing at all replicates the
*files* those objects point at.

The Samba wiki says so in its own first sentence:

> "Samba in its current state doesn't support SysVol replication via DFS-R
> (Distributed File System Replication) or the older FRS (File Replication
> Service) used in Windows Server 2000/2003 for Sysvol replication."
> — [SysVol replication (DFS-R)](https://wiki.samba.org/index.php/SysVol_replication_(DFS-R))

This is not an edge case you might hit. It is a standing operational
obligation that begins the moment you join a second DC, and it is silent:
nothing warns you, nothing logs an error, and `samba-tool drs showrepl`
reports perfect health while SYSVOL is completely divergent.

Checked against **Samba 4.23.6** on this lab. There is no `samba-tool sysvol`
subcommand, and the 4.21, 4.22, 4.23.0 and 4.23.11 release notes contain zero
matches for `sysvol`, `dfs-r`, `dfsr`, `gpupdate` or `group polic`.

---

## 1. What this lab actually looked like

Five DCs, `dc1`–`dc5`, realm `AD.EDT1.LAB`, provisioned by `20-up.sh`: `dc1`
provisions, `dc2`–`dc5` join with `samba-tool domain join`. Every acceptance
check in `30-verify.sh` passed. Replication was healthy in both directions on
all five.

Every DC agreed there were two GPOs:

```
dc1  2 GPOs known via LDAP
dc2  2 GPOs known via LDAP
dc3  2 GPOs known via LDAP
dc4  2 GPOs known via LDAP
dc5  2 GPOs known via LDAP
```

Only one of them had the files:

```
dc1  2 files, 2 policy dirs
dc2  0 files, 0 policy dirs
dc3  0 files, 0 policy dirs
dc4  0 files, 0 policy dirs
dc5  0 files, 0 policy dirs
```

`dc2`–`dc5` had `/var/lib/samba/sysvol/ad.edt1.lab/` containing nothing but an
empty `scripts/`. No `Policies/` directory at all. Not stale — **absent**.
`samba-tool domain join` does not copy SYSVOL, because on Windows DFS-R would
have done it.

The ACLs were missing too. `samba-tool ntacl sysvolcheck` on `dc1` was clean;
on the other four:

```
ERROR(<class 'OSError'>): Could not access /var/lib/samba/sysvol/ad.edt1.lab:
No data available - [Errno 61] No data available: '/var/lib/samba/sysvol/ad.edt1.lab'
```

`ENODATA` is `getxattr(2)` reporting that the `security.NTACL` extended
attribute does not exist. That xattr *is* the NT ACL — Samba's `acl_xattr` VFS
module (`vfs objects = dfs_samba4 acl_xattr`, set automatically by the AD DC
role) stores the security descriptor there. No xattr, no ACL. This is Samba
[bug 9202](https://bugzilla.samba.org/show_bug.cgi?id=9202), open since 2012.

So the starting position was: **four of five domain controllers were serving
an empty SYSVOL while telling every client the GPOs existed.**

---

## 2. The idmap trap — why a naive `rsync` is worse than no rsync

This is the part that bites people, and it is worth being precise about.

SYSVOL's permissions live in two places. The NT ACL, in the `security.NTACL`
xattr, is expressed in **SIDs** and is portable between DCs. The POSIX ACL,
which is what the kernel actually enforces, is expressed in **numeric uids and
gids** drawn from Samba's `idmap.ldb` — the `3000000+` xid range.

`idmap.ldb` lives in `private/`. It is a local LDB, not an AD partition, so
**DRS does not replicate it**, and each DC allocates xids first-come
first-served in whatever order it happens to look SIDs up. The Samba wiki is
blunt about the consequence:

> "Because of the way 'idmap.ldb' works, you cannot guarantee that each DC will
> use the same ID for a given user or group."

On this lab, `./sysvol-idmap-sync.sh --check` found that of `dc1`'s 34
mappings, **21 conflicted on dc2 and 18 on each of dc3, dc4 and dc5**:

```
S-1-5-11    dc1=3000003  dc2=3000012      # Authenticated Users
S-1-5-18    dc1=3000002  dc2=3000017      # SYSTEM
S-1-1-0     dc1=3000014  dc2=3000005      # Everyone
```

The correct SYSVOL ACL, as SDDL, is:

```
O:LAG:BAD:P(A;OICI;FA;;;BA)(A;OICI;0x1200a9;;;SO)(A;OICI;FA;;;SY)(A;OICI;0x1200a9;;;AU)
```

Administrators full, Server Operators read/execute, SYSTEM full, Authenticated
Users read/execute.

Copy that with `rsync -aAX` (the flags the Samba wiki gives) from `dc1` to a
pristine `dc3`, and the POSIX ACL arrives verbatim — `user:3000001:r-x`,
`user:3000002:rwx`, `user:3000003:r-x`. On `dc3` those numbers mean
`BUILTIN\Users`, `BUILTIN\Guests` and `Guest`. Asking `dc3` what its own POSIX
ACL grants:

```
O:LAG:BAD:(A;OICI;FA;;;LA)(A;OICI;0x1200a9;;;LG)(A;OICI;FA;;;BG)(A;OICI;0x1200a9;;;BU)...
```

**`BG` — `BUILTIN\Guests` — with `FA`, Full Access, on SYSVOL.**

### The false pass

Here is the genuinely dangerous part. Immediately after that naive rsync:

```
sysvolcheck rc=0  output=''
```

`sysvolcheck` **passed**. It is not lying, but it is not checking what you
think. On a modern DC it reads the ACL back through smbd's VFS, and
`acl_xattr` stores a hash of the POSIX ACL inside the `security.NTACL` blob.
rsync copied the blob *and* the POSIX ACL bytes together, so the hash still
matched, so smbd returned the stored descriptor — `dc1`'s — instead of
interpreting `dc3`'s numbers locally.

Delete the stored blob and ask again, and it fails instantly:

```
setfattr -x security.NTACL <path>
samba-tool ntacl sysvolcheck   →   rc=255
```

So: **`sysvolcheck` returning 0 is not sufficient evidence that a synced
SYSVOL is safe.** It will confirm a copy is self-consistent while the numbers
inside it mean something entirely different on the machine holding them. That
is why `sysvol-verify.sh` translates every xid back through each DC's own
`idmap.ldb` and compares the resulting *SIDs*, rather than trusting
`sysvolcheck` alone.

### Two correct fixes

| | What it does | Cost |
|---|---|---|
| **`sysvolreset` after every sync** (this repo's default) | Re-derives ownership and POSIX ACLs from the SIDs using the **local** idmap. `--acls` is dropped from rsync entirely. | Flattens any non-default ACL on the sysvol **root** that is not represented in AD. Per-GPO delegations survive — `set_gpos_acl()` re-derives them from each GPO's `nTSecurityDescriptor`, which DRS *does* replicate. |
| **`sysvol-idmap-sync.sh`** (upstream's answer) | Copies `idmap.ldb` from the PDC emulator so the numbers agree everywhere, making `rsync --acls` safe. | Overwrites a live local database on four DCs. Any file already owned by an old xid changes meaning at that instant. Fine on a DC whose only xattr-ACL'd data is SYSVOL; not fine on one that also serves files. |

Upstream is split on this. The wiki's rsync page never mentions
`sysvolreset`; its Talk page has a maintainer saying it *"shouln't be
necessary and will break your ACLs on the share, if it's not default"*; the
osync page runs it unconditionally. This repo defaults to the `sysvolreset`
path because it requires no surgery on a running DC, and ships the idmap tool
for the cases where preserving hand-set ACLs matters more.

---

## 3. What is here

| File | Purpose |
|---|---|
| `sysvol.env` | All tunables and, importantly, the rsync flags with the reasoning for each |
| `sysvol-lib.sh` | Shared helpers: PDC-emulator discovery, the ephemeral rsync daemon, tool bootstrap |
| `sysvol-replicate.sh` | **The replication mechanism.** PDC emulator → every other DC |
| `sysvol-verify.sh` | **The proof.** Five independent checks across all five DCs |
| `gpo-demo.sh` | Full GPO lifecycle, with the divergence made visible before and after |
| `sssd-gpo-test.sh` | Proves GPO access control really works on Linux, and what stale SYSVOL does to it |
| `sysvol-idmap-sync.sh` | The upstream `idmap.ldb` approach, with `--check` to report divergence |
| `sysvol-replicate.{service,timer}` | systemd units, 5-minute interval |
| `install-timer.sh` | Installs/removes the timer |

Everything runs **as root on the host** and reaches the DCs with `podman exec`.

### Replication design

`sysvol-replicate.sh`:

1. **Asks the directory** which DC holds the PDC emulator FSMO role and uses
   that as the single source of truth — queried, never hardcoded, so seizing
   or transferring the role moves replication with it. This matches
   Microsoft's own convention that GPMC edits target the PDC emulator.
2. Verifies the source's own SYSVOL passes `sysvolcheck`, repairing it first
   if not. It refuses to fan out a broken SYSVOL to four other DCs.
3. Starts a short-lived, **read-only** rsync daemon on the source, bound to its
   lab address and restricted to the lab subnet. Read-only means a divergent
   replica can never push its copy back.
4. Every other DC pulls:
   ```
   rsync -rlptD -X -H --delete-after --exclude=DfsrPrivate \
         rsync://<pdc>/SysVol/ /var/lib/samba/sysvol/
   ```
5. Each target runs `samba-tool ntacl sysvolreset`, then `sysvolcheck`.
6. The daemon is torn down. An `flock` prevents overlapping timer runs.

**On the flags.** `-X` is the load-bearing one: it carries `security.NTACL`,
and because that lives in the `security.*` namespace **only root can copy
it** — rsync silently drops it otherwise, and you get the ENODATA failure
above. `-A`/`--acls` and the `-o`/`-g` of `-a` are deliberately omitted for
the idmap reason; `sysvolreset` owns ownership and POSIX ACLs.
`--delete-after` rather than `--delete` so an interrupted run cannot leave a
DC half-emptied.

**On the transport.** These containers have no sshd, so the lab uses an
ephemeral `rsyncd` over the podman network. In production the transport is
ssh and the flags are identical:

```
rsync -rlptD -X -H --delete-after -e ssh root@<pdc>:/var/lib/samba/sysvol/ /var/lib/samba/sysvol/
```

The stock `Containerfile.dc` does not install `rsync`, `acl` or `attr`;
`ensure_tools()` installs them on demand so this works against the running
lab. Adding them to the image is the production-equivalent step.

### Usage

```bash
./sysvol-replicate.sh --dry-run     # show what would change
./sysvol-replicate.sh               # replicate
./sysvol-verify.sh                  # prove all five DCs agree
./install-timer.sh                  # every 5 minutes from now on
./sysvol-idmap-sync.sh --check      # report xid divergence
./gpo-demo.sh                       # full GPO lifecycle; --cleanup to undo
./sssd-gpo-test.sh                  # GPO access control on Linux clients
```

---

## 4. Verification

`sysvol-verify.sh` runs five independent checks, because no single one is
sufficient — as the false pass above shows.

1. **Content** — sha256 of every file plus the full path/type listing.
2. **NT ACLs** — `samba-tool ntacl get --as-sddl` for every path. SDDL is
   SID-based, so it *is* expected to be byte-identical everywhere.
3. **POSIX ACLs, semantically** — `getfacl`, with every numeric xid translated
   back through *that DC's own* `idmap.ldb`. The raw numbers are expected to
   differ; the SIDs behind them must not. **This is the check that catches a
   naive `rsync --acls`.**
4. **`sysvolcheck`** and **`gpo aclcheck`** clean on every DC.
5. **GPOs** — every GPO in LDAP has its directory on every DC, and `GPT.INI`'s
   `Version` matches LDAP's `versionNumber`. That version pair is what a
   client compares to decide whether to reapply a policy.

Result on this lab after replication: **27 passed, 0 failed.**

Two implementation notes worth keeping. `getfacl` orders entries by numeric
id, so the translated SIDs come out in a different order on each DC — the
comparison must sort or it fails on ordering alone. And `gpo aclcheck` needs
Administrator (`-P`, the machine account, cannot read `nTSecurityDescriptor`);
it is invoked with `PASSWD_FILE=/run/adminpass` so the password never enters
`argv` where `ps` would expose it. A Kerberos ccache does *not* work there —
`gpo aclcheck` also opens SMB to SYSVOL and gensec fails with
`No password for user principal`.

---

## 5. Group Policy on Linux: what is real and what is not

The user already knows GPO is mostly a Windows story. Here is the precise
line, tested rather than assumed.

### What genuinely works: sssd GPO access control

sssd implements **exactly one** Group Policy client-side extension — the
Security Settings CSE `{827D319E-6EAC-11D2-A4EA-00C04F79F83A}`. It reads

```
Policies/{GUID}/Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf
[Privilege Rights]
SeInteractiveLogonRight = *<SID>,*<SID>
SeRemoteInteractiveLogonRight = *<SID>
```

and uses it to decide, per PAM service, whether a user may log in. It applies
**nothing else** from a GPO — no `registry.pol`, no drive maps, no software
installation, no password policy. It is an access-control *consumer* of GPOs,
not a policy engine.

**This is on by default, and that is worth pausing on.** `ad_gpo_access_control`
defaults to `enforcing` whenever `access_provider = ad` — which the lab's
`edy-domain-install` already writes into `/etc/sssd/sssd.conf` on all ten
clients. Every one of them is already evaluating Group Policy for logon
decisions the moment sssd starts. Nothing in the lab's setup announces that.

Tested on `client1`, with the GPO temporarily linked to the domain root:

```
USER           SERVICE    DECISION
Administrator  login      ALLOW
Administrator  sshd       ALLOW
Administrator  crond      DENY  (service unmapped -> ad_gpo_default_right)
gpotest        login      ALLOW
gpotest        sshd       DENY
gpotest        crond      DENY  (service unmapped -> ad_gpo_default_right)
```

`gpotest` is in Domain Users only. `SeInteractiveLogonRight` lists Domain
Admins *and* Domain Users, so console login is allowed;
`SeRemoteInteractiveLogonRight` lists Domain Admins only, so ssh is refused.
Same user, same host, same instant — the difference is one line in a file in
SYSVOL. sssd's own log:

```
gpo_map_type: Remote Interactive
allowed_sids[0] = S-1-5-21-...-512
user_sid = S-1-5-21-...-3672
group_sids[0] = S-1-5-21-...-513
POLICY DECISION: access_granted = 0
GPO access check failed: [1432158236](Host Access Denied)
```

The PAM service maps that matter: `login, su, gdm-*, sddm, ...` →
interactive; `sshd, cockpit` → remote interactive; `ftp, samba` → network;
`crond` → batch. Anything unmapped falls through to `ad_gpo_default_right`,
which defaults to **deny** — that is why `crond` is refused above even though
no policy mentions it.

**Three sharp edges found while testing:**

- **sssd ignores BUILTIN groups.** `S-1-5-32-*` in a GPO access rule is
  silently skipped ([sssd#5063](https://github.com/SSSD/sssd/issues/5063)).
  The allow list must name real domain principals.
- **`samba-tool gpo create` leaves `gPCMachineExtensionNames` empty**, and
  sssd's CSE filter then skips the GPO entirely — the log shows it passing
  DACL filtering and then vanishing at `num_cse_filtered_gpos: 1`. Writing
  `GptTmpl.inf` into SYSVOL by hand is **not enough**; LDAP must register the
  CSE GUID pair
  `[{827D319E-6EAC-11D2-A4EA-00C04F79F83A}{803E14A0-B4FB-11D0-A0D0-00A0C90F574B}]`
  or every client ignores the policy. `gpo-demo.sh` and `sssd-gpo-test.sh`
  set it.
- **Client-side caching stacks on top of replication latency.** sssd decides
  whether to re-read a GPO by comparing `GPT.INI`'s `Version` to the version
  it cached, exactly as Windows does — and it caches the *evaluated decision*
  separately, which surviving `sss_cache -E` and wiping `gpo_cache`. After
  SYSVOL converged, `client2` still returned the old verdict until sssd was
  re-initialised. A stale replica carrying the **same version number** is
  never re-read at all.

### What stale SYSVOL does to that, measured

Both failure modes were reproduced on this lab.

**Files absent** — the state `dc2`–`dc5` were actually found in. LDAP says the
GPO exists, so sssd tries to fetch it and fails:

```
ad_gpo_parse_gpo_child_response failed: [22][Invalid argument].
Broken GPO data received from AD.
Unable to retrieve policy data: [22](Invalid argument}
GPO-based access control failed.
```

It fails **closed**. Every domain user is locked out of every mapped PAM
service on every client bound to that DC.

**Files stale** — the subtler and more dangerous case. `dc2` still serves the
policy as it was before the last edit on `dc1`:

```
DC       USER           SERVICE    DECISION
dc2      gpotest        sshd       ALLOW
dc1      gpotest        sshd       DENY
```

One domain, one user, one GPO, the same second, opposite security decisions —
settled only by which DC the client happened to bind to. Nothing logs an
error. Nothing alerts. After `sysvol-replicate.sh`, both say `DENY`.

That is the whole argument for this directory.

### What Samba offers beyond sssd — and why it is not exercised here

Samba ships `samba-gpupdate`, which implements roughly 22 client-side
extensions for Linux members: `gp_sudoers_ext` (writes `/etc/sudoers.d/`),
`gp_msgs_ext` and `vgp_motd_ext` (`/etc/motd`, `/etc/issue`), `vgp_access_ext`
(`/etc/security/access.d/`), `vgp_openssh_ext` (`/etc/ssh/sshd_config.d`),
`gp_firewalld_ext`, `gp_scripts_ext` (cron), `gp_cert_auto_enroll_ext`,
`gp_firefox_ext` / `gp_chromium_ext` (managed browser policy JSON), and
others. These are genuinely useful and genuinely apply on Linux.

**They are not demonstrated here because `samba-gpupdate` is not installed on
this lab's clients.** `Containerfile.client` installs `samba-common-bin` and
`smbclient`, neither of which ships it. Adding it would mean rebuilding and
restarting the client containers, which the brief forbade. Two further notes
if it is ever added: winbind only runs it when `apply group policies = yes`
(default `no`), and under sssd it must be driven externally, e.g. by
`oddjob-gpupdate`. The refresh interval is **90 minutes plus 0–30 random**,
per the `apply group policies` smb.conf documentation — the Group Policy wiki
page saying "90 and 120 seconds" is simply wrong.

### What could not be tested without a Windows client

The physical host is forbidden from joining the domain, and the lab has no
Windows machine. So the following were **not** verified here and should not be
assumed from this work:

- Anything driven by `registry.pol` — the entire `MACHINE\Software\Policies`
  and `USER\Software\Policies` surface. No Linux client reads it.
- Administrative Templates (ADMX/ADML). `samba-tool gpo admxload` will install
  Samba's own templates into SYSVOL, but nothing here consumes them, and
  administering Windows members additionally requires Microsoft's ADMX set.
- Logon/logoff and startup/shutdown scripts as Windows runs them, drive maps,
  folder redirection, printer deployment, software installation.
- Password and account-lockout policy **as applied to a workstation** —
  Samba's `gp_sec_ext` applies those on a DC, not on a member.
- Whether GPMC on a Windows admin station round-trips these GPOs cleanly, and
  whether editing from GPMC writes to the PDC emulator as expected.
- The real client refresh behaviour: Windows' ~90-minute refresh, `gpupdate
  /force`, and how a Windows client reacts to a version mismatch between
  `GPT.INI` and `versionNumber` across DCs.

The GPO *lifecycle* verified here — create, link to an OU and the domain,
write a policy value, version it in both LDAP and `GPT.INI`, replicate,
observe it enforced — is real. Its effect on a *Windows* client is not
something this lab can speak to.

---

## 6. The honest operational cost

Running multi-DC Samba with GPOs costs you the following, permanently.

- **A replication job you own.** It is not optional and it is not built in.
  If it stops, SYSVOL diverges silently and clients start getting different
  policy depending on which DC they bind to. Monitor the timer, not just the
  DCs.
- **A convergence window equal to your interval.** Five minutes here. DFS-R
  is change-driven and converges in seconds. For that window, a GPO edited on
  the PDC emulator is invisible on the other four DCs — and client-side
  caching stacks on top, so the real end-to-end delay is longer.
- **Single-writer discipline.** `--delete-after` from the PDC emulator means a
  GPO edited on any other DC is destroyed at the next pass, without warning.
  Every GPO edit must go to the PDC emulator. Bidirectional options (osync,
  Unison) exist, but osync is documented as tested only for two DCs — the
  wiki's own words for more than two are *"(Not tested)"* — and they carry a
  known failure mode whose warning reads *"you can end up with an empty
  sysvol folder."*
- **A hard dependency on the FSMO role.** Source of truth follows the PDC
  emulator; seizing that role after a failure means also confirming the new
  holder's SYSVOL is the good copy. If the old PDC emulator was the only DC
  with current files, seizing to a stale DC and then replicating outward
  propagates the stale copy to everyone.
- **ACL fragility.** Every tool that touches SYSVOL must preserve
  `security.NTACL` and must run as root. A backup/restore, a container
  rebuild, a well-meaning `cp -r`, an unprivileged rsync — each silently
  strips the ACLs and produces the ENODATA failure. `sysvolcheck` will not
  reliably tell you, for the reason in §2.
- **Two sources of truth that can disagree.** LDAP holds the GPO object;
  SYSVOL holds its files. DRS keeps the first consistent; only your job keeps
  the second. `versionNumber` and `GPT.INI` `Version` are the seam, and they
  are maintained by different mechanisms.

None of this is a reason not to run it. It is a reason to run the verifier on
a schedule and to treat "SYSVOL is replicated" as an assertion you test, not
one you assume.

### The demo GPO is deliberately inert

`EDT1 Lab Logon Restriction` is linked to `OU=LabWorkstations` **only**, and
that OU is empty. The GPO is a complete, verifiable artifact that restricts
nobody.

That is not fastidiousness. It was linked to the domain root at first, and
during this work a container `rdp1` joined the domain and came up running
sssd with `access_provider = ad`. A domain-root link would have applied
`SeRemoteInteractiveLogonRight = Domain Admins only` to it, and xrdp's PAM
service (`xrdp-sesman`) is in no `ad_gpo_map_*` list, so it would have fallen
through to `ad_gpo_default_right = deny`. Every non-admin RDP logon would have
started failing with no obvious cause.

To make it apply, link it deliberately:

```bash
./gpo-demo.sh --link-domain     # link to the domain root too
```

`sssd-gpo-test.sh` adds that link itself for the duration of its run and
removes it again on exit, including on Ctrl-C.

### This lab is not exclusively yours

Two things appeared during this work that nothing here created: a file
`ad.edt1.lab/probe.txt` containing `smb-write-test-270` in `dc1`'s SYSVOL, and
containers `rdp1`/`rdp2`, with `rdp1` joined to the domain as
`operatingSystem: pc-linux-gnu`. Someone or something else is building on this
domain concurrently.

That matters here specifically, because **replication is single-master with
`--delete-after`**. Anything written to SYSVOL on a DC other than the PDC
emulator is destroyed at the next pass, silently. If concurrent work needs to
put files in SYSVOL, they must go to the PDC emulator. `probe.txt` has been
replicated to all five DCs along with everything else; delete it there and
re-run replication if it is unwanted.

---

## References

- [SysVol replication (DFS-R) — SambaWiki](https://wiki.samba.org/index.php/SysVol_replication_(DFS-R))
- [Rsync based SysVol replication workaround — SambaWiki](https://wiki.samba.org/index.php/Rsync_based_SysVol_replication_workaround)
  and its [Talk page](https://wiki.samba.org/index.php/Talk:Rsync_based_SysVol_replication_workaround)
- [Bidirectional Rsync/osync based workaround — SambaWiki](https://wiki.samba.org/index.php/Bidirectional_Rsync/osync_based_SysVol_replication_workaround)
- [Group Policy — SambaWiki](https://wiki.samba.org/index.php/Group_Policy)
- [Samba bug 9202 — sysvolcheck: No data available](https://bugzilla.samba.org/show_bug.cgi?id=9202)
- [sssd-ad(5)](https://www.mankier.com/5/sssd-ad) and
  [SSSD GPO design page](https://sssd.io/design-pages/active_directory_gpo_integration.html)
- [sssd#5063 — built-in groups ignored in GPO rules](https://github.com/SSSD/sssd/issues/5063)
- `python/samba/provision/__init__.py` — `SYSVOL_ACL`, `setsysvolacl()`,
  `set_gpos_acl()`, `checksysvolacl()`
- `source4/scripting/bin/samba-gpupdate` (v4-23-stable) — the CSE list
- **lsyncd** appears nowhere in Samba's documentation. The maintained,
  documented set is rsync (unidirectional), Unison and osync (bidirectional),
  and robocopy (to Windows). Treat lsyncd as unsupported.
