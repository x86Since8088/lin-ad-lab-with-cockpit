#!/usr/bin/env bash
#
# Copy idmap.ldb from the PDC emulator to every other DC, so that the numeric
# xids behind SYSVOL's POSIX ACLs mean the same SID everywhere.
#
# THIS IS THE SAMBA WIKI'S OWN ANSWER to the idmap problem, quoted from
# https://wiki.samba.org/index.php/SysVol_replication_(DFS-R) :
#
#   "You need to sync idmap.ldb from the DC holding the PDC_Emulator FSMO role
#    to all other DCS. This ensures that all DCs will use the same IDs. If you
#    do not sync idmap.ldb, you can and will get different IDs on each DC."
#
# It is an ALTERNATIVE to the approach sysvol-replicate.sh takes by default
# (drop --acls, let `samba-tool ntacl sysvolreset` re-derive POSIX ACLs from
# SIDs locally). Both produce a correct result. The trade-off:
#
#   sysvolreset          no surgery on a live DC, but flattens any non-default
#   (the default here)   ACL on the sysvol ROOT that is not represented in AD.
#                        GPO delegations survive -- they are re-derived from
#                        each GPO's nTSecurityDescriptor, which DRS replicates.
#
#   idmap.ldb sync       makes `rsync --acls` safe and preserves hand-set ACLs
#   (this script)        exactly, but overwrites a live local database on every
#                        other DC. Any file already owned by an old xid changes
#                        meaning the instant the mapping changes. On a DC whose
#                        only xattr-ACL'd data is SYSVOL that is harmless; on
#                        one that also serves files it is not.
#
# Not run by default. Run it deliberately, ideally right after joining a DC.
#
# Run as root on the host.  --check reports divergence without changing anything.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./sysvol-lib.sh
[[ $EUID -eq 0 ]] || die "must run as root"
CHECK=0; [[ "${1:-}" == "--check" ]] && CHECK=1

SRC="$(pdc_emulator)" || die "could not determine the PDC emulator"
log "reference idmap: $SRC (PDC emulator)"

IDMAP=/var/lib/samba/private/idmap.ldb
WORK="$(mktemp -d /tmp/idmap-sync.XXXXXX)"; trap 'rm -rf "$WORK"' EXIT

dump() {   # $1=dc -> "SID<TAB>xid" sorted
    podman exec "$1" ldbsearch -H "$IDMAP" '(objectClass=sidMap)' cn xidNumber 2>/dev/null \
      | awk '/^cn:/{s=$2} /^xidNumber:/{print s"\t"$2}' | LC_ALL=C sort
}

dump "$SRC" >"$WORK/ref"
log "$SRC has $(wc -l <"$WORK/ref") SID->xid mappings"

RC=0
for d in $(all_dcs); do
    [[ "$d" == "$SRC" ]] && continue
    dc_up "$d" || { warn "$d not running"; continue; }
    dump "$d" >"$WORK/$d"
    # Only mappings present on BOTH sides can conflict.
    conflicts=$(LC_ALL=C join -t"$(printf '\t')" "$WORK/ref" "$WORK/$d" 2>/dev/null \
                | awk -F'\t' '$2 != $3' | wc -l)
    if [[ "$conflicts" -eq 0 ]]; then
        log "$d: agrees with $SRC on every shared mapping"
        continue
    fi
    echo "    $d: $conflicts conflicting mapping(s), e.g."
    LC_ALL=C join -t"$(printf '\t')" "$WORK/ref" "$WORK/$d" 2>/dev/null \
      | awk -F'\t' -v s="$SRC" -v d="$d" '$2 != $3 {printf "      %-48s %s=%s  %s=%s\n", $1, s, $2, d, $3}' | head -6
    RC=1
    [[ $CHECK -eq 1 ]] && continue

    # tdbbackup produces a consistent snapshot of a live database; copying the
    # file directly can catch a half-written transaction.
    podman exec "$SRC" tdbbackup -s .sync "$IDMAP" >/dev/null 2>&1 \
        || { warn "$d: tdbbackup on $SRC failed"; RC=1; continue; }
    podman exec "$SRC" cat "$IDMAP.sync" > "$WORK/idmap.ldb" 2>/dev/null
    podman exec "$SRC" rm -f "$IDMAP.sync"
    [[ -s "$WORK/idmap.ldb" ]] || { warn "$d: empty idmap snapshot"; RC=1; continue; }

    podman exec "$d" cp -a "$IDMAP" "$IDMAP.before-sync" 2>/dev/null
    podman exec -i "$d" tee "$IDMAP" >/dev/null <"$WORK/idmap.ldb" \
        || { warn "$d: could not write idmap.ldb"; RC=1; continue; }
    podman exec "$d" net cache flush >/dev/null 2>&1
    # The POSIX ACLs on SYSVOL still hold the OLD numbers; re-derive them.
    podman exec "$d" samba-tool ntacl sysvolreset >/dev/null 2>&1 \
        && log "$d: idmap replaced (backup at $IDMAP.before-sync), cache flushed, SYSVOL ACLs re-derived" \
        || { warn "$d: sysvolreset failed after idmap sync"; RC=1; }
done

if [[ $CHECK -eq 1 ]]; then
    [[ $RC -eq 0 ]] && log "all DCs agree" || warn "divergence found (nothing changed; drop --check to fix)"
fi
exit $RC
