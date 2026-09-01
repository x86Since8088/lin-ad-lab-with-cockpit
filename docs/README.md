# Documentation

The entry point for everything written down about this lab. The repo
[`README.md`](../README.md) covers building and running; this tree explains how
the pieces work and how to operate them.

## Layout

| Tree | Holds | Maintained? |
|---|---|---|
| `docs/reference/` | How a subsystem works, not tied to one change | yes, when the thing changes |
| `docs/operations/` | Runbooks — what an operator does, step by step | yes |

Module-local prose that used to live as scattered `README.md` files under
`tools/` and `sysvol/` has been migrated here as structured reference docs.

## Reference

| Doc | Subject |
|---|---|
| [reference/EDY-AGENT.md](reference/EDY-AGENT.md) | edy-proxy-go CA trust, endpoint agent, and client-auth certs on every container |
| [reference/SERVICES-PLACEMENT.md](reference/SERVICES-PLACEMENT.md) | Which of CA / DNS / DHCP / time is backed by edy-proxy-go vs. the DCs, and why |
| [reference/PERSISTENCE.md](reference/PERSISTENCE.md) | Persistent host storage for DC/client state; recreate no longer destroys the forest |
| [reference/SYSVOL.md](reference/SYSVOL.md) | SYSVOL replication (Samba has no DFS-R): the rsync design and its ACL/xattr rules |
| [reference/TOOLS.md](reference/TOOLS.md) | Host-side inspection tooling — inspect, ldap-web, addecode, JXplorer trust bundle |
| [reference/COCKPIT-ADLAB.md](reference/COCKPIT-ADLAB.md) | The Cockpit "AD Lab" dashboard and its `adlab-admin` verb API |

## Operations

| Runbook | For |
|---|---|
| [operations/LIFECYCLE.md](operations/LIFECYCLE.md) | The numbered lifecycle scripts, reboot recovery, and the acceptance gate |
| [operations/FSMO-AND-RECOVERY.md](operations/FSMO-AND-RECOVERY.md) | FSMO transfer/seize, tombstone reanimation, USN-rollback avoidance, forest recovery |
