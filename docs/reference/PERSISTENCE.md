# Persistent storage for DCs and clients

Goal (2026-09-01): DC and client state must survive **recreation**
(`podman rm` / `20-up.sh`), not merely restart. Before this the containers had
no state volumes at all — a recreate wiped `/var/lib/samba` and silently
re-provisioned a brand-new forest (different SID), and every crash/reboot
needed `21-start.sh` just to get back to a working directory.

## What persists, and where

Bind mounts under **`/opt/sc/lab-state/<container>/`** (not named volumes:
visible, backup-able, and `/opt/sc` preserves `security.*` xattrs, which
samba's SYSVOL NTACLs require — a store that drops them silently reproduces
the empty-SYSVOL / `BUILTIN\Guests` incidents).

| Container | Mounts |
|---|---|
| dc1..dc5 | `/var/lib/samba` (forest: sam.ldb, private/tls = the EDY certs, sysvol, per-DC idmap), `/etc/samba` (smb.conf incl. the `172.16.4.1` forwarder), `/etc/edy-agent` (agent enrollment) |
| client1..client10 | `/etc/sssd`, `/var/lib/sss`, `/etc/edy-agent`, and `/etc/krb5.keytab` (the machine credential, a file bind-mount) |

Wired in `lab.env` (`dc_state_args` / `client_state_args`, which create the
dirs on demand) and consumed by `20-up.sh`. Because bind mounts *shadow*
rather than copy-up, an empty state dir means "not provisioned yet" (the
entrypoint provisions into it) and a populated one means "already a DC / joined
client" (it just starts) — so `up` is now idempotent and non-destructive.

## Consequences / how to operate

- **Recreate is safe.** `20-up.sh` against an existing lab reattaches state:
  DCs skip provisioning (sam.ldb present), clients skip the join (persisted
  keytab still authenticates — checked with `kinit -k`, not `net ads testjoin`,
  because these are adcli-joined clients with no secrets.tdb).
- **Fresh forest:** `./99-down.sh --purge` deletes the state dirs; the next
  `up` provisions anew. Plain `./99-down.sh` keeps state.
- **Reboot/crash:** `21-start.sh` still restores resolv.conf + agents, and now
  the state it starts is on durable host storage.
- The agent binary is not persisted (it is not in the image); `40-agent.sh`
  reinstalls it after a recreate and restarts each agent under its SAME pinned
  identity because `/etc/edy-agent` persists.

## Migration (one-time, done 2026-09-01)

`22-persist.sh` moved the LIVE forest onto this storage in place — NOT a
re-join, which would have lost the non-replicated SYSVOL and the EDY certs.
Per container: `podman stop` (clean tdb/ldb flush) → `podman mount` →
`tar --xattrs --xattrs-include='*.*' --acls` into the host dir (NTACLs verified
byte-identical first) → recreate with mounts → verify against the baseline
(SID, 505 users, sysvol hash, `ntacl sysvolcheck`), aborting on any mismatch.
Proven by destroying and recreating dc3+client3 (and independently dc5+client8):
the forest returned identical with no re-provision. Worst-case recovery for a
single corrupted DC state dir is still a re-join from a surviving peer.
