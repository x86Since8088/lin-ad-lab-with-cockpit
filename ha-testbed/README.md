# ha-testbed: two isolated Ubuntu VMs for the HA design

Design: [docs/design/HA-MULTI-HOST.md](../docs/design/HA-MULTI-HOST.md) §10 and §12.

> **DO NOT RUN YET.** Owner, 2026-11-11: *"you cannot test this on edt1 until design is finalized and
> fully stress tested."* These scripts are written, syntax-checked and dry-run only. Running them
> needs the owner's design sign-off and an approved host.

| VM | stands in for | lan0 (192.168.2.0/24, bridge0) | isolated subnet (in-VM podman `adl-iso`, no DCs) | sh0: shared subnet on edt1 (libvirt `adl-shared`, 10.31.0.0/24) | DC addresses (macvlan `adl-dc` on sh0) |
|---|---|---|---|---|---|
| `adl-ha-a` | edt1 | 192.168.2.41 | 172.31.4.0/24 | 10.31.0.11 | 10.31.0.16/28 |
| `adl-ha-b` | mini-srv | 192.168.2.42 | 172.31.5.0/24 | 10.31.0.12 | 10.31.0.32/28 |

- **Shared subnet** (owner: "just a subnet on edt1 that they both have access to"): edt1 holds 10.31.0.1. It has no
  forward (not routed to the LAN), no DHCP and no libvirt DNS. **The DCs of both VMs live here.** AD sites are per VM,
  defined by the /28 ranges. Reserved VIPs: 10.31.0.53 (anycast DNS) and 10.31.0.100 (SYSVOL/GPO writer, lease holder only).
- **Isolated subnets** are VM-local and not routed: for that VM's non-DC test containers only.
- macvlan caveat: a VM cannot reach its own DCs' macvlan IPs over sh0 (macvlan parent isolation). Health checks from the
  VM use `podman exec`, or add a macvlan shim interface on the VM when the edy node needs to reach local DCs over the network.

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
