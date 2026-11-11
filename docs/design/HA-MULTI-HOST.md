# Multi-host HA for the AD lab (design)

**Status:** design draft, **not final**; nothing built. Owner directive 2026-11-11:
AD-lab HA logic is worked out in its own session, in this repo. The phased plan is
in [`todo.md`](../../todo.md) under "HA: multi-host DCs".

**Gate (owner, 2026-11-11): "you cannot test this on edt1 until design is finalized
and fully stress tested."** Nothing is created, run or drilled on edt1 (not the
live lab, and not the testbed VMs, network or edy cluster, which would also live on
edt1) until two things are true:

1. the owner has signed off this design as final, and
2. the stress program (§12) has passed, with the owner approving where it runs.

The testbed scripts in `ha-testbed/` are written and syntax-checked but have
**never been run**.

## 1. Goal and inputs

Today all five DCs (`dc1`–`dc5`, realm `AD.EDT1.LAB`) run as rootful podman
containers on one host, `edt1`, on the static bridge `static-edt`
(`172.15.4.0/24`). If edt1 is down, the domain is down.

Inputs from the owner (2026-11-10/11):

- **mini-srv** (4 cores, 32 GB RAM, 512 GB disk, low power) comes online later
  as a **passive failover host**. It is netbooted with Ubuntu and the cockpit
  plugins, and edy-proxy-go controls it.
- edy-proxy-go gains an opt-in **Hosting Domain Authentication** capability.
  edy trusted nodes manage the AD lab on bare-metal host-cluster nodes. The
  controller either fails over between trusted nodes or runs only on the raft
  leader.
- **Balance DCs across the hosts** of the host cluster.
- Storage-core SMB will authenticate with Kerberos against these domains. edy's
  `settings/auth/kerberos` gets multi-domain binding and forest-GC suggestions.
- edy leadership decision L1/L4 (2026-11-07): a 2-node trusted cluster
  **requires a witness**, which is a flagged trusted node. Without one it runs
  degraded: `has_quorum=false`, no automatic takeover, and an alert.

## 2. The core principle: HA comes from AD replication, not from moving DCs

A DC is never "failed over" as a container instance. Each host runs its own
DCs, pinned to that host, and they stay live all the time. AD replication is
multi-master, so every DC on every host already holds the whole directory and
answers LDAP, Kerberos, DNS and SMB (SYSVOL). When a host dies, its DCs are
gone and the DCs on the other host keep serving.

So DC containers must **not** be admitted to edy's HA-subnet or
replicated-storage failover (Ceph RBD, block mirroring, qcow2 snapshots).
Starting a DC's state on another host from a replicated or snapshotted copy is
the **USN rollback** case ([FSMO-AND-RECOVERY §3.3](../operations/FSMO-AND-RECOVERY.md)).
Async block replication lags, so the copy is always slightly old. The only
legal way to move a DC is a **cold move** (stop it, copy the bind mount, never
start the source again) or **demote and join fresh**. We use demote/join.

Only three things are single-writer and need HA logic:

1. the **FSMO roles** (seven in Samba),
2. the **SYSVOL source of truth** (Samba has no DFS-R; the lab pushes from the
   PDC emulator, [SYSVOL.md](../reference/SYSVOL.md)),
3. **GPO edits**, which must land on that same SYSVOL source.

Everything in this design either guards those three or makes clients find a
live DC.

## 3. Topology and placement

### 3.1 Hosts as AD sites, routed, no L2 stretch

| Host | AD site | DC subnet (default) | DCs (target) | Role |
|---|---|---|---|---|
| edt1 | `edt1` | `172.15.4.0/24` (`static-edt`, unchanged) | `dc1`, `dc2`, `dc3` | **active**: holds all FSMO roles and the SYSVOL writer lease |
| mini-srv | `mini-srv` | `172.15.5.0/24` (new bridge `static-mini`) | `dc6`, `dc7` | **passive**: warm DCs, no roles, takes roles only on failover |

- **Each host gets its own routed subnet** and one AD site with that subnet.
  The KCC builds inter-site replication; clients prefer DCs in their own site
  and fall back to others. AD is built for this, and it needs no VXLAN/EVPN.
  The edy routers route between the two subnets (the WG/LAN underlay).
  Default: routed. L2 stretch is not needed for DCs.
- **At least one writable DC per host, two where capacity allows.** Two per host
  lets one DC be rebuilt or patched without the host losing its local DC.
  mini-srv's capacity budget for the failover profile: 2 DCs ≈ 1–1.5 GB RAM,
  < 1 core idle. That fits beside its 1 edge, 1 router and 1 trusted node.
- **Five DCs in total stays the target.** DCs `dc6`/`dc7` join on mini-srv
  first. Then `dc4`/`dc5` on edt1 are demoted, cleanly and one at a time, which
  frees their roles first (§4.1). DC numbers stay global (no per-host renaming).
  The host is a field in the placement map, not part of the name.
- **"Passive" means role placement, not cold standby.** mini-srv's DCs replicate
  and serve auth all the time (that is what makes failover instant for
  clients). Passive means they hold no FSMO roles and no SYSVOL writer lease
  while edt1 is healthy, and roles **fail back** to edt1 with hysteresis (§5.4).
- **Extra forests** (`ad2`, `ad2-dev`) get the same rule (≥1 DC per host) only
  after they get persistent state ([todo](../../todo.md), "Extra-forest DCs have
  no persistent state"). Until then they are single-host and excluded from HA.
- **Not failed over:** `client1`–`client10` and `rdp1`/`rdp2` (test fixtures),
  `adlab-ca`. They stay on edt1 and are down with it.

### 3.2 The placement map (desired state)

edy (the controller) owns one desired-state document per forest. Each host keeps
the last applied copy at `/var/lib/adlab/ha/placement.json`:

```json
{
  "forest": "AD.EDT1.LAB",
  "epoch": 42,
  "hosts": {
    "edt1":     {"site": "edt1",     "subnet": "172.15.4.0/24", "priority": 100, "dcs": ["dc1","dc2","dc3"]},
    "mini-srv": {"site": "mini-srv", "subnet": "172.15.5.0/24", "priority": 10,  "dcs": ["dc6","dc7"]}
  },
  "fsmo_home": {"pdc":"dc1","rid":"dc1","schema":"dc2","naming":"dc2","infrastructure":"dc3","domaindns":"dc1","forestdns":"dc1"},
  "fsmo_standby": "dc6",
  "sysvol_writer": {"dc": "dc1", "lease_epoch": 42}
}
```

`fsmo_home` keeps the role placement of [FSMO-AND-RECOVERY §1](../operations/FSMO-AND-RECOVERY.md),
squeezed onto three DCs. The DNS partition masters move from dc4/dc5 to dc1
when those two are demoted.

## 4. FSMO roles across hosts

### 4.1 Transfer (planned: drain, maintenance, failback)

`samba-tool fsmo transfer` between two live DCs. It is always safe and is the
only thing a drain or a failback uses. Before demoting a DC, all its roles move
to `fsmo_home` or `fsmo_standby`. The existing `v_dc_demote` must refuse while
the DC still holds a role.

### 4.2 Seize (unplanned: host loss), split by risk

Seizing is where corruption comes from. A role seized from a DC that is
actually alive gives two owners. For the RID master, two owners means
overlapping RID pools and **duplicate SIDs**. So the roles split into two
classes:

| Class | Roles | Seize policy on confirmed host loss | When the old holder returns |
|---|---|---|---|
| **A: auto** | PDC emulator, Infrastructure, DomainDnsZones, ForestDnsZones | **automatic** after fencing (§5) | Safe: it learns the new `fSMORoleOwner` by inbound replication and gives up the role. Microsoft documents the same rule for PDC and Infrastructure masters. |
| **B: manual** | RID master, Schema master, Domain naming | **never automatic.** Raise an alert. An operator seizes only if the host is gone for good, or a DC's RID pool is running low (`rIDAvailablePool` / `samba-tool dbcheck`). | **Must not come back.** If one was seized, every DC on the returning host that held it is **rebuilt**: metadata cleanup, then a fresh join. The host boots its DCs fenced (§5.3), so this happens before samba starts. |

Why class B can wait: each DC already holds a RID pool (500 RIDs) and asks for
the next one well before it runs out. Schema and naming changes do not happen
during an outage. One week without the RID master costs nothing in this lab;
one bad seize costs the forest.

## 5. Split brain, quorum and fencing

### 5.1 The problem with two hosts

With edt1 and mini-srv alone, "the other host is unreachable" means either
**it is dead** or **the link between us is cut**. Neither side can tell which.
If mini-srv seizes the PDC and takes the SYSVOL writer role during a partition,
there are two SYSVOL writers. The `--delete-after` push then destroys GPO edits
on one side when the partition heals.

Directory writes themselves are fine in a split: AD resolves them per attribute
by version and timestamp when replication resumes. Only the single-writer items
in §2 need a tiebreaker.

### 5.2 The witness signal is an edy raft lease

The AD lab does not run its own quorum. It uses edy's:

- The **controller** is the edy component running on the **raft leader** of the
  trusted cluster ("runs only on the raft leader"). When leadership moves, the
  controller moves with it.
- The trusted cluster must have **≥3 voters across ≥2 failure domains plus a
  witness**. With 1 trusted node on mini-srv and the rest on edt1, the edt1
  side always has the majority. Then mini-srv **can never confirm** that edt1
  is dead, so failover to it can never be automatic. A **witness voter outside
  both hosts** fixes that (owner decision L1/L4: a flagged trusted node; for
  example a tiny VM or SBC on separate power, or a cloud node).
- **Until a third-domain witness exists, failover is manual-attest.** The
  controller alerts, and an operator calls `ha-attest-host-dead edt1` (§7)
  after checking that edt1 really is down. That attestation stands in for the
  quorum vote. The rest of the flow is the same.

### 5.3 Leases and self-fencing (no power fencing needed)

mini-srv has no BMC and edt1 cannot be powered off remotely, so fencing is
**lease-based**: a host stops acting as a single writer by itself before anyone
else may take over.

1. The controller grants a **writer lease** to the host that holds the PDC role
   and the SYSVOL writer: `{host, epoch, expires_at}`. TTL is 60 s, renewed
   every 15 s through the host's edy agent.
2. Each host runs `adlab-ha-watchdog` (a systemd timer every 10 s; host-local,
   needs no network). It writes the lease into
   `/var/lib/adlab/ha/lease.json` and **self-fences** when the lease lapses:
   - SYSVOL replication from this host stops (freeze, no `--delete-after`),
   - the GPO and SYSVOL-writing verbs in `adlab-admin` refuse with
     `"not the SYSVOL writer (lease expired)"`,
   - the **DCs keep running and keep serving authentication**. Fencing a DC
     would only cut off the clients on that side; nothing about a running DC
     is unsafe in a partition.
3. The controller may take over (seize class A, grant the lease to the other
   host) only at `expires_at + grace` (grace = 5 min by default). That margin
   covers clock skew (both hosts are NTS-synced and within 1 s) and a slow
   watchdog. edt1's normal reboot (≈ 25 s to `multi-user`, + 45 s timer
   + ≈ 60 s lab start) fits inside it, so a reboot does not cause a failover.
4. **Epoch fencing on every mutating call.** The host keeps the highest epoch
   it has seen and rejects any call with a lower one (`409 stale_epoch`). A
   deposed leader's late calls bounce.
5. **Boot is fenced.** Under HA, `21-start.sh` (via `samba-ad-lab.service`)
   checks `placement.json` and `lease.json` first:
   - no valid lease: start the DCs **with SYSVOL frozen**;
   - the controller has marked a DC "rebuild" (it held a class-B role that was
     seized): **do not start that DC**.
   The controller then reconciles.

### 5.4 State machine (per forest)

```
            healthy(edt1 active)
                 │  edt1 heartbeat lost
                 ▼
            suspect ── edt1 back within lease+grace ──► healthy (no action)
                 │  lease expired + grace, AND (quorum says edt1 gone OR operator attested)
                 ▼
            failover: seize class A onto fsmo_standby (dc6); grant writer lease to mini-srv;
                      SYSVOL source := dc6; alert "class B roles stranded on dc1/dc2"
                 │
                 ▼
            degraded(mini-srv active)
                 │  edt1 returns; its DCs boot fenced (SYSVOL frozen)
                 ▼
            rejoin: rebuild any DC flagged for class-B seize; else let inbound
                    replication converge (fSMORoleOwner, all 5 NCs green, 0 failures)
                 │  healthy for HOLD = 30 min (hysteresis)
                 ▼
            failback: pull SYSVOL dc6 → edt1 DCs (edits made during the outage live there);
                      transfer class A back to fsmo_home; move writer lease to edt1
                 │
                 ▼
            healthy(edt1 active)
```

Failback is **automatic but preemption-delayed**, matching edy's "mini-srv
members are standby priority, preempting back with hysteresis". `HOLD` stops a
flapping edt1 from bouncing the roles.

## 6. Per-service HA

### 6.1 SYSVOL

Keep the proven design ([SYSVOL.md](../reference/SYSVOL.md)): one source,
read-only rsyncd, every other DC pulls with `-rlptD -X -H --delete-after`, then
`sysvolreset` and `sysvolcheck`. Three changes:

1. **The source comes from the lease, not only from the directory.** Today
   `sysvol-replicate.sh` asks the directory who holds the PDC role. In a split,
   or right after a host returns, a DC can still believe a stale owner. Under
   HA, a host replicates only if it holds a valid writer lease, and only from
   `placement.sysvol_writer.dc`. It also cross-checks the directory's PDC owner
   and freezes if the two disagree.
2. **Cross-host transport.** Each host's replicator updates **its own** DCs.
   The writer host serves the read-only rsyncd; the other host's DCs pull it
   across the routed link (port 873, limited to the DC subnets). Same flags.
3. **Failback pull.** Before the writer lease returns to edt1, edt1's DCs pull
   from the outage-time source once, so GPO edits made during the outage
   survive.

Rejected for now: a bidirectional sync (osync/unison: conflict semantics on
NTACL xattrs, and a second writer is the very thing we fence) and a replicated
filesystem (CephFS: `security.NTACL` xattrs and the idmap rules are unproven
there, and it would put a storage dependency under every DC). Revisit CephFS
once storage-core exists.

### 6.2 DNS

- Backend stays `SAMBA_INTERNAL`, AD-integrated. Zones replicate in
  DomainDnsZones/ForestDnsZones, which is already multi-master. Every DC is an
  authoritative server.
- **Clients must be given DCs from both hosts.** Today the edy DHCP scope hands
  out only `172.15.4.10` (dc1). Change it to one DC per host, local first
  (`172.15.4.10, 172.15.5.10`). Container clients get the same from
  `fix_ad_resolv`.
- Each host's DCs forward to their **local** edy router/resolver (on edt1 that
  is `172.16.4.1`, the current `FORWARDER`). A per-host `FORWARDER` goes in the
  placement map. Remember that samba reads `dns forwarder` only at start.
- Optional, later: a per-site **anycast DNS VIP** fronting the DCs' DNS
  (health-gated: SRV query for `_ldap._tcp.dc._msdcs`). This is the owner's
  "DNS anycast is the first user" item, and edy's anycast work owns it.
- edy side: the edy resolver needs **conditional forwarding** of `ad.edt1.lab`
  (and every extra forest) to the DCs, so non-domain edy clients and the
  storage-core SMB servers can find KDCs. Never create an `ad.edt1.lab` zone on
  edy: it blackholes every unlisted name (memory `samba-ad-lab-services`).

### 6.3 Time

The PDC emulator is the domain's time root in the Windows hierarchy, but in
this lab every DC serves its **host's** clock: `chronyd -x` with
`server host.containers.internal`, signed through `ntp_signd`, and each host
syncs the NTS pool. Moving the PDC role therefore changes nothing for time.
mini-srv needs the same `.etcdefaults/chrony/conf.d/50-lab-serve.conf` and the
same DC image. The health check alarms if the DCs on the two hosts differ by
more than 1 s (Kerberos allows 5 min).

### 6.4 Kerberos and storage-core SMB

- Clients and SMB servers locate KDCs by SRV (`_kerberos._tcp`,
  `_kerberos._tcp.<site>._sites`), so the second host is found automatically.
  The storage-core keytabs do not care which DC issued a ticket.
- Hints for edy `settings/auth/kerberos`: per realm, `dns_lookup_kdc = true`,
  with a static fallback `kdc =` list of one DC per host. For forest GC binding,
  suggest `_gc._tcp.<forest>` on 3268/3269 (LDAPS needs the DC certs; see
  `42-tls-from-edy-ca.sh`). Every Samba DC is a GC.

### 6.5 Backups (HA is not backup)

Run `samba-tool domain backup online` nightly on the passive host, with the
copies kept on the **other** host. That covers the deleted-OU and corrupt-forest
cases that replication spreads instead of fixing.

## 7. Management API (called by edy trusted nodes)

### 7.1 Shape

- **The executor is `adlab-admin`**: new `ha-*` verbs in the existing
  JSON-in/JSON-out verb table, so the Cockpit UI and edy share one
  implementation and one audit log. edy calls them on each host through its
  host agent (job exec as root). There is no new listening socket.
- **The controller is in edy** (raft leader). It holds the placement map and
  the lease, decides, and calls the verbs. The host side is a thin, idempotent
  reconciler that **refuses** anything unsafe locally (receiver authority): it
  never trusts the caller's view of the roles; it re-reads them from its own
  DCs.
- Every mutating verb takes `epoch` (§5.3) and `op_id`. A repeated `op_id`
  returns the first result and does nothing again.
- Results include `evidence`: the raw `fsmo show` / `showrepl` / `sysvolcheck`
  output the host acted on, so edy logs what the host saw, not what it assumed.

### 7.2 Verbs

| Verb | Mutates | Purpose / refuses when |
|---|---|---|
| `ha-status` | no | Host inventory: DCs and their state, site, roles held, replication (per NC: last success, failures), SYSVOL hash vs the writer's, chrony LI and offset, lease, epoch, capacity (RAM/CPU/disk free) |
| `ha-health --dc D` | no | Deep check of one DC: container up; ports 53/88/389/445/636/3268 listen; `ldapsearch` rootDSE; `kinit -k` of the machine account; SRV lookup through the DC itself; `drs showrepl` green; `sysvolcheck` |
| `ha-placement-apply --file` | yes | Store the desired placement and lease. Rejects a lower epoch. Plans only: returns the diff, does not deploy |
| `ha-dc-deploy --dc D --site S --ip IP` | yes | Join a new DC on **this** host (wraps `v_dc_promote` with an explicit name, IP, site and per-host forwarder). Refuses if the name or IP is in use, the capacity check fails, or the forest's last replication is older than 60 days (tombstone margin) |
| `ha-dc-remove --dc D` | yes | Clean demote and remove. Refuses if D holds a role, or if it would leave the host or the domain with no writable DC |
| `ha-dc-rebuild --dc D` | yes | Metadata cleanup from a live peer, wipe the state dir, fresh join. Used after a class-B seize or a tombstone/USN-rollback finding |
| `ha-fsmo-transfer --role R --to D` | yes | Graceful transfer. Both owners must be reachable |
| `ha-fsmo-seize --role R --to D --lease-proof P` | yes | Class A only, unless `--class-b --i-understand` from an operator. Requires a valid takeover proof: the expired lease plus a quorum or attestation token. Records the old holder for the rejoin check |
| `ha-sysvol-writer --dc D [--phase prepare\|commit]` | yes | Move the SYSVOL source (with the lease). A cold or out-of-date target pulls from the old writer first if it is reachable |
| `ha-drain` | yes | Maintenance: transfer every role off this host's DCs, give up the writer lease, then report `drained`. Refuses if no other host has a healthy DC to take the roles |
| `ha-undrain` | yes | Clears the drain flag. Roles come back only through the normal failback (hysteresis) |
| `ha-fence` / `ha-unfence` | yes | Stop or allow the host's single-writer functions by hand (SYSVOL, GPO verbs). DCs keep running |
| `ha-attest-host-dead --host H` | yes | Operator-only stand-in for a quorum vote while no witness exists (§5.2). Logged with who and why |
| `ha-rejoin-check` | no | After a return: which local DCs may start normally, which must be rebuilt, and why |
| `ha-lease-renew` | lease only | The 15 s heartbeat lease renewal (§7.3 v1.1 #2). Idempotent; op_id not stored; audited only when holder or epoch changes |
| `ha-attest-clear --host H` | yes | Drop an attestation when the host answers again (§7.3 v1.1 #4) |
| `ha-json` | — | The single machine entrypoint: one request envelope on stdin, one response envelope on stdout; dispatches to the verbs above (§7.3 v1.1 #1) |

### 7.3 Contract details (agreed with the "edy-proxy-go dev" session, 2026-11-11)

**Envelope (Q1).** Every request and every response is versioned.

```json
// request
{"schema_version": "adlab-ha/1", "verb": "ha-fsmo-transfer", "epoch": 42, "op_id": "c0ffee…",
 "args": {"role": "pdc", "to": "dc6"}}
// response
{"schema_version": "adlab-ha/1", "ok": true, "op_id": "c0ffee…", "epoch_seen": 42, "replayed": false,
 "result": {…}, "evidence": {"fsmo_show": "…"}, "error": null}
// error
{"schema_version": "adlab-ha/1", "ok": false, "op_id": "…", "epoch_seen": 43,
 "error": {"code": "stale_epoch", "message": "…", "retryable": false}}
```

- `epoch` and `op_id` are **required on every mutating verb**. They are optional
  on read-only verbs, which still report `epoch_seen`.
- The host keeps op_id results for 7 days. A replay returns the stored
  response with `replayed: true`.
- The major version must match. An unknown major returns
  `unsupported_schema`. Minor additions are additive and ignored by older
  readers. `ha-status` lists `supported_schemas`.
- Error codes: `stale_epoch`, `unsupported_schema`, `refused` (a local safety
  check failed; `message` says which), `busy` (another mutating op holds the
  host lock; retryable), `not_found`, `internal`. `retryable` comes from the
  receiver, never from a guess by the caller.

**`ha-status` bounds (Q2).** `ha-status` never runs `samba-tool` inline. A
host-local collector, the same timer as `adlab-ha-watchdog`, refreshes
`/var/lib/adlab/ha/status.json` every 15 s. It runs `drs showrepl`, `fsmo show`,
the SYSVOL hash and chrony checks per DC, with a 30 s budget per cycle.

- `ha-status` returns that snapshot plus `collected_at` and `age_s`.
- Target runtime is ≤ 1 s, hard ceiling 3 s, which fits under the
  controller's 10 s timeout.
- Payload is ≤ 64 KB (5 DCs × 5 NCs plus evidence summaries; full raw output
  only from `ha-health`).
- If the snapshot is older than 45 s, the controller reads it as "collector
  stalled": a warning, not proof the host is dead.
- `ha-health --dc D` is the slow deep check (≤ 30 s). Call it on demand or
  async, never on the heartbeat path.

**Privilege (Q3).** Collection needs root (rootful `podman exec`, `samba-tool`),
so the collector runs as root. **Reading** does not:

- `status.json` is `0640 root:adlab-ha`.
- `ha-status` and `ha-rejoin-check` can run as a dedicated unprivileged
  `adlab-ha` user through the agent.
- Every mutating verb runs as root through `adlab-admin` and enforces the
  epoch/op_id/safety checks itself (receiver authority). A non-root caller of
  a mutating verb is refused.

#### Contract v1.1: answers to edy PR #525 (Q1–Q10, 2026-11-11)

These answers are binding on both sides. Where an answer changes edy's
proposal, it is marked **change**.

1. **Entrypoint: `adlab-admin ha-json`**, confirmed. It reads **one** request
   envelope on stdin and writes **one** response envelope on stdout.
   - The envelope is printed even on a non-zero exit. Exit codes: 0 = `ok:true`,
     1 = error envelope, 2 = unreadable request (the envelope then carries
     `unsupported_schema` or `internal`).
   - edy's `printf %s "$1" | base64 -d | …` with the request in argv is
     acceptable, because envelopes carry no secrets. The receiving side never
     puts the request on its own argv.
   - **Reads work as `adlab-ha`** (`ha-status`, `ha-rejoin-check`). `ha-health`
     needs root (live `podman exec`), and so does every mutating verb. Run as
     `adlab-ha`, those return `refused` with "requires root".
   - Reads by `adlab-ha` are not written to the root audit log. Every root call
     is.
   - Ask to edy: restrict the agent to this one command (an allow-list entry
     for `adlab-admin ha-json`) rather than general `--enable-run-shell`, once
     the agent supports that.
2. **change: lease renewal gets its own verb, `ha-lease-renew`.** Sending
   `ha-placement-apply` every 15 s would write the audit log and the 7-day
   op_id store about 40k times a week, and mix rare placement changes with a
   heartbeat.
   - `ha-lease-renew {lease:{host, epoch, expires_at, ttl_s}}` is idempotent
     by construction. It accepts an op_id but does not store it. It is audited
     only when the lease holder or epoch changes.
   - `ha-placement-apply {placement, lease, proof?}` stays for real changes,
     with `hosts` keyed by **host GUID** (each entry also carries `name`).
   - **change: the lease carries `ttl_s`.** The host fences at
     `min(expires_at, local_receive_time + ttl_s)` on its **own** clock, so
     controller-to-host skew can only shorten a lease, never lengthen it.
3. **`ha-fsmo-seize` args** are confirmed as proposed. On top of edy's proof,
   the host enforces three things itself:
   - The proof's lease must match the host's own `lease.json` record for the
     old holder and epoch.
   - expiry + grace must have passed **by the host's own clock**.
   - **addition:** the host refuses (`refused: holder alive`) if the current
     role holder still answers an LDAP rootDSE probe from this host. That makes
     a seize from a partitioned but alive owner impossible even with a valid
     proof.
   - `class_b` needs `i_understand: true`, plus `actor` and `reason`; all three
     are written to the audit log.
4. **Attestation lifecycle.** Each surviving host stores it in
   `/var/lib/adlab/ha/attest.json`. It is good for **one** takeover and at most
   **60 min** from receipt, and is consumed by the first seize that uses it.
   The host drops it **itself** when it observes inbound replication from the
   attested host's DCs after the attestation time (proof the host is alive),
   recorded as `contradicted`. **addition:** `ha-attest-clear {host,
   attestation_id}` is the explicit drop that edy sends when the host answers
   again.
5. **`ha-status` fields**, confirmed with units:
   - All timestamps are **unix seconds UTC**: `collected_at`,
     `replication[].last_success`, `lease.expires_at`.
   - `age_s` is int; `epoch` is int; `lease` is an object or null; `fenced`
     and `drained` are bool.
   - `dcs[].state` is `running|down|rebuild|held`. **addition:** `held` means
     boot-fenced and not started.
   - `roles[]` uses samba role names (`pdc`, `rid`, `schema`, `naming`,
     `infrastructure`, `domaindns`, `forestdns`).
   - `time_offset_s` is a signed float; `chrony_li` is an int 0–3.
   - `sysvol_hash` and `sysvol_writer_hash` are lowercase sha256 hex.
   - `rid_pool_pct` is the **remaining** percentage as a float 0–100.
   - `last_inbound_age_days` is a float.
   - `capacity` is `{cpu_count, load1, mem_avail_mb, disk_free_gb}`.
6. **`ha-rejoin-check`** returns `{may_start[], must_rebuild{dc: why},
   held[], ok_to_unfence: bool}`, confirmed with two additions: `held` (DCs
   kept stopped pending a decision) and `ok_to_unfence`.
7. **The SYSVOL cycle is 5 min** (`sysvol-replicate.timer`
   `OnUnitActiveSec=5min`, the same on edt1 today), so warn after >2 cycles
   (>10 min) and page after >1 h, as in §8.
8. **Confirmed:** an operator attestation replaces **only** the quorum vote.
   Lease expiry plus the 5-min grace is still required, checked by the host's
   own clock (point 3).
9. **change: failback order.** edy's order would make SYSVOL's source disagree
   with the directory's PDC owner mid-way, and the replicator freezes on that
   disagreement (§6.1). The order is:
   1. Home host: `ha-sysvol-writer {dc: <home PDC DC>, phase: "prepare"}`
      pulls from the outage writer, with no switch.
   2. Outage host: `ha-fence` (stops GPO/SYSVOL writes there; DCs keep
      serving).
   3. `ha-fsmo-transfer` each class-A role to its `fsmo_home`.
   4. Home host: `ha-sysvol-writer {phase: "commit"}` does a final delta pull,
      then becomes the source.
   5. `ha-placement-apply` (new epoch, lease to home) on both hosts.
   6. Outage host: `ha-unfence`.

   If any step fails, stop and alert. Steps 1–2 are safe to repeat. After
   step 3, roll forward, not back.
10. **Epoch** bumps on failover, failback, a class-B seize **and any placement
    change** (DC added or removed, drain/undrain), so on every change of who
    may write or where DCs live. Renewals reuse it.
    - An equal-epoch `ha-placement-apply` is accepted **only if the document
      is identical** (canonical-JSON hash). Same epoch with different content
      means two controllers, so it returns `stale_epoch` and raises an alert.
    - An equal-epoch `ha-lease-renew` is always accepted.

**edy limits (recorded from edy, 2026-11-11):**
- The controller runs only where succession names that node master of
  `host_clusters` **with quorum**. Reachability is self-only today, which in
  practice means a single trusted node.
- Host calls need that host's agent connected to the controller node, with
  `--enable-run-shell` (see the allow-list ask in point 1).
- The witness location is still an owner decision: any member flagged as
  witness in a third failure domain.

### 7.4 edy side (for the edy-proxy-go session, not built here)

- Host-cluster entity: hosts by GUID, failure domain, `adlab_capable`, and
  the capacity profile.
- The **Hosting Domain Authentication** toggle per host cluster. Off means edy
  never calls a mutating `ha-*` verb.
- The controller loop on the raft leader: heartbeat each host (`ha-status`
  every 15 s), lease renewal, the state machine of §5.4, alerts.
- Conditional DNS forwarding for AD zones, DHCP DNS options with one DC per
  site, and the Kerberos settings hints of §6.4.

## 8. Health signals and alerts

| Signal | Source | Warn | Page |
|---|---|---|---|
| Host heartbeat | `ha-status` via edy agent | 1 missed | lease + grace passed |
| Replication | `drs showrepl` per NC | any failure > 15 min | > 4 h, or any NC > 24 h old |
| SYSVOL drift | hash vs writer | > 2 cycles | > 1 h |
| Time | chrony offset, LI | > 1 s | LI≠0 or > 60 s |
| Class-B roles on a dead host | `fsmo show` | always | > 24 h |
| RID pool | `dbcheck` / rIDAvailablePool | < 30 % | < 10 % |
| Tombstone margin | last inbound replication per DC | > 30 days | > 60 days (refuse to start, rebuild) |
| Witness | edy `has_quorum` | false | false and a host lost |

## 9. Failure scenarios (each one becomes a testbed drill, §10)

| # | Scenario | Expected outcome |
|---|---|---|
| D1 | edt1 clean reboot | No failover (fits in lease + grace). The writer lease is renewed after boot |
| D2 | edt1 hard power-off for 30 min | Class A seized onto dc6 at expiry + grace; auth continues on mini-srv; class-B alert. Fails back 30 min after edt1 is healthy; GPO edits made during the outage survive |
| D3 | Link cut, both hosts alive | Without the witness: edt1 keeps the roles (majority), mini-srv self-fences nothing (it holds no lease), auth works on both sides, directory writes converge on heal. With a witness on mini-srv's side: same, roles stay with the lease holder |
| D4 | Link cut, and the witness is with mini-srv | edt1's lease lapses and it self-fences SYSVOL/GPO; mini-srv takes class A after grace. On heal: rejoin plus failback. Never two SYSVOL writers |
| D5 | mini-srv down | No role change. Alert only |
| D6 | Operator drain of edt1 | Roles move to mini-srv by transfer (no seize); edt1 stops cleanly; undrain + failback |
| D7 | Class-B seize by an operator, then edt1 returns | dc1/dc2 flagged for rebuild, boot fenced, rebuilt by `ha-dc-rebuild`; no duplicate SIDs (`dbcheck`, a SID uniqueness scan) |
| D8 | Stale leader call (old epoch) | `409 stale_epoch`, no change |
| D9 | DC state restored from a snapshot (the negative test) | Detected by the health check (invocationID / USN mismatch reported by partners), DC quarantined and rebuilt |

## 10. Testbed: two test VMs (owner, 2026-11-11)

The design is built and drilled on **two throwaway VMs** that stand in for edt1
and mini-srv. The live lab and the shared lab VMs are never touched (memory
`shared-lab-vm-no-touch`).

- **Where they run is not decided** (gate above). The owner must approve the host
  before anything is created. `ha-testbed/` assumes a libvirt host with the
  edy root job runner; on edt1 that would be the isolated layout below.
- **VMs (owner, 2026-11-11):** two VMs running **Ubuntu** with **ssh** and the
  **cockpit plugins**. They are `adl-ha-a` (host A, "edt1") and `adl-ha-b`
  (host B, "mini-srv"), built by `ha-testbed/tb.sh` from the stock Ubuntu 24.04
  cloud image. The `edy-rapid-update` golden image is the wrong base for them:
  its hardening purges `openssh-server`, and its trap rules would flag cockpit
  and rootful podman. The VMs still use that stack's root runner share
  (`vm-runner-share.sh` and `rj -M`), so root work inside them goes through the
  same audited path. ssh is key-only for `eddie`. The cockpit/sudo password is
  generated into a 0600 file (`~/.config/adl-ha/eddie.pass`) and only its hash
  goes into the seed. Size: 4 vCPU / 8 GB / 40 GB each (B matches mini-srv's
  budget). Use `qemu-img` snapshots after the forest is up, so every drill
  starts from a known point. (Snapshots are fine **here** because the whole
  testbed forest is reverted together, all VMs at once. The USN-rollback rule
  is about restoring one DC while its partners move on.)
- **Isolated edy-proxy-go deployment (owner, 2026-11-11):** the testbed runs its
  **own** edy cluster and never integrates with edt1's deployment:
  - VM A runs the first-run "new cluster" path; VM B registers with a bundle
    minted by **VM A's** API. This is the `edy-testcluster` recipe, run inside
    the VMs.
  - edy listens only on `ha0`, with DHCP, PXE, netboot and ARP disabled.
  - Nothing points at the edt1 hub: no registration, no `172.20.10.1` DNS, no
    edt1 CA or NTP. The VMs use public resolvers and `ntp.ubuntu.com`.
- **Three networks per VM (owner, 2026-11-11):**
  1. **LAN** `lan0` on `192.168.2.0/24` (edt1's `bridge0`): A `.41`, B `.42`,
     static, below the BGW320's DHCP leases, gateway `.254`. It carries ssh,
     cockpit and apt egress. No port forwards point at these addresses.
  2. **An isolated subnet per VM**, VM-local: a podman bridge `adl-iso` inside
     the VM (A `172.31.4.0/24`, B `172.31.5.0/24`). It is not routed. It is for
     that VM's non-DC test containers. **DCs are not placed here** (owner).
  3. **A shared subnet on edt1** that both VMs reach (owner: "instead of an ha
     subnet, just a subnet on edt1 that they both have access to"): libvirt
     network `adl-shared`, `10.31.0.0/24`, with edt1 at `.1`. It has no forward
     (not routed to the LAN), no DHCP and no libvirt DNS. The VMs are `.11`/`.12`
     on `sh0`. **The DCs of both VMs live here**, on a podman macvlan `adl-dc` on
     `sh0`. Each VM hands out only its own range: A `10.31.0.16/28`, B
     `10.31.0.32/28`. The AD sites `adl-ha-a`/`adl-ha-b` are defined by those
     /28s, so site-aware DC location still works on one L2 subnet. Reserved
     VIPs: `.53` for anycast DNS (§6.2) and `.100` for the floating SYSVOL/GPO
     writer VIP (lease holder only, §5.3). Replication and the edy cluster also
     run here.
  - **Consequence for §3.1 (open):** the testbed puts DCs of both hosts on one
    shared L2 subnet, instead of the routed per-host subnets §3.1 proposes for
    the live pair. Whether the live edt1 + mini-srv layout follows the testbed
    (one shared DC subnet reachable from both hosts) or stays routed is an
    owner decision for the final design. Either way the AD-site and FSMO logic
    is the same. Sites come from address ranges, not from L2 boundaries.
- **Second trusted node join (confirmed by edy-proxy-go dev, from its PR #515
  two-trusted-node test).** B joins as a **trusted** node with a registration
  bundle, the same way an edge does. Caveats for `tb-edy.sh up`:
  - Both nodes must start with the **same fleet master password**, otherwise B
    mints its own CA and distrusts A. It is generated once into a 0600 file
    in `~/.config/adl-ha/` and handed over through the root-only runner share
    `secrets/`, deleted on use.
  - Set `EDY_VAULT_PASSPHRASE` on B, otherwise B has no vault passphrase.
  - Until registration completes, B's node id is its hostname, so its early
    key announcements are refused. This is harmless.
  - B's peer row for A is named `controller`.
  - Do **not** rely on edy agent self-update in the testbed: release
    self-update is blocked fleet-wide until the code-signing CA is trusted (an
    owner decision). Updates are the binary copy below.
- **Keep edy-proxy-go updated on both VMs (owner, 2026-11-11).** The testbed
  tracks current edy main and never drifts behind the edt1 fleet.
  - **Source:** the same promoted main build that `edy-testcluster` uses (the
    `main-check` worktree's stamped `EdyNetworkServices` plus its
    `edy-files.tgz`). The binary is copied in through each VM's runner share,
    so it never connects to edt1's deployment.
  - **Version check:** refuse a build whose `main.Version` is missing or `dev`.
  - **Rolling order:** B first, then A, the cluster founder. Each node updates
    only after the other is healthy: `/up` is 200, the version is the new one,
    peers are listed, and replication shows `failures==0`.
  - **Rollback:** keep the previous binary beside the new one, and roll back
    automatically if a check fails.
  - **When:** on every new promoted main build, plus a daily check. The
    trigger runs on the testbed host, so it is subject to the gate at the top
    and is not installed before sign-off. Each run is recorded in
    `ha-testbed/edy-versions.log`.
  - **Rule:** before every stress run (§12), both VMs must be on the current
    build.
  - Script: `ha-testbed/tb-edy.sh up|update|status`, to be written with the
    isolated-cluster setup.
- **Forest:** a separate test forest `HA.TEST.LAB` built from this repo's
  images and scripts, never joined to `AD.EDT1.LAB`. Its DCs sit on the shared
  subnet, with one AD site per VM. The DCs' DNS forwarder is the testbed's own
  edy node on `sh0`, never edt1's.
- **Secrets:** the test forest's administrator password is generated on the
  VM into a root-only `.secrets/administrator.pass` (0600), the same layout as
  the lab. edy API keys for the controller are minted with `edy-root-ops`
  `edy-token` into 0600 files. Nothing goes into the repo, argv or logs.
- **Controller and witness:** first a script-driven controller
  (`tools/ha-sim.sh`, it plays edy's role and calls the `ha-*` verbs through
  the VM runners), then the testbed's own isolated edy cluster once the edy
  controller exists. The witness for drill D4 is a third edy node in that same
  isolated deployment, never a node of edt1's fleet.
- **Load:** one VM build at a time, `uptime` first (edt1 was hard-reset by
  agent overload on 2026-10-04).

## 11. Decisions taken by default (owner may override)

| # | Decision | Default |
|---|---|---|
| 1 | Networking for DCs | Routed per-host subnets plus AD sites; no L2 stretch or anycast for DCs |
| 2 | DC split | edt1: dc1–dc3; mini-srv: dc6, dc7; demote dc4/dc5 afterwards |
| 3 | Auto-seize scope | Class A only (PDC, Infrastructure, both DNS masters). RID, Schema and Naming are manual |
| 4 | SYSVOL | Keep the single-source rsync push, gated by an edy writer lease; no bidirectional sync |
| 5 | Witness | Manual attestation until a third-failure-domain trusted node exists |
| 6 | Failback | Automatic after 30 min healthy |
| 7 | API | `ha-*` verbs in `adlab-admin`, called through the edy host agent; controller on the raft leader |
| 8 | Timers | Lease TTL 60 s, renewal 15 s, grace 5 min, HOLD 30 min |

**Owner decisions still open:**
1. **Design sign-off** (the gate at the top). Nothing runs before it.
2. **Where the testbed runs**, since it cannot be edt1 before sign-off and the
   stress pass. Options: edt1 later, after sign-off, using the isolated layout
   of §10; mini-srv once it is netbooted; or another host.
3. **The third-failure-domain witness.** This blocks only automatic failover
   (Phase 6).
4. **Live DC networking:** routed per-host subnets (§3.1) or one shared DC
   subnet reachable from both hosts (the testbed model, §10).

## 12. Stress program (must pass before any test on edt1)

"Fully stress tested" means every row below passes on the testbed, **repeatedly**,
with numbers recorded (rates and latencies, not just "it worked"; same style as
`stress/60-stress.sh`). Each run starts from the post-forest snapshot.

| # | Stress | Load while it runs | Pass criteria |
|---|---|---|---|
| S1 | **Failover soak:** D2 (hard power-off of A, then failback), 50 cycles | constant `kinit` + LDAP bind load from clients on both sides (`60-stress.sh` auth loop) | every cycle ends healthy; failover ≤ lease + grace + 2 min; failback only after HOLD; 0 duplicate SIDs (scan); 0 lost GPO edits (§6.1); auth errors only on A's side while A is down |
| S2 | **Partition flapping:** cut and heal `ha0` at random intervals (5 s – 10 min), 2 h, with and without the witness | user/group create on both sides, GPO edits on the writer | never two SYSVOL writers (lease log + rsync log); no seize while both sides are alive; all NCs converge after the final heal; `dbcheck` clean |
| S3 | **Lease edge cases:** heal exactly at expiry, at expiry + grace − 1 s and + 1 s; clock skew of ±2 s injected on one VM; watchdog killed or stalled | — | self-fence always happens before any takeover; stale-epoch calls rejected (D8) |
| S4 | **Replication under write load across hosts** | 10k users / 2k groups / 500 computers created on both hosts, password changes, deletes | inter-site convergence time recorded; 0 replication failures after the load; RID pools never exhausted |
| S5 | **SYSVOL churn:** 200 GPO edit/delete cycles on the writer, plus a failover in the middle | `70-smb.sh` SMB load on SYSVOL | hash identical on all DCs after each cycle; `sysvolcheck` clean; no NTACL loss |
| S6 | **Boot storms:** both VMs rebooted together, A first, B first, 20 times | — | boot fencing holds (SYSVOL frozen until a lease exists); no DC flagged for rebuild without cause |
| S7 | **Resource pressure on B** (mini-srv budget): B at 4 vCPU / 8 GB with the failover profile plus `stress-ng` at 80 % CPU and memory | S1 auth load | auth p99 latency recorded and below the agreed threshold (proposed: 500 ms); no OOM kill of samba |
| S8 | **Negative tests:** D7 (class-B seize then return) and D9 (snapshot-restored DC) | — | detected, quarantined, rebuilt; never silently rejoined |
| S9 | **Controller loss:** kill the edy leader during a failover, repeatedly | S1 auth load | the new leader resumes from the stored placement and epoch; no double seize; op_id replays are no-ops |

Exit for the program: all rows pass three runs in a row, results are written to
`docs/design/HA-STRESS-RESULTS.md`, and the owner reviews them. Only then is any
HA test proposed for edt1.
