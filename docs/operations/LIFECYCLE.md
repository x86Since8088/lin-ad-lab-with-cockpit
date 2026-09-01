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

The lab containers have no restart policy, so after a reboot all 17 are
`exited` — but their state is on persistent bind mounts, so nothing is lost.
Recovery is a single step:

```bash
./21-start.sh          # then, if a DC was destroyed, replication self-heals
```

If a destroy/recreate briefly removed a DC, its replication partners may show a
transient `WERR_NETNAME_DELETED` failure counter until the next successful
cycle; force it with `samba-tool drs replicate <dest> <dc> <NC>` for each naming
context, or just wait for the KCC.

## Time

`edt1` is the lab's time source (chrony), itself synced to an authenticated
upstream. The serving config is captured under `.etcdefaults/chrony/`.
