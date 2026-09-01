# .etcdefaults

Install-ready host `/etc` artifacts the lab depends on, captured from the
running host rather than written from memory. These are the pieces that live
**outside** the lab's own scripts, so without them the lab is not reproducible.

| Path here | Install to | Why |
|---|---|---|
| `containers/networks/static-edt.json` | `/etc/containers/networks/static-edt.json` (rootful podman) | The `static-edt` bridge (`172.15.4.0/24`, gw `.1`, `br-static-edt`, host-local IPAM, DNS enabled). Nothing in the lab creates it — `20-up.sh` assumes it exists. This is the one piece the lab cannot rebuild itself. |
| `chrony/conf.d/50-lab-serve.conf` | `/etc/chrony/conf.d/50-lab-serve.conf` | Makes `edt1` the lab's time source: serves NTP to the lab subnets and stays sane (orphan) if upstream is briefly unreachable. Upstream sync stays as the distro shipped it (authenticated NTS pool). |

Install (rootful podman + chrony), then restart the consuming service:

```bash
install -D -m0644 containers/networks/static-edt.json /etc/containers/networks/static-edt.json
install -D -m0644 chrony/conf.d/50-lab-serve.conf      /etc/chrony/conf.d/50-lab-serve.conf
systemctl restart chrony
```

Not shipped here (managed reversibly by `tools/install-tools.sh`, not
"defaults"): the `/etc/hosts` managed block mapping `dc1..dc5.ad.edt1.lab` and
the krb5 drop-in that host-side inspection uses. See
[../docs/reference/TOOLS.md](../docs/reference/TOOLS.md).
