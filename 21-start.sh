#!/usr/bin/env bash
# Start an EXISTING lab after a host reboot or stop — no recreation, no
# provisioning, no joins. 20-up.sh builds the lab; this only brings it back.
# samba-ad-lab.service runs this at boot (install-start.sh); do not give the
# containers a podman restart policy — clients need the DNS rewrite below.
#
# Why this script exists: podman regenerates /etc/resolv.conf on every
# container (re)start, silently reverting clients and RDP targets to
# aardvark DNS (the network gateway). Aardvark knows nothing about the AD
# zone, so every SRV lookup is NXDOMAIN and kinit fails with "Cannot find
# KDC for realm" while ports 88/389 remain perfectly reachable — first seen
# after the 2026-08-31 host reboot. The DCs fix themselves (dc-entrypoint
# rewrites resolv.conf on every start); everyone else is fixed here, with
# the same contents the join originally wrote: round-robin DC first, then
# the forwarder. resolv.conf is a bind mount — write in place; `mv` fails
# with EBUSY.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./rdp/rdp.env        # sources ../lab.env itself
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

echo "== starting DCs =="
for i in $(seq 1 "$DC_COUNT"); do
    n=$(dc_name "$i")
    podman start "$n" >/dev/null && echo "  $n" || { echo "  $n FAILED to start"; exit 1; }
done

echo "== waiting for dc1 to serve LDAP =="
ok=no
for t in $(seq 1 90); do
    podman exec "$(dc_name 1)" timeout 3 bash -c "cat </dev/null >/dev/tcp/$(dc_ip 1)/389" 2>/dev/null \
        && { ok=yes; break; }
    sleep 2
done
[[ $ok == yes ]] || { echo "dc1 never served LDAP"; exit 1; }
echo "  dc1 is serving"

# /run is not a tmpfs inside the RDP targets, so a hard reset leaves
# /run/xrdp/*.pid in their writable layer. sesman then sees "already running"
# (the pid now belongs to dbus/sssd), the container exits 1, the exec below
# fails and this script with it — samba-ad-lab.service looped 275x that way on
# 2026-10-04. rdp-entrypoint.sh now removes the files itself, but only in
# containers created from a rebuilt image; rdp1/rdp2 keep the old entrypoint in
# their image layer and rdp1 its domain join in its writable layer, so they must
# NOT be recreated — clear the files from the stopped container's layer instead.
# Never fatal: a miss only reproduces the old failure, which the bounded
# restart in samba-ad-lab.service.d/ now contains.
clear_stale_xrdp_pids() {   # $1 = container; no-op while it is running
    local n=$1 m f removed=""
    [[ "$(podman inspect -f '{{.State.Running}}' "$n" 2>/dev/null)" == true ]] && return 0
    m=$(podman mount "$n" 2>/dev/null) && [[ -d $m ]] \
        || { echo "  note: $n: podman mount failed; stale xrdp pidfiles not checked"; return 0; }
    for f in xrdp-sesman.pid xrdp.pid; do
        [[ -e "$m/run/xrdp/$f" ]] && rm -f "$m/run/xrdp/$f" && removed+=" $f"
    done
    podman unmount "$n" >/dev/null 2>&1 || true
    [[ -n $removed ]] && echo "  note: $n: removed stale$removed"
    return 0
}

echo "== starting clients and RDP targets =="
for i in $(seq 1 "$CLIENT_COUNT"); do
    podman start "$(client_name "$i")" >/dev/null && echo "  $(client_name "$i")"
done
for i in $(seq 1 "$RDP_COUNT"); do
    n=$(rdp_name "$i")
    clear_stale_xrdp_pids "$n"
    podman start "$n" >/dev/null && echo "  $n"
done

echo "== restoring AD DNS in clients and RDP targets =="
fix_resolv() {   # $1 = container, $2 = first nameserver
    podman exec "$1" bash -c "{ echo 'search ${REALM,,}'
                                echo 'nameserver $2'
                                echo 'nameserver $FORWARDER'; } > /etc/resolv.conf"
}
for i in $(seq 1 "$CLIENT_COUNT"); do
    n=$(client_name "$i")
    # Same spread the join used, so each client keeps talking to its DC.
    peer=$(dc_ip $(( (i % DC_COUNT) + 1 )))
    fix_resolv "$n" "$peer" && echo "  $n -> $peer"
done
for i in $(seq 1 "$RDP_COUNT"); do
    n=$(rdp_name "$i")
    fix_resolv "$n" "$(dc_ip 1)" && echo "  $n -> $(dc_ip 1)"
done

# The joined RDP target's sssd came up before DNS was fixed; bounce it so
# domain logins work without waiting out sssd's offline backoff.
n=$(rdp_name "$RDP_JOINED")
if podman exec "$n" bash -c 'pkill -x sssd 2>/dev/null; rm -f /var/lib/sss/pipes/*.sock; sleep 1; sssd -D'; then
    echo "  $n sssd restarted"
else
    echo "  WARN $n sssd restart failed"
fi

echo "== edy-agents =="
./40-agent.sh
