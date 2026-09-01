#!/usr/bin/env bash
# Tear the lab down. Leaves images and the secret in place.
#
# State is PERSISTENT (see lab.env): by default `down` removes the CONTAINERS
# but KEEPS their state under $STATE_ROOT, so the next ./20-up.sh restores the
# same forest instead of provisioning a new one. Pass --purge to also delete
# the state and get a genuinely fresh forest on the next up.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./lab.env

PURGE=no
[[ "${1:-}" == "--purge" ]] && PURGE=yes

for i in $(seq 1 "$DC_COUNT"); do podman rm -f "$(dc_name $i)" >/dev/null 2>&1 && echo "  removed $(dc_name $i)"; done
for i in $(seq 1 "$CLIENT_COUNT"); do podman rm -f "$(client_name $i)" >/dev/null 2>&1 && echo "  removed $(client_name $i)"; done

if [[ "$PURGE" == "yes" ]]; then
    [[ $EUID -eq 0 ]] || { echo "  --purge needs root (state dirs are root-owned)"; exit 1; }
    for i in $(seq 1 "$DC_COUNT"); do rm -rf "$STATE_ROOT/$(dc_name $i)"; done
    for i in $(seq 1 "$CLIENT_COUNT"); do rm -rf "$STATE_ROOT/$(client_name $i)"; done
    echo "lab down and STATE PURGED under $STATE_ROOT (next up provisions a fresh forest)"
else
    echo "lab down; state retained under $STATE_ROOT (next up restores this forest). --purge to wipe."
fi
echo "(images and $ADMIN_PASS_FILE retained)"
