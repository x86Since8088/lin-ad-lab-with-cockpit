# FSMO Roles, Restore Scenarios and Failure Drills

Operational plans for the `AD.EDT1.LAB` forest. Every procedure here is meant to
be **rehearsed in the 5-DC lab before it is ever needed in earnest** — that is
the whole point of building the lab at scale.

Samba is not Windows. Where its behaviour diverges from AD folklore, that is
called out explicitly, because following Windows instructions against Samba is
the most common way people destroy a directory.

---

## 1. The FSMO roles

Active Directory is multi-master for most operations, but five (Samba: **seven**)
operations must be single-master to avoid conflicts. Those are the Flexible
Single Master Operation roles.

| Role | Scope | What breaks if it's gone | Urgency |
|---|---|---|---|
| **Schema Master** | Forest | No schema changes — no new object classes/attributes | Low. Only matters during schema extension |
| **Domain Naming Master** | Forest | Cannot add/remove domains or application partitions | Low |
| **RID Master** | Domain | DCs cannot obtain new RID pools; once a DC exhausts its pool it cannot create users/groups/computers | **High** — silent until a DC runs dry |
| **PDC Emulator** | Domain | Password changes don't propagate urgently, account lockout is unreliable, time sync root is gone, GPO edits collide | **Highest** — user-visible within minutes |
| **Infrastructure Master** | Domain | Cross-domain group membership references go stale | Low in a single-domain forest |
| **DomainDnsZones Master** | Domain (Samba) | Updates to the domain DNS partition stall | Medium |
| **ForestDnsZones Master** | Forest (Samba) | Updates to the forest DNS partition stall | Medium |

> **Samba difference.** `samba-tool` exposes **seven** roles, not five: the two
> DNS partition masters are additional. Any runbook that says "there are five
> FSMO roles" is a Windows runbook and will leave two roles stranded.

### Placement plan for this 5-DC forest

Spreading roles limits the blast radius of losing any single DC, while keeping
the two latency-sensitive roles (PDC, RID) together on the best-connected DC.

| DC | Roles | Rationale |
|---|---|---|
| **dc1** | PDC Emulator, RID Master | The two roles with user-visible, time-critical impact. Co-located so password/lockout/RID traffic stays on one box |
| **dc2** | Schema Master, Domain Naming Master | Forest-wide, rarely exercised. Parked on a stable DC that is not doing auth-heavy work |
| **dc3** | Infrastructure Master | Harmless here (single domain, all DCs are GCs) |
| **dc4** | DomainDnsZones Master | DNS partition writes |
| **dc5** | ForestDnsZones Master | DNS partition writes; also the designated standby for seizure drills |

> **The Infrastructure Master / Global Catalog rule.** In a *multi-domain*
> forest the Infrastructure Master must not sit on a Global Catalog, or
> cross-domain phantom records never get updated. **Samba makes every DC a GC**,
> so in a multi-domain Samba forest the rule cannot be satisfied at all — it is
> moot in a single-domain forest like this one, but it hard-blocks a naive
> multi-domain design.

### Inspecting and moving roles

```bash
samba-tool fsmo show                                   # where do the roles live
samba-tool fsmo transfer --role=rid -U Administrator   # graceful, both DCs up
samba-tool fsmo seize   --role=rid -U Administrator    # owner is GONE and not coming back
```

Roles: `schema`, `naming`, `rid`, `pdc`, `infrastructure`, `domaindns`,
`forestdns`, or `all`.

**Transfer vs seize is not a style choice.**

- **Transfer** is a negotiated handover. Both DCs agree, state is consistent.
  Always prefer it. Requires the current owner to be reachable.
- **Seize** declares the previous owner dead and takes the role unilaterally.
  **A seized-from DC must never come back online.** If it does, you have two
  DCs each believing they own the role — for the RID Master that means
  overlapping RID pools and duplicate SIDs, which is corruption you cannot
  cleanly undo. Wipe the old DC before it ever boots again.

---

## 2. Restore scenarios

### 2.1 Non-authoritative restore — "this DC died"

The default and the safe one. You restore a DC from backup and **let the other
DCs overwrite anything stale in it** via replication. Used when hardware or the
container dies but the directory itself is fine.

```bash
# backup, taken routinely from any DC
samba-tool domain backup online --server=dc1 --targetdir=/backups -U Administrator

# restore onto a replacement
samba-tool domain backup restore \
    --backup-file=/backups/samba-backup-*.tar.bz2 \
    --targetdir=/var/lib/samba --newservername=dc3
samba-tool drs replicate dc3 dc1 DC=ad,DC=edt1,DC=lab
```

The restored DC's copy of any object loses to the newer copy elsewhere.
**This is what you want** when the DC was the problem.

> **Simpler alternative, and usually better:** if other DCs are healthy, do not
> restore at all. `samba-tool domain demote --remove-other-dead-server=dc3`
> from a survivor, then join a brand-new DC. A fresh join carries no risk of
> USN rollback (§3.3), which restoring from an image very much does.

### 2.2 Authoritative restore — "someone deleted the wrong OU"

The directory is healthy; the **data** is wrong, and replication has already
propagated the deletion everywhere. A non-authoritative restore is useless here:
the restored objects would simply be re-deleted by replication.

> **Samba difference — this is the big one.** Samba has **no equivalent of
> `ntdsutil authoritative restore`**. There is no supported "mark this subtree
> as authoritative and bump its version numbers" operation. Windows runbooks do
> not transfer.

Options for Samba, in order of preference:

**a) Tombstone reanimation** — the deleted object still exists, tombstoned,
until the tombstone lifetime expires (default 180 days). Undelete it in place,
which preserves its SID and group memberships:

```bash
samba-tool user undelete <username>
# or, for arbitrary objects, via the Deleted Objects container:
ldbsearch -H /var/lib/samba/private/sam.ldb --show-deleted \
    '(&(isDeleted=TRUE)(cn=*<name>*))' distinguishedName
```

Reanimation is far superior to any restore: identity is preserved, so ACLs and
group memberships elsewhere keep working.

**b) Restore to an isolated DC and re-create** — restore the backup on a DC with
**no network path to production**, extract the objects, and re-create them in
production. Simple and safe, but SIDs change, so every ACL referencing the old
SID must be re-applied.

**c) Full forest recovery** (§2.3) if the damage is broad.

**Prevention beats all three.** Enable the Recycle Bin *before* you need it —
it makes reanimation retain attributes rather than stripping them:

```bash
samba-tool domain recyclebin enable -U Administrator   # IRREVERSIBLE once enabled
```

### 2.3 Full forest recovery — "everything is compromised or corrupt"

Used after ransomware, schema corruption, or an unrecoverable replication split.

1. **Isolate.** Disconnect every DC from the network. Do not let survivors talk.
2. Choose **one** DC's backup as the source of truth — the most recent known-good.
3. Restore it standalone; it becomes the new forest root.
4. Seize **all seven** FSMO roles onto it: `samba-tool fsmo seize --role=all`.
5. Clean out every other DC's metadata:
   `samba-tool domain demote --remove-other-dead-server=<name>` for each.
6. Reset the `krbtgt` password **twice**, waiting for replication in between —
   this invalidates every outstanding Kerberos ticket, including golden tickets.
7. Rebuild the other DCs by **fresh join**, never by restoring images.
8. Only then reconnect clients.

Steps 4–7 are the ones people skip, and skipping them is how a "recovered"
forest reinfects itself.

---

## 3. Other failure scenarios worth rehearsing

### 3.1 Planned DC removal
```bash
samba-tool domain demote -U Administrator          # run ON the DC leaving
```
Transfer any FSMO roles off it **first** — demotion of a role holder without
transferring strands the role.

### 3.2 Unplanned DC loss (it is never coming back)
```bash
samba-tool domain demote --remove-other-dead-server=dc4 -U Administrator   # run on a SURVIVOR
samba-tool fsmo seize --role=<any it held> -U Administrator
samba-tool dbcheck --cross-ncs --fix                                       # sweep dangling references
```

### 3.3 USN rollback — the silent killer
Restoring a DC from a **snapshot or VM image** rather than a proper backup makes
it re-issue Update Sequence Numbers it has already used. Partners believe they
have already seen those changes, so they **silently ignore** everything that DC
originates from then on. It looks healthy and replicates nothing.

- **Cause:** container/VM snapshots, `podman commit` of a running DC, image restores.
- **Detect:** `samba-tool drs showrepl` looks clean while changes made on that DC
  never appear elsewhere.
- **Fix:** there is no repair. Demote, wipe, re-join.
- **Avoid:** never snapshot a live DC as a restore mechanism. Use
  `samba-tool domain backup` — it exists precisely to prevent this.

### 3.4 Tombstone lifetime expiry
A DC offline longer than the tombstone lifetime (default 180 days) has missed
deletions permanently and will resurrect deleted objects if reconnected.
**Never reconnect a long-offline DC.** Demote its metadata from a survivor and
rebuild it.

### 3.5 Time skew
Kerberos rejects tickets skewed more than 5 minutes. The PDC Emulator is the
time root; every other DC syncs from it, clients from their DC. Symptom is
`KRB5KRB_AP_ERR_SKEW` or joins that fail with no useful message. Check first —
it is the most common cause of "the domain is broken".

### 3.6 SYSVOL divergence
Samba does **not** replicate SYSVOL automatically (no FRS/DFS-R). It must be
synced externally, usually `rsync` from the PDC Emulator, or GPOs silently
differ per DC. Verify ACLs after any sync:
```bash
samba-tool ntacl sysvolcheck
samba-tool ntacl sysvolreset      # repair from the directory's view
```
This is a **standing operational obligation**, not a failure scenario — an
un-synced SYSVOL is the normal state of a fresh multi-DC Samba forest.

---

## 4. Drill schedule for the lab

Each maps to a script under `scenarios/`. Run them against the 5-DC lab, never
production.

| Drill | Proves |
|---|---|
| `fsmo-distribute` | Roles land per the placement plan; `fsmo show` agrees on all 5 DCs |
| `fsmo-transfer` | Graceful handover, both DCs agree afterwards |
| `fsmo-seize` | Role recovery when a holder is destroyed mid-flight |
| `dc-loss` | Survivor cleanup, metadata removal, `dbcheck` clean |
| `restore-nonauth` | Restored DC converges to the survivors' state |
| `reanimate` | Deleted user undeleted with SID and memberships intact |
| `usn-rollback` | Demonstrates the failure deliberately, so it is recognisable |
| `time-skew` | Join fails at >5 min skew, succeeds once corrected |
