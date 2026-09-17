# Changelog

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
