# ha-testbed: two isolated Ubuntu VMs for the HA design

Design: [docs/design/HA-MULTI-HOST.md](../docs/design/HA-MULTI-HOST.md) §10 and §12.

> **DO NOT RUN YET.** Owner, 2026-11-11: *"you cannot test this on edt1 until design is finalized and
> fully stress tested."* These scripts are written, syntax-checked and dry-run only. Running them
> needs the owner's design sign-off and an approved host.

| VM | stands in for | lan0 (192.168.2.0/24, bridge0) | isolated subnet (in-VM podman `adl-iso`) | HA subnet ha0 (libvirt `adl-ha`) |
|---|---|---|---|---|
| `adl-ha-a` | edt1 | 192.168.2.41 | 172.31.4.0/24 | 10.31.0.11 |
| `adl-ha-b` | mini-srv | 192.168.2.42 | 172.31.5.0/24 | 10.31.0.12 |

HA subnet VIPs reserved: 10.31.0.53 (anycast DNS) and 10.31.0.100 (SYSVOL/GPO writer, lease holder only).
Each isolated subnet is reachable from the other VM only through a route over ha0.

- Ubuntu 24.04 (stock cloud image), ssh (key-only, `eddie`), cockpit + cockpit-podman, rootful podman, chrony.
- The cockpit/sudo password is generated into `~/.config/adl-ha/eddie.pass` (0600). The seed holds its hash only.
- Root work inside a VM goes through the edt1 job runner share (`rj -M adl-ha-a …`).
- **Isolated edy-proxy-go:** its own cluster (A = first-run new cluster, B registers with A). It never
  registers with or uses edt1's edy deployment (DNS, DHCP, CA, NTP). Not scripted yet (next step after sign-off).

```bash
./tb.sh net --dry-run               # libvirt network adl-ha: no host IP, no forward, no dnsmasq
./tb.sh create adl-ha-a --dry-run   # prints the seed (hash masked) and the exact root job
./tb.sh status
./tb.sh destroy adl-ha-a --yes-destroy-adl-ha-a
```
