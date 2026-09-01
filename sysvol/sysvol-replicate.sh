#!/usr/bin/env bash
#
# Replicate SYSVOL from the PDC emulator to every other DC in the forest.
#
# WHY THIS EXISTS
#   Samba implements neither FRS nor DFS-R, the two mechanisms Windows uses to
#   replicate SYSVOL. DRS replicates the DIRECTORY (the GPO objects in LDAP);
#   nothing replicates the FILES. On a multi-DC Samba forest SYSVOL therefore
#   diverges permanently and silently from the moment the second DC is joined.
#   This script is the substitute. It is an operational obligation, not an
#   optimisation: without it (or an equivalent) a multi-DC Samba domain is
#   serving inconsistent policy.
#
# WHAT IT DOES
#   1. Asks the directory which DC holds the PDC emulator FSMO role. That DC is
#      the single source of truth, matching Microsoft's own convention that
#      GPMC edits go to the PDC emulator.
#   2. Starts a short-lived, read-only rsync daemon on it.
#   3. Every other DC pulls with  -a -X -H --delete  (see sysvol.env for why
#      --acls is deliberately excluded).
#   4. Every target then runs `samba-tool ntacl sysvolreset`, which re-derives
#      the POSIX ACLs from the SIDs in the NT ACL using that DC's OWN idmap.
#      Skipping this step leaves the target with the source's numeric uids and
#      gids, which mean different SIDs locally -- see README.md.
#   5. `samba-tool ntacl sysvolcheck` confirms each target.
#
# Run as root on the host.  --dry-run to see what would change.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./sysvol-lib.sh

DRY_RUN=0; QUIET=0; NO_RESET=0
while [[ $# -gt 0 ]]; do
    case "$1" in
        -n|--dry-run) DRY_RUN=1 ;;
        -q|--quiet)   QUIET=1 ;;
        --no-reset)   NO_RESET=1 ;;   # for demonstrating the failure mode only
        -h|--help)    sed -n '2,30p' "$0" | sed 's/^# \?//'; exit 0 ;;
        *) die "unknown option: $1" ;;
    esac
    shift
done
[[ $EUID -eq 0 ]] || die "must run as root (podman exec on rootful containers)"
[[ $QUIET -eq 1 ]] && exec >/dev/null

# Serialise: the timer must never start a second pass over a live one.
exec 9>"$SYSVOL_LOCK"
flock -n 9 || die "another sysvol-replicate is already running"

ensure_tools || warn "some DCs are missing tools; continuing"

SRC="$(pdc_emulator)" || die "could not determine the PDC emulator"
dc_up "$SRC" || die "PDC emulator $SRC is not running"
SRC_IP="$(dc_ip_of "$SRC")"
log "source of truth: $SRC ($SRC_IP), PDC emulator"

# The source's own copy must be sound before it is handed to four other DCs.
if ! podman exec "$SRC" samba-tool ntacl sysvolcheck >/dev/null 2>&1; then
    warn "$SRC fails sysvolcheck -- repairing the source before replicating"
    podman exec "$SRC" samba-tool ntacl sysvolreset \
        || die "$SRC sysvolreset failed; refusing to replicate a broken SYSVOL"
fi

rsyncd_start "$SRC" || die "could not start the rsync daemon on $SRC"
trap 'rsyncd_stop "$SRC"' EXIT

RC=0
for d in $(all_dcs); do
    [[ "$d" == "$SRC" ]] && { log "$d: is the source, skipping"; continue; }
    dc_up "$d" || { warn "$d: not running, skipping"; RC=1; continue; }

    flags=("${RSYNC_FLAGS[@]}")
    [[ $DRY_RUN -eq 1 ]] && flags+=(--dry-run --itemize-changes)

    out=$(podman exec "$d" rsync "${flags[@]}" \
            --port="$RSYNC_PORT" \
            "rsync://$SRC_IP/$RSYNC_MODULE/" "$SYSVOL_PATH/" 2>&1)
    rc=$?
    if [[ $rc -ne 0 ]]; then
        warn "$d: rsync failed (rc=$rc)"; echo "$out" | sed 's/^/      /' >&2
        RC=1; continue
    fi
    if [[ $DRY_RUN -eq 1 ]]; then
        # Classify. rsync's itemised flags put a change type in column 1-2:
        #   >f / <f / cd / cf  a real transfer or creation
        #   *deleting          a removal
        #   .f / .d            the entry exists and matches; only ATTRIBUTES differ
        #
        # Attribute-only churn is expected on EVERY pass and is not divergence:
        # `sysvolreset` rewrites security.NTACL on each target, and that blob
        # embeds a hash of the LOCAL POSIX ACL, so the target's xattr can never
        # be byte-identical to the source's. Reporting that as "would change"
        # would make the dry-run useless as a divergence check.
        content=$(echo "$out" | grep -cE '^(>|<|c)[fdLDS]|^\*deleting')
        attrs=$(echo "$out"   | grep -cE '^\.[fdLDS]')
        if [[ "$content" -gt 0 ]]; then
            log "$d: $content content change(s), $attrs attribute-only"
            echo "$out" | grep -E '^(>|<|c)[fdLDS]|^\*deleting' | sed 's/^/      /'
        else
            log "$d: in sync ($attrs attribute-only difference(s), expected)"
        fi
        continue
    fi

    if [[ $NO_RESET -eq 1 ]]; then
        warn "$d: --no-reset given; POSIX ACLs left carrying $SRC's numeric ids"
    else
        # Re-render POSIX ACLs from SIDs through THIS DC's idmap.
        if ! podman exec "$d" samba-tool ntacl sysvolreset >/dev/null 2>&1; then
            warn "$d: sysvolreset failed"; RC=1; continue
        fi
    fi

    if podman exec "$d" samba-tool ntacl sysvolcheck >/dev/null 2>&1; then
        log "$d: synced, ACLs re-derived locally, sysvolcheck clean"
    else
        warn "$d: sysvolcheck FAILED after sync"; RC=1
    fi
done

[[ $RC -eq 0 ]] && log "SYSVOL replication complete" || warn "SYSVOL replication finished with errors"
exit $RC
