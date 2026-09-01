# Cockpit AD Lab plugin

`cockpit-adlab/` is a Cockpit plugin ("AD Lab", installed to
`/usr/share/cockpit/adlab`) that manages this lab from a browser, modeling the
classic Windows consoles: Users & Groups (dsa.msc), Group Policy (gpmc.msc),
Sites & Replication (dssite.msc), DNS (dnsmgmt.msc), Domain Controllers, Clients,
and an Activity audit view.

## Architecture

- **One root entry point:** `/usr/local/sbin/adlab-admin`, a Python verb helper
  (the hs-admin JSON contract — one verb, one JSON object on stdout, non-zero
  exit carries `{"error": …}`). The page calls it with
  `cockpit.spawn(..., {superuser: "require"})`; it never composes raw podman or
  samba-tool commands in the browser.
- **The verb table is the UI schema.** `adlab-admin schema` returns every verb,
  its group, danger flag, and typed args; generic forms are rendered from it, so
  the UI cannot drift from the API.
- **PDC-targeted writes.** GPO and DNS writes resolve the PDC emulator live
  (`fsmo show`) — never hardcoded — because SYSVOL replication is single-master.
- **Secrets never on argv.** Domain-credential verbs build a mode-600 authfile
  inside the container from the mounted `/run/adminpass`; passwords for
  `user-setpassword` travel on stdin. Every invocation is appended to
  `/var/log/adlab-admin.log` — the Activity tab's data.

## URL-driven navigation

Navigation is entirely `cockpit.location`-based: the tab is the path (`#/gpo`)
and an open modal is in the options (`?modal=gpo-compose&target={GUID}`). A
single `route()` renders from the URL; tabs and modals are deep-linkable and the
browser Back/Forward buttons move through them. The tab body re-renders only
when the path tab changes, so opening or closing a modal never tears it down.

## Group Policy: stacking

The **compose** modal builds an ordered stack of layers and applies them to a
target GPO:

1. **Template GPOs** — copy another GPO's registry.pol settings as a layer.
2. **ADMX templates** — `Load ADMX` populates the SYSVOL central store
   (`gpo admxload`); pick a parsed policy + Enabled/Disabled → a registry layer.
3. **Raw registry** — key / value / class / type / data directly.
4. **Preferences** — the samba CSEs via `gpo manage` (smb_conf, security, motd,
   issue, sudoers, files, symlink, openssh, scripts, access).

Registry layers merge (in stack order, later overrides) into one
`samba-tool gpo load`; preference layers each `gpo manage <cse> set`. The plugin
parses `registry.pol` (PReg) and ADMX itself — pure, unit-tested functions in
`adlab-admin`.

## Install & test

```bash
cockpit-adlab/install.sh          # runs the unit gate, then installs plugin + helper
```

`install.sh` refuses to install unless the Python unit suite
(`cockpit-adlab/tests/test_adlab_admin.py`, FakeRunner — no podman needed)
passes. Cockpit end-to-end specs live in the separate `cockpit-e2e` harness
(`adlab.spec.js`, `adlab-nav-gpo.spec.js`) and drive the live plugin as a
non-admin/admin Cockpit user.
