# Changelog

## 1.7.1 - 2026-09-19

SPN fixes found by live validation against the lab:

- **Long SPNs were truncated.** `ldbsearch` folds attribute values longer than
  ~79 chars onto continuation lines; the SPN reads used `parse_ldif_entries`,
  which does not unfold, so GUID-based SPNs (e.g. the DRS
  `E3514235-…/…/ad.edt1.lab`) came back cut off — and `spn-query` for one then
  matched nothing. Switched `spn-list`/`spn-list-all`/`spn-query`/
  `spn-find-duplicates` to `parse_ldif_full`, which unfolds. Regression test added.
- **`spn-add --force` now works.** `samba-tool spn add` has no `--force` option,
  so the previous `-A` path errored. Force now writes `servicePrincipalName`
  directly with `ldbmodify` (bypassing the uniqueness check), which is the real
  `setspn -A` behavior.
- Removed a duplicate `_ldap_escape` the SPN block had introduced (the shared one
  is reused). 196 tests. VERSION → 1.7.1.

## 1.7.0 - 2026-09-19

Service Principal Names — a setspn-compatible control plane, a dedicated SPNs
tab, and SPN visibility on every account object.

SPNs bind a Kerberos service to the account that runs it (the `servicePrincipalName`
attribute on a user or computer). This adds first-class management mirroring
Windows `setspn.exe`, backed by samba's `spn` subcommand plus two directory reads.

- **Helper verbs (group `spn`)** — the setspn map:
  - `spn-list --account` → **setspn -L** (SPNs on one account).
  - `spn-list-all` → every user/computer that carries an SPN (powers the tab and
    the object preview).
  - `spn-add --account --spn [--force]` → **setspn -S** (add, refuses a duplicate)
    / **-A** (`--force true` skips the duplicate check). `samba-tool spn add`.
  - `spn-delete --account --spn` → **setspn -D** (`samba-tool spn delete`; danger).
  - `spn-query --spn` → **setspn -Q** (which account(s) hold an SPN; flags a
    duplicate).
  - `spn-find-duplicates` → **setspn -X** (one SPN on more than one account — the
    Kerberos-breaking case).
  Reads use `ldbsearch` (no credentials, any up DC); add/delete run `samba-tool
  spn` locally as root on the PDC emulator, like the other object writes.
- **Dedicated “SPNs” tab** — a control plane listing every account with SPNs
  (account, type, count, each SPN with a ✕ delete and a per-account “+ SPN”),
  plus toolbar Add SPN / Query SPN / Find duplicates. All schema-driven.
- **SPNs on the object** — the AD Objects preview now shows an **SPNs** section for
  ANY account that carries them (users too, not just the computer Delegation tab),
  with a link through to the SPN tab.
- 11 new unit tests (`TestSpn`); 195 total. VERSION → 1.7.0. See `docs/SPN.md`.

## 1.6.0 - 2026-09-19

OS-exclusive GPOs — a GPO is created Windows- or Linux-exclusive so a Linux
policy setting never applies on a Windows system and vice versa.

The lab serves policy to both Windows clients and Linux clients (samba-gpupdate
+ adsys). The two mechanisms one might reach for to keep a GPO's settings on one
OS do **not** hold: the Windows registry CSE writes *every* `registry.pol` entry
regardless of root key (so Linux-rooted keys are written — just inert — on
Windows; separation there is a consumption convention, not a gate), and WMI
filters fail *open* on Linux (samba-gpupdate fetches `gPCWQLFilter` but never
evaluates it; adsys ignores it; `samba-tool` cannot even create one). So
exclusivity is enforced at the **source** — the wrong-OS setting is never
allowed into the GPO. See `docs/GPO-OS-SCOPE.md`.

- **`gpo-create`** now takes a required **`os` (Windows|Linux)** and records the
  GPO's OS scope (host-side `/var/lib/adlab/gpo-os.json`, root-only, keyed by
  GUID). The schema-driven "New GPO" form gains the selector automatically.
- **`gpo-set-os`** (new) — declare or change the scope of an existing/legacy GPO
  (e.g. `Default Domain Policy`), opting it into enforcement.
- **Enforcement** (declared scope only; untyped legacy GPOs are never blocked):
  `gpo-settings-apply` and `gpo-template-stack` refuse any registry entry whose
  OS crosses the scope; `gpo-pref-set` refuses on a Windows GPO (the samba Unix
  CSE preferences are Linux-only). Settings are classified by key namespace
  (`Software\Policies\{Ubuntu,Canonical,GNOME}` = Linux; else Windows).
- **Certificate Auto-Enrollment** (`Software\Policies\Microsoft\Cryptography\
  AutoEnrollment` / `…\PolicyServers`) is Microsoft-rooted but consumed by
  Windows AND both Linux clients, so it is classed **shared** and allowed in a
  GPO of either scope — the one documented cross-OS setting.
- **UI** — the Group Policy list gains an **OS** column (a Windows/Linux badge,
  blank for untyped legacy GPOs) and a per-GPO **set OS** action; the page banner
  explains the exclusivity. **`gpo-list`/`gpo-show`** now report `os_scope`
  (`gpo-show` also *infers* one from SYSVOL when none is declared).
- 17 new unit tests (`TestGpoOsScope`); 184 total.

## 1.5.0 - 2026-09-18

Linux administrative templates in Group Policy (adsys/Ubuntu ADMX).

Windows ships no "Linux" ADMX; the Linux GPO clients define their own. The GP
editor already read the SYSVOL ADMX **central store** (`PolicyDefinitions/`) and
faceted every setting by OS type, but the store held only the Windows set plus
samba's own `GNOME_Settings.admx`/`samba.admx` — there was no representation of
the real Linux client-policy templates an operator sets (dconf, privilege/sudo,
scripts, apparmor, mounts, proxy, certificate autoenrollment). This adds that.

- **`gpo-linux-seed`** — generates a self-contained, lint-clean, adsys-faithful
  `Ubuntu.admx` (namespace `Canonical.Policies.Ubuntu`, 23 policies across 9
  categories, keys under `Software\Policies\Ubuntu`) and installs it into the
  central store on the PDC emulator. Additive and idempotent. The generator is a
  pure function in the helper (unit-tested lint-clean + self-contained), so the
  lab always has a Linux template set with no network fetch and no cross-file
  category dependency — the upstream `all/Ubuntu.admx` `<using>`s a base file and
  is a 550 KB generated blob, unfit to vendor.
- **`admx-import-apply`** — completes the ADMX import framework (which could
  `stage`/`plan` but never write). It lands a staged batch in the central store:
  **add + update by default**, and retirements (`admx_plan`'s `retire`) **only**
  with `--retire true`. This is load-bearing: `admx_plan` treats a batch as
  authoritative for the *whole* store, so an additive/partial batch (the Linux
  seed, a single vendor ADMX) would otherwise "retire" every unrelated file.
  Apply is idempotent (batch+store fingerprint). To install the full upstream
  adsys tree instead of the generated subset, `admx-import-stage` it and
  `admx-import-apply` it.
- **`gpo-linux-report`** — which GPOs carry Linux-targeted settings: registry.pol
  keys under a Linux ADMX namespace (`Software\Policies\{Ubuntu,Canonical,GNOME}`)
  plus samba Unix/VGP CSE preference artifacts in the GPO's SYSVOL. Read-only.
- **Faceting fix** — `_derive_tags` now tags `ubuntu`/`adsys`/`canonical` ADMX as
  **Linux** (subsystems ubuntu/gnome/debian). Before, an `Ubuntu.admx` hit the
  Windows default and every Linux setting was mis-tagged Windows and hidden from
  the editor's Linux facet. The seeded 23 policies now show as Linux in the
  catalog (verified live: 396 Linux ADMX entries, 23 Ubuntu).
- **UI** — the "ADMX central store" modal now separates **Linux** from **Windows**
  administrative templates, has a one-click **Install Linux (Ubuntu/adsys)
  templates** button (calls `gpo-linux-seed`, then refreshes the catalog cache so
  the editor's Linux facet updates), an OS column on the policy list (Linux rows
  first), and a **GPOs with Linux settings** report.
- Tests: 157 (+9). Verified live against the lab: seed installed `Ubuntu.admx`
  (store 232 -> 233 files), 23 policies parsed with all names resolved, re-seed
  reported "already applied", and the catalog listed the 23 as Linux.

## 1.4.2 - 2026-09-18

RD/Terminal Server licensing helpers (`rds` verb group). AD-side support only.

- Research + live verification confirmed the AD Lab **already has** the complete
  "Terminal Server License Servers" support structure by Samba default: the
  built-in group (SID S-1-5-32-561, CN=Builtin), the per-user-CAL + RDS-profile
  `msTS*` schema, and — stamped onto every user object at creation — the
  delegation ACE granting the group RPWP on the "Terminal Server License Server"
  property set (5805bc62). Nothing needed creating.
- Added three read-mostly `adlab-admin` verbs so the lab can verify/manage it:
  - `rds-status` — the group, its members, the per-user-CAL schema, whether user
    objects carry the CAL-write delegation, and any site license-server SCP.
  - `rds-ensure` — verifies the support structure; remediates only a genuine gap
    (an inherited ACE on the domain head). A no-op on a healthy Samba lab.
  - `rds-add-server --server <computer$>` — join an RD Licensing server's
    computer account to the group (the one operational step, done when a real
    license server is deployed); verifies the delegation first.
- Tests: +6 (TestRds).

## 1.4.1 — 2026-09-18

### Offline-join blobs are validated as structures, not just as base64

`_decode_odj` proved only that the blob was base64 before handing it to an
answer file. That is not enough to catch the failure it exists to catch.

Windows Setup's `offlineServicing` pass logs `Successfully applied settings
override to component Microsoft-Windows-UnattendedJoin` for having **written**
the settings into the image, not for having joined anything. A blob the OS later
rejects produces no error on the machine and no error in AD — the machine simply
boots into a workgroup with a clean install log, while every signal an operator
would check still looks right, because provisioning created the account and set
its password itself. There is no downstream diagnostic, so the blob has to be
checked here or nowhere.

It is now parsed as the NDR type-serialization v1 stream it is (MS-RPCE 2.2.6):
the private header must be `version=1`, `endianness=0x10`, `header_len=8`,
filler `0xCCCCCCCC`, and the declared object-buffer length must fit in the bytes
present. A malformed blob fails at the point of generation, naming what was
wrong with it.

`_decode_odj` had no test coverage at all; it has eight cases now, including the
BOM/NUL/wrapping round trip and both boundaries of the length check.

## 1.4.0 — 2026-09-17

### Member servers (offline domain join)

New `members` verb group and a **Member Servers** tab.

A Windows machine built by an unattended installer cannot join the way the
lab's `clientN` containers do. The containers run `edy-domain-install` with the
administrator password mounted at `/run/adminpass`; an unattended Setup has no
such mount, and the only credential it can use is one written into its answer
file — which is, by construction, readable by whatever fetched it. The online
join (`Microsoft-Windows-UnattendedJoin/Identification`) therefore means a
domain administrator password in cleartext on the provisioning network.

Offline domain join removes the credential. The machine account is created on
the PDC emulator and its provisioning data is packaged into a blob that
authenticates exactly one computer account and is consumed by the join.

- `member-provision` — create/refresh a machine account, return its blob.
  Samba's `net offlinejoin provision` (4.16+; this host runs 4.23) produces
  output byte-compatible with `djoin.exe /provision`, which is what makes it
  consumable by a stock Windows answer file. `savefile=` is used rather than
  `printblob` because `printblob` writes its success banner and the blob to the
  same stream, so a parser cannot separate the credential from the chatter.
- `member-list` / `member-verify` — distinguish **provisioned** from **joined**.
  `operatingSystem` and `dNSHostName` are written by the machine itself at join
  time, so a populated value is evidence the join completed rather than merely
  that an account exists. After an unattended install that "looked fine", this
  is the distinction an operator actually needs.
- `member-deprovision` — delete the account; refuses DCs and `clientN`.

The blob is a credential: it is returned once on stdout, never written to a host
path, and never enters the audit log (only argument names and non-secret values
are logged, and the blob is a result, not an argument).

New `podman_auth_body()` alongside `podman_auth()`. `AUTH_WRAP` appends
`-A "$af"` to its command and then immediately exits, which fits one
`samba-tool` call and nothing else; provisioning has to read and delete the
blob file *inside* the authfile's lifetime, so it needs a wrapper that hands the
body `$af` and lets it choose its own exit status.

## 1.3.1 - 2026-09-17

GPO editor right pane (`.al-edit-list`): filter, selectable columns, and proper
scrolling. A subsystem group can hold hundreds of settings.

- **Filter** — a search box above the table narrows the settings by name,
  registry key/value, CSE, or ADMX file, with a live "N of M settings" count.
- **Selectable columns** — a "Columns…" picker toggles optional columns
  (key / cse, class, type, ADMX, in GPO); the setting name and the action
  button always show. The choice persists while the modal is open.
- **Scrolling** — the pane is now a fixed header + filter over a scroll region
  that scrolls **both axes**: rows scroll vertically under a **sticky column
  header**, and wide content (extra columns) scrolls horizontally instead of
  squishing every column. Short columns stay single-line; the long
  setting/key columns wrap within a cap. The setting detail/editor view scrolls
  the same way.
- UI only. Verified in a mock-bridge harness: 40-setting group scrolls
  vertically (sticky header), filter narrows to 1 of 40, enabling class/type/
  ADMX columns triggers horizontal scroll.

## 1.3.0 - 2026-09-17

Persistent, differentially-refreshed ADMX catalog cache — the GPO editor's left
pane now opens instantly instead of re-parsing the whole central store.

- **The problem**: `gpo-catalog` re-read and re-parsed every `.admx`/`.adml` in
  the central store on every editor open (a `podman exec` per file) — ~4004
  policies, **~38s measured on edt1**.
- **The cache**: `/var/lib/adlab/catalog-cache.json` (0644, world-readable)
  stores each ADMX file's PARSED policies keyed by a `size:mtime` signature.
  Serving from a warm cache is **~0.14s**. OS/subsystem facets and operator tag
  overrides are applied at serve time (not cached), so retagging never needs a
  re-parse.
- **Differential refresh** (`gpo-catalog --refresh true`): stats the central
  store once, re-ingests only ADMX whose file — or its ADML — is newer/changed,
  and **keeps** the rest. Touching one file re-parses one file (~1s), not 4004.
  `--rebuild true` forces a full re-parse.
- **Delete detection**: entries whose backing ADMX no longer exists are purged
  from the cache on refresh.
- **Change events over a channel**: the cache file is rewritten atomically and
  ONLY when something changed, so the mtime bump is a real "refreshed" event.
  The editor subscribes to a Cockpit **fswatch** channel on the cache file, so a
  refresh from any session (or the periodic tick) reloads every open editor's
  tree. The session user can read the file, so the watch needs no elevation.
- **UI**: the editor loads the tree from cache immediately, runs a background
  differential refresh, polls one every 2 minutes while open, and tears down the
  watch + timer when the modal closes. The plugin also warms the cache in the
  background at load so the first editor open is fast too.
- Unit tests: 134 (+5 — the pure refresh planner's reuse/reingest/delete/force
  branches and cache-serving without any podman calls). Verified live on edt1:
  cold build 39.6s → warm serve 0.14s; a one-file change re-ingests in 1.0s; an
  unbacked entry is purged.

## 1.2.2 - 2026-09-17

GPO preferences modal: sort the available policy by OS.

- The **GPO preferences (CSEs)** modal (`modal=gpo-prefs`) gained an **OS
  selector** (All OSes / Windows / Linux) and **subsystem chips**
  (debian/redhat/ubuntu/…) that filter which CSE preference types are offered,
  with a "N of M preference types shown" count. This is the same override-aware
  faceting the full editor uses: the CSE list and its OS/subsystem tags come
  from `gpo-catalog` (which applies operator tag overrides), not a hardcoded
  list. Selecting Windows correctly shows none — the samba CSE preferences are
  all Linux — so the operator immediately sees the platform scope instead of
  scanning a flat list.
- `adlab-admin gpo-catalog` gained an optional **`--source cse|admx`** filter.
  `cse` SKIPS the ADMX parse entirely, which on a host with the full central
  store loaded is thousands of policies / tens of seconds (~38s measured on
  edt1). The prefs modal only needs the ten CSEs, so it calls
  `gpo-catalog --source cse` and opens fast; the full editor still loads the
  whole catalog as before. Backward compatible (the arg is optional).
- If `gpo-catalog` is unavailable the modal falls back to the flat CSE list
  (all types, no OS filter), so it never becomes unusable.

## 1.2.1 - 2026-09-17

AD Objects console: GPOs in the tree, links viewable (UI only — no helper
contract change; the version bump is a plugin build marker).

- The "Users & Computers" tab is renamed **AD Objects** (it manages every
  directory object, not just users and computers).
- A synthetic **Group Policy Objects** folder now appears in the tree (the
  GPMC "Group Policy Objects" container). Selecting it lists every GPO
  (name / version / GUID) in the middle pane with a per-row actions menu
  (edit settings, compose, details, preferences, link); selecting a GPO shows
  its metadata and, crucially, its **Links** — the containers it is linked to,
  each clickable to jump to that container in the tree.
- **GPO links are viewable from both directions.** An OU/domain object's
  preview gains a **Linked GPOs** section parsed from its `gPLink`: each linked
  GPO is shown by display name (resolved via `gpo-list`), flagged `enforced` /
  `disabled` per its link options, and clickable to jump to that GPO in the
  Group Policy Objects folder.
- No new verbs: the console reuses `object-tree` / `object-get` / `gpo-list` /
  `gpo-show` (whose `links` come from `samba-tool gpo listcontainers`).
  Verified live in a mock-bridge browser harness (tab rename, GPO folder + list,
  per-GPO links, OU-side linked GPOs with enforced badge, no console errors).

## 1.2.0 - 2026-09-17

Multi-domain (multi-forest) support. The lab can now run any number of
INDEPENDENT Samba forests, each isolated on its own podman network, alongside
the primary. Podman is a hard prerequisite (it always was — this makes the
per-forest network model explicit).

- **Domain lifecycle verbs** in `adlab-admin` (new `domains` verb group):
  - `domain-list` — every forest, primary first, with its DCs and states.
  - `domain-add --realm R --domain_nb NB [--slug s]` — create a NEW forest: its
    own network `adlab-<slug>` on `10.44.N.0/24` (first free N) and a
    provisioned first DC. Rolls the network back if provisioning fails. Refuses
    the primary realm and a duplicate.
  - `domain-remove --realm R [--backup true]` — destroy a whole forest: remove
    every DC container and the network, optionally taking an offline AD backup
    first. Refuses the primary domain.
  - `domain-backup --realm R` — offline `samba-tool domain backup` of any
    domain (including primary) to a host tarball under `/var/lib/adlab/backups`.
  - `dc-decommission --dc NAME` — demote + remove any DC in any forest; refuses
    the primary `dc1` and a forest's last DC (use `domain-remove` for that).
- **Every existing verb is now domain-aware** via a global `--domain <realm>`
  selector, resolved once per invocation into a module `CUR` context. The six
  shared helpers (`dc_name`/`dc_ip`/`all_dcs`/`domain_dn`/`first_up_dc` + `LAB`)
  default to `CUR`, so ~40 verbs act on the selected forest without signature
  changes. `dc-promote` deploys additional DCs into the selected forest.
  Additional-domain containers carry `adlab.*` labels so forests are
  rediscovered from live podman state; the primary is told apart by their
  absence. Clients remain primary-only.
- **AD Lab plugin**: a new **Domains** tab (add / back up / remove forests,
  see each forest's DCs) and a header **forest selector** that scopes every
  non-global verb onto the chosen domain. The DCs tab shows the forest in view
  and gained a per-DC **Decommission** action. `domain-remove` and
  `dc-decommission` require type-to-confirm.
- **`20-up.sh`** gained an optional `EXTRA_DOMAINS` declaration in `lab.env`:
  each entry brings up an additional forest byte-for-byte identical to what
  `domain-add` creates (same names, network, subnet allocation and labels),
  idempotently. Empty by default, so the single-domain lab is unchanged.
- The DC image (`Containerfile.dc`) now installs `tdb-tools`: `samba-tool
  domain backup offline` shells out to `tdbbackup`, so without it every
  `domain-backup` (and `domain-remove --backup`) aborted. Already-running DCs
  keep their old image until recreated (persistent state makes a `20-up.sh`
  recreate non-destructive), so back up the PRIMARY forest only after its DCs
  have been recreated on the rebuilt image; new/added forests get it for free.
- Unit tests: 127 total (+9 for the domain verbs, guards, and a regression
  test pinning `domain-list`'s discovery to `podman ps`'s `.Labels` field
  (`.Config.Labels` is inspect-only and silently hid every additional forest).

## 1.0.1 - 2026-09-07

Install classification is now decided by LAYOUT, not by a development-root path
prefix, and this plugin was deployed to its real install path on edt1.

- `install.sh` decides dev vs deployed by asking whether its own directory is
  what a sibling `payload` symlink resolves to. The old test compared `$SRC`
  against a hardcoded development root and got a checkout sitting ANYWHERE ELSE
  wrong: such a checkout classified itself `deployed`, so it skipped the
  group-writable warning, wrote INSTALL_KIND=deployed for a host that was not
  self-sustaining, and dropped "the checkout is not touched" from
  `--uninstall`. Reproduced before the change and confirmed fixed after.
- Because that literal is gone, pre-flight check 9 now scans `install.sh`
  itself. The carve-out that exempted it is removed. Both of the check's own
  patterns are split so the scanner cannot match itself; the string it searches
  for is unchanged, so nothing is weakened.
- `owned_by_us` recognises a dev link by `$SRC` rather than by "anywhere
  under the development root", which is tighter: it no longer adopts a link
  belonging to a different checkout of the same project.
- The uninstall notice and the dev warning ask the LINK TARGET's layout, so
  they stay correct when the deployed installer tears down links a dev install
  made.
- Added a VERSION file, and deploy.sh now REFUSES without one instead of
  silently defaulting to 1.0.0 - a fixed fallback names every payload directory
  the same thing and makes rollback impossible.
- Deployed to /opt/cockpit-adlab. The two files that reached into the
  development tree - /usr/share/cockpit/adlab/manifest.json and
  /usr/local/sbin/adlab-admin - no longer exist in that form.
- Fixed: tests/test_adlab_admin.py had its `unittest.main()` block ABOVE
  TestConfigLayer, so unittest exited before defining it and seven config-layer
  tests silently never ran (100 collected, not 107). The block is now last, with
  a comment saying why it must stay there.
- Added `TestSuiteCompleteness`, which compares the number of `def test_` in the
  file against what the loader actually collects and fails when they differ.
  A comment is not a control; this is. Proved by re-introducing the defect.
  The suite is 108 tests.
A recursive grep of the deployed tree for the development root or the retired
checkout path now returns nothing at all.
