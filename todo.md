# samba-ad-lab — open work

The single list of open work for this repo (lab on host edt1: DCs `dc1`–`dc5`, `client1`–`client10`, `rdp1`/`rdp2`,
`adlab-ca`, extra-forest DCs `ad2-dc1`/`ad2-dev-dc1`, and the cockpit-adlab plugin). Every item below was checked
against git and the live host on **2026-10-15** (each section was then re-checked by independent skeptical
verifiers; their corrections are folded in). Tick or delete an item in the SAME PR that closes it; add a line when new
open work appears. Memory only points here (`samba-ad-lab-todo`; incident record
`samba-ad-lab-service-restart-loop-2026-10-04`).

## Live state (verified 2026-10-15, after the 11:44 reboot)

- `cockpit-adlab` **1.16.1** deployed 2026-10-15 20:29Z from merged main (`ff73a8f`, PR #35) —
  `/usr/local/sbin/adlab-admin` -> `/opt/cockpit-adlab/payload-1.16.1/bin/adlab-admin`, post-install assertions ok,
  `payload-1.16.0` retained for rollback. `config` now distinguishes `present`/`missing`/`unreadable`/`in-container`:
  as eddie `admin_pass_file` is `status=unreadable exists=null` (was the false "missing"), as root `status=present`;
  `gpo_template_dir` is `in-container` (it is a path inside a DC container, never on the host). `status` reports 17
  containers; `domain-info`, `fsmo-show`, `dc-list`, `schema` all exercised against the new build.

- `samba-ad-lab.timer` fires `samba-ad-lab.service` 45 s after boot; the service is **disabled** (no
  `multi-user.target.wants` link). This boot: timer fired 11:45:12, lab start ran 57 s, `Result=success`, `NRestarts=0`;
  `multi-user.target` reached at 25.4 s with no `samba-ad-lab` in its chain; power-profiles-daemon active at 11:44:57
  (inside gnome-shell's 25 s window) with 0 D-Bus timeouts. The "before" numbers (1m36s, the ppd timeout) come from the
  2026-10-08 boot record in memory; the journals of earlier boots are rotated and can no longer be re-derived.
- The repo's `samba-ad-lab.timer` and `samba-ad-lab.service.d/10-bounded-restart.conf` are byte-identical to
  `/etc/systemd/system` (PR #34). `samba-ad-lab.service` itself is a template (`@LAB_DIR@`) and still carries
  `[Install] WantedBy=multi-user.target`: a stray `systemctl enable samba-ad-lab.service` would re-gate boot (rollback
  path only).
- **Host-only, not in the repo:** `/etc/systemd/system/adlab-container-supervisor.service.d/10-killmode.conf`
  (`KillMode=process`). `adlab-container-supervisor.timer` (every minute) is what starts `ad2-dc1`, `ad2-dev-dc1` and
  `adlab-ca` at boot, and podman leaves a started container's conmon in the caller's cgroup; without the drop-in systemd
  SIGTERMs those conmons when the oneshot exits (samba exits 127 each minute, `adlab-ca` loses its conmon). With it all
  three are up with live conmons (checked after this boot). The supervisor journal now logs "Found left-over process N
  (conmon) in control group … Ignoring." three times a minute: benign, do not "fix" it by reverting the drop-in.
  Rollback: remove the drop-in directory and `systemctl daemon-reload`.
- **Restored by hand 2026-10-15:** `chronyd` on `dc1`–`dc5` (see the first code follow-up); it lasts until those
  containers restart.

## Code follow-ups

- [x] **DC `chronyd` does not survive a container restart (regression of PR #33 signed time)** — `21-start.sh` part
  done in PR #38: `clear_stale_pidfiles` (the PR #34 helper, generalised) clears `/run/chrony/chronyd.pid` from each
  stopped DC's layer before `podman start`, and `dc-entrypoint.sh` removes it before `chronyd -x`. Stub-tested only;
  not yet exercised across a real DC restart or reboot. Manual recovery meanwhile:
  `podman exec dcN sh -c 'rm -f /run/chrony/chronyd.pid; chronyd -x -f /etc/chrony/adlab-dc.conf'`.
- [ ] **Verify the DC chronyd fix across a real DC restart or reboot.** At the next boot: `podman top dcN -eo comm | grep -c chronyd`
  is 1 on all five DCs, with no `WARNING: chronyd failed to start` in `podman logs --since <boot> dcN`, and `21-start.sh`
  prints `note: dcN: removed stale chronyd.pid` for any DC that had one (a clean stop may leave none). Until then PR #38 is stub-tested plus a real
  `podman mount`/`unmount` pass on a stopped container only.
- [ ] **Track the system installer.** The repo-root `install.sh` (15.9 KB, 2026-09-07) installs the sysvol scripts under
  `/usr/local/libexec/samba-ad-lab/` but is not whitelisted in the ignore-everything `.gitignore`, so it exists only in the
  live checkout (`git ls-files` shows `install-start.sh`, `cockpit-adlab/install.sh`, `sysvol/install-timer.sh`, `tools/install-tools.sh`
  but not `install.sh`). Add `!install.sh`, review it (it runs as root) and commit it.
- [ ] **Rebuild the DC image and rolling-recreate `dc1`–`dc5` so the `dc-entrypoint.sh` chronyd pidfile cleanup is
  baked in (PR #38).** The running DCs keep the old entrypoint in their image layer, so until then only the
  `21-start.sh` pre-start cleanup protects them (the lab-start path only, not a bare `podman restart dcN`).
  Non-destructive for the primary DCs (their forest lives in `/opt/sc/lab-state`); one DC at a time, let replication
  settle (`30-verify.sh`). `ad2-dc1`/`ad2-dev-dc1` run an older image without chrony — never recreate them to "fix" this.
- [ ] **The supervisor's unit files vanished on 2026-10-15 ~21:47 and took the extra-forest DCs down for ~38h.** `/etc/systemd/system/adlab-container-supervisor.{service,timer}` were deleted. Only `adlab-container-supervisor.service.d/10-killmode.conf` remained. It was NOT `container-supervise-disable`: that verb stops the timer, and the timer stayed loaded as `not-found`, still running. The next `daemon-reload` came at 21:47:19–21, from two inbox-runner jobs. It reloaded the service without its unit file, so the drop-in's `KillMode=process` no longer applied, and systemd reaped the cgroup that held `ad2-dc1`/`ad2-dev-dc1`'s conmons. Both died at 21:47:22 with exit 127. Nothing restarted them: the supervisor service could not load, and its start counters stayed at 4059. Restored 2026-10-17 11:31 CDT with `adlab-admin container-supervise-enable`. That rewrote the units, `KillMode=process` applies again, the supervisor started both DCs, samba listens on 389/88/445, and the conmons survive later ticks. **Open:** find what deleted the files. No job in `/srv/jobs/outbox` and no journal line names it. Also consider not holding long-lived conmons in a oneshot's cgroup at all, e.g. start the DCs in their own scope (`systemd-run --scope`), so losing the unit cannot kill a forest that has no persistent state.
- [ ] **Supervisor unit generator lacks `KillMode=process`.** `cockpit-adlab/adlab-admin` `v_container_supervise_enable`
  (the unit text is a string literal in that function) writes `Type=oneshot`/`User=root`/`ExecStart=… container-supervise` with no `KillMode`
  (the deployed `/usr/local/sbin/adlab-admin` is the same). The drop-in keeps edt1 working across regeneration; emit
  `KillMode=process` from the generator (with a comment saying why) so a fresh install is right too. Same trap and fix as
  `samba-ad-lab.service`.
- [ ] **Supervisor counts a start as success even if the container dies seconds later.** In `v_container_supervise`
  (`cockpit-adlab/adlab-admin`) a `podman start` that returns 0 resets the entry to `{"starts": n+1}`, so
  `attempts` never increments and the 5-retry/backoff limit can never trip: `/var/lib/adlab/container-supervisor.json`
  today shows `rdp1` 16266, `rdp2` 16265, `ad2-dc1`/`ad2-dev-dc1` 4059 starts each and no attempts. Treat a previous
  supervised start with `FinishedAt − StartedAt < 15 s` as a failed attempt, back off, give up after the existing 5, and
  record the exit code in `last_error`.
- [ ] **Rebuild the `ad-rdp` image so new containers carry the entrypoint pidfile cleanup (PR #34).**
  `localhost/ad-rdp:latest` was built 2026-08-27 and `rdp1`/`rdp2` still run it; `21-start.sh` `clear_stale_xrdp_pids`
  already protects them (at the 2026-10-15 clean reboot it was a no-op; the hard-reset path with a real stale pidfile has
  not been exercised since the stub test). **Never recreate `rdp1`** (its domain join lives in its writable layer) and
  note that `rdp/20-up-rdp.sh` L15 runs `podman rm -f` on every rdp container unconditionally — give it the same
  refuse-to-rm guard. `rdp/10-build-rdp.sh` L16 builds straight to `$IMG_RDP` (`rdp/rdp.env` L18 =
  `localhost/ad-rdp:latest`), so a throwaway-tag build needs an `IMG_RDP` override.
- [ ] **Extra-forest DCs have no persistent state.** `ad2-dc1`/`ad2-dev-dc1` were created by the plugin
  (`cockpit-adlab/adlab-admin` `_run_dc`, called from `v_domain_add`), which mounts only `administrator.pass` — no
  `/var/lib/samba` volume — so `podman rm` destroys the forest. `20-up.sh`'s extra-forest block (L145–148) does
  `podman rm -f` then `podman run` for any extra DC that is not running (its L105 comment says an existing container "is
  left alone"; the code does not); it is dormant only because `EXTRA_DOMAINS=()` in `/etc/samba-ad-lab/lab.env`. Give
  extra forests a state mount like `dc_state_args` and make both paths refuse to `rm` an existing container. Until then
  never run `20-up.sh` with `EXTRA_DOMAINS` set.
- [ ] **The Python suite must run as NON-ROOT; one test fails under `sudo`/the job runner.**
  `test_config_verb_reports_resolved_paths` asserts `env_file_source == "env:ADLAB_ENV"`, but `$ADLAB_ENV` is honoured
  only when `euid != 0` and the file is owned by the caller — deliberately, since "an env var that redirects a root
  process's config is a privilege escalation" (`adlab-admin` L60–62). Run as root it resolves via `install.conf`
  instead and the assertion fails. **Pre-existing, not a regression:** the same single test fails on 2fba7fb
  (269 passed / 1 failed) exactly as on current main. Either skip it when `os.geteuid() == 0`, or document the suite as
  non-root-only. As eddie: 273 passed.

## Owner decisions

- **Root executes lab scripts from the SMB share.** `samba-ad-lab.service` has
  `ExecStart=/srv/smb/share/sc/ai-orchestrator-group/ai-orchestrator-storage/projects/samba-ad-lab/source/21-start.sh`
  (mode 775, `eddie:smbusers`, setgid dir; `smbusers` has one local member, `eddie`; remote writers depend on the share
  ACL). The trust surface is the whole tree, not one file: `21-start.sh` `cd`s to its own directory, sources
  `rdp/rdp.env` → `../lab.env`, and runs `40-agent.sh` → `agent.env`; the parent `projects/samba-ad-lab` is `root:users`
  2775. The sysvol scripts were moved to `/usr/local/libexec/samba-ad-lab/` by the lab's system installer (the repo-root
  `install.sh`, 2026-09-07 — see the untracked-installer item; PR #31 only fixed their `lab.env` lookup). `lab.env` and `rdp.env` are already installed root-owned under
  `/etc/samba-ad-lab` (identical to the share copies today) but the boot script ignores them, and `agent.env` is not
  installed anywhere. Choose: install `21-start.sh`, `40-agent.sh`, `agent.env` and the `rdp/` helpers under
  `/usr/local` and point them at `/etc/samba-ad-lab`, or accept the risk.
- **Leftover containers beyond `CLIENT_COUNT=10`:** `client11` and `client12` (Created, never started) and `client13`
  (Exited (0), "292 years ago"). Not deleted; remove them or keep them.
- **`samba-ad-lab/source` `stash@{0}`** ("pre-reset snapshot 2026-09-18: superseded draft, work merged via PR 12"): the
  work it protected is merged and the tree is clean; drop it or keep it. Not dropped.
- **Host hygiene (root-owned):** `/etc/adlab/lab-root` (2026-09-08) still points at the share project dir and nothing
  reads it any more; `/usr/local/libexec/samba-ad-lab/sysvol-lib.sh.bak.1789971669` is a pre-PR #31 leftover; branches
  already merged into main remain on origin (`gh api repos/x86Since8088/lin-ad-lab-with-cockpit/branches` lists 10 besides
  `main`, including those of PRs #34/#36/#38) and stale remote-tracking refs linger locally (`git fetch --prune`).

## Not open (for context)

- Restart loop, bounded restart and the boot gate are fixed and verified across a real reboot (PR #34). The stale xrdp
  pidfile is mitigated in `21-start.sh` and the entrypoint; it has been verified only across a clean reboot (the
  hard-reset path is not exercised). The ad2/adlab-ca kill loop is fixed by the host-only supervisor drop-in above, not by
  PR #34 (its generator fix is the second code follow-up). Incident record: memory
  `samba-ad-lab-service-restart-loop-2026-10-04`.
- The Power Mode quick-settings tile and the ppd `amd_pstate` boost `EINVAL` (CPB off in firmware) are not lab issues;
  they are tracked in memory `edt1-power-mode-cpb-disabled` and the cross-project todo. The lab no longer delays ppd, and
  nothing here could look at the tile itself.
