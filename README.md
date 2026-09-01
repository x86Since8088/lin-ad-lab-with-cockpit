# lin-ad-lab-with-cockpit

**v1.0.0.20260901**

A containerized **Samba Active Directory lab** — five domain controllers, ten
Linux clients, and two RDP targets — with a **Cockpit dashboard** that manages
it the way the classic Windows consoles do (ADUC, GPMC, AD Sites & Services,
DNS, FSMO, replication), plus integration with an `edy-proxy-go` controller for
CA, DNS forwarding, DHCP and time.

Everything runs as rootful **podman** containers on one host (`edt1`) on a
static bridge network (`static-edt`, `172.15.4.0/24`). DC and client state is
persistent, so a reboot or a container recreate never loses the forest.

## What's here

| Area | Where |
|---|---|
| Lifecycle scripts (build → up → verify → down) | `*.sh` in the repo root |
| Domain controller image + entrypoint | `Containerfile.dc`, `dc-entrypoint.sh`, `edy-domain-install.sh` |
| Linux client image | `Containerfile.client` |
| RDP targets (xrdp + XFCE, domain-joined) | `rdp/` |
| SYSVOL replication (Samba has no DFS-R) | `sysvol/` |
| Scale / soak tests | `stress/` |
| Host-side inspection tooling (no host join) | `tools/` |
| edy-proxy-go agent + CA + client-cert rollout | `40-agent.sh`, `agent.env`, `agent-guids.txt` |
| DC LDAPS certs from the edy CA + PKI templates | `42-tls-from-edy-ca.sh`, `pki-templates.json` |
| **Cockpit "AD Lab" plugin** | `cockpit-adlab/` |
| Documentation | `docs/` (start at [docs/README.md](docs/README.md)) |
| Host `/etc` artifacts the lab needs | `.etcdefaults/` |

## Quickstart

Every privileged step runs as root through this host's job runner (there is no
interactive sudo); the scripts assert `EUID -eq 0` and drive rootful podman.

```bash
# 0. the static-edt podman network must exist first — see .etcdefaults/
# 1. build images + the one lab secret
./10-build.sh
# 2. bring up 5 DCs + 10 clients (dc1 provisions; dc2..5 join; clients join)
./20-up.sh
# 3. RDP targets
./rdp/10-build-rdp.sh && ./rdp/20-up-rdp.sh
# 4. trust anchor + agents + client certs on every container
./40-agent.sh
# 5. DC LDAPS certs issued by the edy CA
./42-tls-from-edy-ca.sh
# 6. acceptance gate (8 checks)
./30-verify.sh
```

After a host reboot the containers are `exited` but their state persists —
`./21-start.sh` brings the lab back (starts in order, restores AD DNS, restarts
agents). `./99-down.sh` removes containers but KEEPS state; `--purge` wipes it
for a fresh forest.

## Secrets

Lab credentials live **outside this tree** in a root-only `.secrets/` directory
(mounted read-only into containers at `/run/adminpass`). Nothing secret is
tracked here — the `.gitignore` is whitelist-based, so only the install-ready
set below is committed.

See [docs/README.md](docs/README.md) for the full documentation index and
[docs/operations/LIFECYCLE.md](docs/operations/LIFECYCLE.md) for the scripts in
depth.
