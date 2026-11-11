# ha-testbed: two isolated Ubuntu VMs for the HA design

Design: [docs/design/HA-MULTI-HOST.md](../docs/design/HA-MULTI-HOST.md) §10 and §12.

> **Approved to run on edt1 (owner, 2026-11-11)**, after the design sign-off. Isolated from the live lab and
> from edt1's edy deployment. HA tests against the live lab stay gated on the stress program (design §12).

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
- **Isolated edy-proxy-go** (built 2026-11-11): its own cluster. A (`adl-edy-a`) ran first-run "new cluster";
  B (`adl-edy-b`) joined as a second TRUSTED node via a bundle minted by A. Nothing registers with or uses
  edt1's edy deployment (verified: edt1's fleet lists no adl peers or registrations; the VMs use public DNS and
  the BGW320 route, and run no edy agent). edy listens only on sh0 + loopback (TCP 53/8080/8444).
  Replication verified both ways (A->B and B->A DNS records, 0 failures).
- **Cockpit plugins:** both VMs run the six plugins edt1 runs, at edt1's deployed versions (adlab 1.19.1,
  guac-rdp 1.11.1, headscale 1.1.1, secrets 0.5.2, tuner 1.0.1, wireguard 1.1.2). Payloads only: each `.env`
  is fresh from `.envdefault`, and no plugin unit is enabled.

Scripts:

| Script | What |
|---|---|
| `tb.sh net\|create\|status\|destroy` | the shared libvirt network and the VMs |
| `tb-plugins.sh VM [plugin…]` | copy edt1's deployed cockpit plugin payloads into a VM and install them |
| `tb-edy.sh up-a\|join-b\|reset-b\|status\|update\|stage` | the isolated edy cluster; `update` rolls B then A with a health gate and automatic rollback, logging to `edy-versions.log` |

Lessons (2026-11-11, folded into the scripts):
- `POST /api/setup/cluster` is local-only, so edy also listens on 127.0.0.1 (not reachable off the VM).
- Registration names must be in the certificates edy issues: use the VM hostnames (`adl-ha-a`/`adl-ha-b`, sh0 in
  `/etc/hosts`), not `edy-*.adlha.test`.
- **A joining trusted node must leave `pki.enabled` UNSET.** An explicit `true` makes it a CA origin that mints a
  second fleet root (B did, and re-issued its node cert from it). Unset = replica: adopts A's root via `ca_key`.
- `bootlog.enabled=false` alone left B listening on UDP `*:514`/`*:6666`; the addresses are pinned to loopback.
- `shred` cannot truncate on the 9p runner share; files there are removed with `rm`.

```bash
./tb.sh net --dry-run               # libvirt network adl-ha: no host IP, no forward, no dnsmasq
./tb.sh create adl-ha-a --dry-run   # prints the seed (hash masked) and the exact root job
./tb.sh status
./tb.sh destroy adl-ha-a --yes-destroy-adl-ha-a
```
