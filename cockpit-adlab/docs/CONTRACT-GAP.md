# cockpit-adlab — contract gap analysis (as of 2026-09-08)

Preserved verbatim on 2026-09-11 from `projects/cockpit-adlab/project_scope.md`,
which was retired to a tombstone that day. It is kept here, with the code it
describes, because nothing else in this repository records these findings.
It is a POINT-IN-TIME analysis, not a live status page: re-verify before acting.

---

# cockpit-adlab

A Cockpit plugin ("AD Lab") that models the classic AD admin consoles
(dsa.msc, gpmc.msc, AD Sites & Services, dnsmgmt.msc) against the
containerized samba-ad-lab: users/groups/OUs/computers, GPO management
(PDC-emulator-targeted), sites & DRS replication, SYSVOL health/sync, DNS
zones/records, DC operations (promote, demote, restart, logs, live debug
level, RPC session view, one-shot remoting), client onboarding, and an API
activity audit plane.

All privileged work flows through ONE root verb helper
(`/usr/local/sbin/adlab-admin`, hs-admin JSON contract). Its verb table IS
the UI schema: the plugin renders every control, form and confirmation modal
from `adlab-admin schema`, so UI and API cannot drift. Full unit tests
(46) cover the verb surface with a fake runner; Cockpit-side Playwright
lives in `~/Documents/ClaudeSystem/cockpit-e2e/tests/adlab.spec.js`.

## Where the code is

The canonical source is now
`/srv/smb/share/sc/ai-orchestrator-group/ai-orchestrator-storage/projects/samba-ad-lab/source/cockpit-adlab/`.
The plugin ships INSIDE the samba-ad-lab repository
(`git@github.com:x86Since8088/lin-ad-lab-with-cockpit.git`, branch `main`),
because it is useless without the lab it drives.

**`projects/cockpit-adlab/source/` is STALE and must not be edited.** It is a
pre-contract tree: its `install.sh` copies the helper with `install -m 0755`
instead of linking it, `--uninstall` does `rm -rf` on the target, and it has
neither a `deploy.sh` nor an `.envdefault`. Editing it produces changes that
never reach the host and a second helper that disagrees with the first. This
file is the only thing standing between a reader and that mistake.

## Build and install

- **Build tool:** none. `install.sh` (in the canonical tree) is the in-place
  install **by symlink; it never copies the payload.** It links whatever
  directory it is run from — the checkout for a live-editing dev install, or
  `/opt/cockpit-adlab/payload` for a production one — and tells the two apart
  by **layout** (is a sibling `payload` symlink pointing at me?), never by a
  path literal. It writes per-file links into `/usr/share/cockpit/adlab/`,
  `/usr/local/sbin/adlab-admin`, and `/etc/cockpit-adlab/install.conf`. It
  declares NO units and enables nothing. `--uninstall` keeps `.env`,
  `/var/log/adlab-admin.log` and the payload.
  Pre-flight 8 refuses when `/usr/local/sbin/adlab-admin` is a **regular
  file** — that is almost certainly the stale tree's own install, and it must
  be `rm -f`'d deliberately rather than replaced silently.
- **Deploy:** `deploy.sh` is the only thing that copies. Payload →
  `/opt/cockpit-adlab/payload-<VERSION>/`, `payload` symlink swapped, `.env`
  seeded from `.envdefault` **missing-only** as a SIBLING of `payload`, then
  `install.sh` runs from that install path. `README.md` deliberately does not
  ship. `deploy.ps1`/`deploy.bat` refuse: every effect of this plugin is
  `podman exec` into a Linux container, so there is no Windows half.
- **`.env` is not test material here — and the helper does not read it.** See
  the gap below.
- **Prerequisites:** not a checkout, but a sibling project's *installed*
  footprint. `samba-ad-lab/source/install.sh` puts `lab.env` and `rdp.env` in
  `/etc/samba-ad-lab/` and the SYSVOL scripts in
  `/usr/local/libexec/samba-ad-lab/`; the six `ADLAB_*` keys default to
  exactly those locations. `ADLAB_SECRET_DIR` (0700) is created once by the
  operator — no script creates it, because an empty secrets directory at a
  stale path is how this lab once minted a second administrator passphrase.
  **`/etc/samba-ad-lab/` does not exist on edt1**: `samba-ad-lab/source/install.sh`
  has never been run here, so every `ADLAB_*` default currently points at
  nothing.
- **Full model:** `cockpit-secrets/source/docs/DEPLOY-CONTRACT.md` (§8 works
  this project through — but note §8.2's specimen `.envdefault` and §8.3's
  prescribed helper do not match what actually shipped).

## The gap between the contract and the shipped helper

Verified by reading `adlab-admin` (`_lab_root()`, lines 61–80), not inferred:

- **`adlab-admin` does not read `.env`, does not read `install.conf`, and uses
  none of its six `REQUIRED_ENV` keys.** It resolves `$ADLAB_LAB_ROOT` → the
  path recorded in `/etc/adlab/lab-root` → a discovery sweep over candidates
  assembled from string fragments, and derives `LAB_ENV`, `RDP_ENV`,
  `SYSVOL_REPL` and `ADMIN_PASS_FILE` from that root. `GPO_TEMPLATE_DIR` is a
  hardcoded module constant.
- The split-string candidates are the exact mechanism DEPLOY-CONTRACT.md §4.3
  forbids, and they defeat the standing grep of §4.4 by construction.`/etc/adlab/lab-root` names the development share. It is **not** the only installed file that does: `grep -rl` across every installed location returns **four** — `/etc/adlab/lab-root`, `/etc/systemd/system/lab-edt-bridge.service`, and `sysvol-replicate.{service,timer}`. The last is the one that matters: its `ExecStart=` runs `sysvol-replicate.sh` **directly off the share as root**, so the service fails if the share is unavailable and anyone who can write that path chooses what root executes. Those three units are written by `sysvol/install-timer.sh` as DEVELOPMENT units (see samba-ad-lab's scope file) and are outside this plugin's deploy path. Nothing in either
  project's `install.sh` writes it. So the plugin **works, but only by reaching
  into the dev tree** — the acceptance test ("unmount the share and it still
  works") does not pass for this plugin.
- `/usr/local/sbin/adlab-admin` is a **regular file** on edt1, not a symlink.
  It is byte-identical to the canonical source (and to the stale tree's copy,
  which is the same bytes), so the running helper is current code — but it was
  put there by a copy, not by this installer, and it does **not** match
  `/opt/cockpit-adlab/payload/bin/adlab-admin`, which is an older build. The
  page's backend is therefore not what was deployed, and `install.sh` would now
  refuse to re-install over it.
- `.envdefault` says "adlab-admin reads this file on every call" and tells the
  operator to check with `adlab-admin config`. Both are false: there is no
  `config` verb. `deploy.sh`'s closing text and `samba-ad-lab/source/install.sh`
  print the same non-existent command.

None of this is fixable by documentation. §4.3 is the target state; this is
what is there now.
