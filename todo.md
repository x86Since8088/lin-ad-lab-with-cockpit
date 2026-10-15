# samba-ad-lab — open work

The single list of open work for this repo (lab on host edt1: DCs `dc1`–`dc5`, `client1`–`client10`, `rdp1`/`rdp2`,
`adlab-ca`, extra-forest DCs `ad2-dc1`/`ad2-dev-dc1`, and the cockpit-adlab plugin). Every item below was checked
against git and the live host on **2026-10-15** (each section was then re-checked by independent skeptical
verifiers; their corrections are folded in). Tick or delete an item in the SAME PR that closes it; add a line when new
open work appears. Memory only points here (`samba-ad-lab-todo`; incident record
`samba-ad-lab-service-restart-loop-2026-10-04`).

## Live state (verified 2026-10-15, after the 11:44 reboot)

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

- [ ] **DC `chronyd` does not survive a container restart (regression of PR #33 signed time).** `dc-entrypoint.sh`
  (L91–98) does `mkdir -p /run/chrony; chronyd -x -f /etc/chrony/adlab-dc.conf` and never removes
  `/run/chrony/chronyd.pid`. `/run` lives in the container's writable layer, so the pidfile of the previous run
  (written 2026-09-25, content `9`) survives, chronyd refuses to start ("Another chronyd may already be running
  (pid=9)") and the entrypoint only logs `WARNING: chronyd failed to start`. Seen at the 2026-10-04 and 2026-10-15 boots:
  the DCs then serve no signed MS-SNTP time to Windows domain members. Same bug class as the xrdp pidfile (PR #34).
  Fix: remove the pidfile in the entrypoint (needs an image rebuild and a rolling recreate; primary DCs keep their state
  in `/opt/sc/lab-state`) and/or extend the `21-start.sh` pre-start cleanup to the stopped DCs' `/run/chrony`. Manual
  recovery: `podman exec dcN sh -c 'rm -f /run/chrony/chronyd.pid; chronyd -x -f /etc/chrony/adlab-dc.conf'`.
  `ad2-*` run an older image without chrony — do not recreate them to "fix" this.
- [ ] **Supervisor unit generator lacks `KillMode=process`.** `cockpit-adlab/adlab-admin` `v_container_supervise_enable`
  (~L6758, unit text at ~L6763) writes `Type=oneshot`/`User=root`/`ExecStart=… container-supervise` with no `KillMode`
  (the deployed `/usr/local/sbin/adlab-admin` is the same). The drop-in keeps edt1 working across regeneration; emit
  `KillMode=process` from the generator (with a comment saying why) so a fresh install is right too. Same trap and fix as
  `samba-ad-lab.service`.
- [ ] **Supervisor counts a start as success even if the container dies seconds later.** In `v_container_supervise`
  (`cockpit-adlab/adlab-admin` ~L6694) a `podman start` that returns 0 resets the entry to `{"starts": n+1}`, so
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
  (`cockpit-adlab/adlab-admin` `_run_dc` L4166–4193 via `v_domain_add`), which mounts only `administrator.pass` — no
  `/var/lib/samba` volume — so `podman rm` destroys the forest. `20-up.sh`'s extra-forest block (L145–148) does
  `podman rm -f` then `podman run` for any extra DC that is not running (its L105 comment says an existing container "is
  left alone"; the code does not); it is dormant only because `EXTRA_DOMAINS=()` in `/etc/samba-ad-lab/lab.env`. Give
  extra forests a state mount like `dc_state_args` and make both paths refuse to `rm` an existing container. Until then
  never run `20-up.sh` with `EXTRA_DOMAINS` set.
- [ ] **`adlab-admin config` reports an unreadable file as missing** (adlab-admin 1.16.0 on edt1: `admin_pass_file`
  exists=False as eddie, True as root). Fixed in **PR #35** (`fix/adlab-config-honest-path-status`, opened by another
  session, open and unmerged on 2026-10-15). Delete this item when #35 merges.

## Owner decisions

- **Root executes lab scripts from the SMB share.** `samba-ad-lab.service` has
  `ExecStart=/srv/smb/share/sc/ai-orchestrator-group/ai-orchestrator-storage/projects/samba-ad-lab/source/21-start.sh`
  (mode 775, `eddie:smbusers`, setgid dir; `smbusers` has one local member, `eddie`; remote writers depend on the share
  ACL). The trust surface is the whole tree, not one file: `21-start.sh` `cd`s to its own directory, sources
  `rdp/rdp.env` → `../lab.env`, and runs `40-agent.sh` → `agent.env`; the parent `projects/samba-ad-lab` is `root:users`
  2775. The sysvol scripts were moved to `/usr/local/libexec/samba-ad-lab/` by `install.sh` (661aa75, 2026-09-08; PR #31
  only fixed their `lab.env` lookup). `lab.env` and `rdp.env` are already installed root-owned under
  `/etc/samba-ad-lab` (identical to the share copies today) but the boot script ignores them, and `agent.env` is not
  installed anywhere. Choose: install `21-start.sh`, `40-agent.sh`, `agent.env` and the `rdp/` helpers under
  `/usr/local` and point them at `/etc/samba-ad-lab`, or accept the risk.
- **Leftover containers beyond `CLIENT_COUNT=10`:** `client11` and `client12` (Created, never started) and `client13`
  (Exited (0), "292 years ago"). Not deleted; remove them or keep them.
- **`samba-ad-lab/source` `stash@{0}`** ("pre-reset snapshot 2026-09-18: superseded draft, work merged via PR 12"): the
  work it protected is merged and the tree is clean; drop it or keep it. Not dropped.
- **Host hygiene (root-owned):** `/etc/adlab/lab-root` (2026-09-08) still points at the share project dir and nothing
  reads it any more; `/usr/local/libexec/samba-ad-lab/sysvol-lib.sh.bak.1789971669` is a pre-PR #31 leftover; this
  checkout has 5 prunable worktrees from an earlier session (`git worktree prune`) and branches already merged into main
  remain on origin (`git branch -r --merged origin/main` lists 21 refs).

## Not open (for context)

- Restart loop, bounded restart and the boot gate are fixed and verified across a real reboot (PR #34). The stale xrdp
  pidfile is mitigated in `21-start.sh` and the entrypoint; it has been verified only across a clean reboot (the
  hard-reset path is not exercised). The ad2/adlab-ca kill loop is fixed by the host-only supervisor drop-in above, not by
  PR #34 (its generator fix is the second code follow-up). Incident record: memory
  `samba-ad-lab-service-restart-loop-2026-10-04`.
- The Power Mode quick-settings tile and the ppd `amd_pstate` boost `EINVAL` (CPB off in firmware) are not lab issues;
  they are tracked in memory `edt1-power-mode-cpb-disabled` and the cross-project todo. The lab no longer delays ppd, and
  nothing here could look at the tile itself.
