#!/usr/bin/env bash
# Start an EXISTING lab after a host reboot or stop — no recreation, no
# provisioning, no joins. 20-up.sh builds the lab; this only brings it back.
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

echo "== starting clients and RDP targets =="
for i in $(seq 1 "$CLIENT_COUNT"); do
    podman start "$(client_name "$i")" >/dev/null && echo "  $(client_name "$i")"
done
for i in $(seq 1 "$RDP_COUNT"); do
    podman start "$(rdp_name "$i")" >/dev/null && echo "  $(rdp_name "$i")"
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
