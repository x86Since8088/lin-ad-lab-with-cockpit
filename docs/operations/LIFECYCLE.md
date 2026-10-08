# Lifecycle & recovery

Every script asserts `EUID -eq 0` and drives **rootful** podman; on this host
they run through the job runner (no interactive sudo). Numbering encodes order.

## The scripts

| Script | Does |
|---|---|
| `10-build.sh` | Build the DC and client images; generate the one lab secret (`.secrets/administrator.pass`, root-only, outside this tree). |
| `20-up.sh` | dc1 **provisions** the forest; dc2..dc5 **join** as replication partners; client1..client10 join the realm (spread across DCs). Idempotent and **non-destructive** — with persistent state present it starts existing DCs instead of re-provisioning. |
| `21-start.sh` | Bring an existing lab back after a host reboot/crash: start DCs in order, wait for dc1, start clients/RDP, restore AD DNS in `/etc/resolv.conf` (podman resets it to the aardvark gateway on every start), bounce rdp1's sssd, restart agents. |
| `22-persist.sh` | One-time migration of a running forest onto persistent host storage (`/opt/sc/lab-state`), preserving SYSVOL + NTACLs + the edy certs. See [../reference/PERSISTENCE.md](../reference/PERSISTENCE.md). |
| `30-verify.sh` | The **acceptance gate**: 8 checks — distinct IPs, all DCs present, replication healthy both directions, an object converges to every DC, every client joined, Kerberos issues tickets, SYSVOL populated + byte-identical on all DCs, `ntacl sysvolcheck` clean. |
| `40-agent.sh` | Install the edy-proxy-go CA into every container's trust store, the endpoint agent, and enroll a client-auth cert (idempotent). See [../reference/EDY-AGENT.md](../reference/EDY-AGENT.md). |
| `42-tls-from-edy-ca.sh` | Replace each DC's self-signed LDAPS cert with one issued by the edy CA, using the templates in `pki-templates.json`. `--check` verifies without changing. |
| `45-agent-verify.sh` | Gate for the agent rollout: binary present, CA trusted, client cert valid (key mode 600), agent running, and the controller has seen each agent recently. |
| `99-down.sh` | Remove the containers but **keep** persistent state (next `20-up.sh` restores the same forest). `--purge` also deletes state for a genuinely fresh forest. |

RDP targets have their own numbered scripts under `rdp/`
(`10-build-rdp.sh`, `20-up-rdp.sh`, `25-join-rdp.sh`, `30-test-rdp.sh`).
Scale/soak tests live in `stress/`.

## Prerequisite: the network

Nothing here creates the `static-edt` podman network — it is a host artifact.
Its definition is captured under [`.etcdefaults/`](../../.etcdefaults) so the
lab is reproducible; create it before the first `20-up.sh`.

## Reboot / crash recovery

The lab containers have no restart policy on purpose: `podman-restart` would
bring clients up in parallel, before LDAP is serving and with aardvark DNS
(no AD zone). State lives on persistent bind mounts, so nothing is lost.

`samba-ad-lab.timer` fires `samba-ad-lab.service` 45 s after boot, which runs
`21-start.sh` (ordered DC start, wait for LDAP, clients/RDP, restore AD DNS,
bounce rdp1 sssd, reinstall agents). Install it once:

```bash
./install-start.sh     # unit + bounded-restart drop-in + timer; enables the TIMER only
```

**Timer, not `WantedBy=multi-user.target`.** A unit wanted by
`multi-user.target` is implicitly ordered before it, so the ~75 s lab start
gated `multi-user.target` and everything `After=` it — on edt1
`power-profiles-daemon`, whose D-Bus activation then timed out in gnome-shell
(hidden Power Mode tile). The timer runs the same unit outside that transaction.
`install-start.sh` migrates a host that still has the service enabled; check
with `systemctl show multi-user.target -p After | grep -c samba-ad-lab` → `0`.

**Bounded restart** (`samba-ad-lab.service.d/10-bounded-restart.conf`:
`StartLimitIntervalSec=1h`, `StartLimitBurst=5`, `RestartSec=60`). The unit's
`Restart=on-failure` + `RestartSec=15` outlasted the default 10 s start-limit
window, so one persistent `21-start.sh` failure restarted it 275 times on
2026-10-04. After the limit trips:
`systemctl reset-failed samba-ad-lab.service && systemctl start samba-ad-lab.service`.

The unit is `KillMode=process`: the default `control-group` would SIGTERM
conmon when the oneshot exits and kill every lab container. Consequence: every
run logs "Unit process N (conmon) remains running after unit stopped" once per
lab container. Those are the live conmons of healthy containers (plus one per
`podman exec -d` agent), **not orphans** — never kill them. Manual recovery is
still:

```bash
./21-start.sh          # or: systemctl restart samba-ad-lab
# then, if a DC was destroyed, replication self-heals
```

### Failure mode: stale xrdp pidfile in an RDP target

`/run` is not a tmpfs inside the RDP targets, so a hard reset leaves
`/run/xrdp/xrdp-sesman.pid` (and `xrdp.pid`) in the container's writable layer.
On the next start that pid belongs to dbus or sssd, sesman refuses to start
("already running"), `rdp-entrypoint` exits 1, `21-start.sh`'s `podman exec`
on the target fails and so does the unit. Symptom: `podman logs rdp1` ends in
`FATAL xrdp-sesman did not start`.

Two fixes: `rdp-entrypoint.sh` removes the pidfiles before starting sesman
(only in containers created from a rebuilt image), and `21-start.sh` clears
them from the stopped container's layer before `podman start` — the existing
rdp1/rdp2 keep the old entrypoint in their image layer and rdp1 its domain join
in its writable layer, so they are never recreated. By hand, as root, with the
container stopped:

```bash
m=$(podman mount rdp1)
rm -f "$m/run/xrdp/xrdp-sesman.pid" "$m/run/xrdp/xrdp.pid"
podman unmount rdp1
podman start rdp1
```

If a destroy/recreate briefly removed a DC, its replication partners may show a
transient `WERR_NETNAME_DELETED` failure counter until the next successful
cycle; force it with `samba-tool drs replicate <dest> <dc> <NC>` for each naming
context, or just wait for the KCC.

## Time

`edt1` is the lab's time source (chrony), itself synced to an authenticated
upstream. The serving config is captured under `.etcdefaults/chrony/`.
