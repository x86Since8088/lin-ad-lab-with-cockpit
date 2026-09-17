#!/usr/bin/env bash
# Bring up DC_COUNT domain controllers and CLIENT_COUNT clients, each with a
# distinct IP on the static network. DC1 provisions; DC2..N join as replication
# partners; clients join the realm.
#
# State is now PERSISTENT (see lab.env dc_state_args/client_state_args): each
# container bind-mounts /var/lib/samba etc. from $STATE_ROOT. Consequences:
#   - recreating a container with populated state does NOT re-provision — the
#     entrypoint sees sam.ldb and just starts samba, so `up` is idempotent and
#     non-destructive against an existing forest.
#   - to build a genuinely fresh forest, purge state first: ./99-down.sh --purge.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./lab.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
PASS_MOUNT="$ADMIN_PASS_FILE:/run/adminpass:ro"

wait_for_dc() {   # $1 = ip, $2 = label
    # Probe the DC's OWN address, not 127.0.0.1: a loopback-only bind answers
    # locally while being unreachable to every peer, which looks like success
    # and then fails the next join with CONNECTION_REFUSED.
    local i
    for i in $(seq 1 150); do
        # Prove reachability by CONNECTING to the DC's own address, not by
        # string-matching `ss` output: a wildcard bind prints 0.0.0.0:389 and
        # would never match "<ip>:389", and a loopback-only bind answers on
        # 127.0.0.1 while being useless to peers. Only a real connect settles it.
        if podman exec "$2" samba-tool domain info "$1" >/dev/null 2>&1 \
           && podman exec "$2" timeout 3 bash -c "cat </dev/null >/dev/tcp/$1/389" 2>/dev/null; then
            return 0
        fi
        sleep 2
    done
    return 1
}

echo "== DC 1 (provision) =="
n=$(dc_name 1); ip=$(dc_ip 1)
podman rm -f "$n" >/dev/null 2>&1 || true
podman run -d --init --name "$n" --hostname "$n" \
    --network "$NET" --ip "$ip" \
    --cap-add SYS_ADMIN,NET_ADMIN,SYS_TIME --security-opt seccomp=unconfined \
    -v "$PASS_MOUNT" $(dc_state_args 1) \
    -e ROLE=provision -e REALM="$REALM" -e DOMAIN_NB="$DOMAIN_NB" \
    -e DC_IP="$ip" -e FORWARDER="$FORWARDER" \
    -e ADMIN_PASS_FILE=/run/adminpass \
    "$IMG_DC" >/dev/null
echo "  $n at $ip — waiting for the directory to come up"
wait_for_dc "$ip" "$n" && echo "  $n is serving the domain" || { echo "  $n FAILED"; podman logs --tail 25 "$n"; exit 1; }

for i in $(seq 2 "$DC_COUNT"); do
    n=$(dc_name $i); ip=$(dc_ip $i)
    echo "== DC $i (join as replication partner) =="
    podman rm -f "$n" >/dev/null 2>&1 || true
    podman run -d --init --name "$n" --hostname "$n" \
        --network "$NET" --ip "$ip" \
        --cap-add SYS_ADMIN,NET_ADMIN,SYS_TIME --security-opt seccomp=unconfined \
        -v "$PASS_MOUNT" $(dc_state_args "$i") \
        -e ROLE=join -e REALM="$REALM" -e DOMAIN_NB="$DOMAIN_NB" \
        -e DC_IP="$ip" -e PEER_IP="$(dc_ip 1)" -e FORWARDER="$FORWARDER" \
        -e ADMIN_PASS_FILE=/run/adminpass \
        "$IMG_DC" >/dev/null
    echo "  $n at $ip — waiting for join to complete"
    wait_for_dc "$ip" "$n" && echo "  $n joined" || { echo "  $n FAILED"; podman logs --tail 30 "$n"; }
done

echo "== clients =="
for i in $(seq 1 "$CLIENT_COUNT"); do
    n=$(client_name $i); ip=$(client_ip $i)
    podman rm -f "$n" >/dev/null 2>&1 || true
    podman run -d --init --name "$n" --hostname "$n" \
        --network "$NET" --ip "$ip" \
        --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
        -v "$PASS_MOUNT" $(client_state_args "$i") \
        "$IMG_CLIENT" >/dev/null
    printf '  %-9s %-12s ' "$n" "$ip"
    # Spread clients across DCs so the join path is exercised against several.
    peer=$(dc_ip $(( (i % DC_COUNT) + 1 )))
    # With persistent state a recreated client is already joined; re-joining
    # would churn the machine credential. Skip the join when the PERSISTED
    # machine keytab still authenticates. Use kinit -k, not `net ads testjoin`:
    # these clients join via adcli and have no secrets.tdb, so testjoin -P
    # always fails while the keytab is the real, persisted credential. Fix
    # resolv.conf first (recreate reset it to aardvark) so the KDC resolves.
    fix_ad_resolv "$n" "$peer"
    kt_princ=$(podman exec "$n" bash -c "klist -k /etc/krb5.keytab 2>/dev/null | awk 'NR>3 && \$2 ~ /@/ {print \$2; exit}'")
    if [ -n "$kt_princ" ] && podman exec "$n" kinit -k "$kt_princ" >/dev/null 2>&1; then
        podman exec "$n" kdestroy >/dev/null 2>&1 || true
        echo "already joined (persisted machine keytab valid: $kt_princ)"
        continue
    fi
    if podman exec "$n" /usr/local/sbin/edy-domain-install \
         --role client --realm "$REALM" --domain-nb "$DOMAIN_NB" \
         --peer "$peer" --forwarder "$FORWARDER" --pass-file /run/adminpass \
         >/tmp/join-$n.log 2>&1; then
        echo "joined via $peer"
    else
        echo "JOIN FAILED via $peer (see /tmp/join-$n.log)"
    fi
done

# --- additional forests (multi-domain) --------------------------------------
# Each declared EXTRA_DOMAINS entry becomes an independent forest on its own
# podman network. Idempotent: an existing network is reused (its subnet read
# back), and a DC whose container already exists is left alone. Nothing here
# runs when EXTRA_DOMAINS is empty (the default), so the single-domain lab is
# unchanged.

# First free ${EXTRA_NET_BASE}.N /24 not already claimed by a podman network.
# Mirrors the plugin's _alloc_domain_subnet so both allocate the same way.
extra_alloc_net() {
    local used n=1
    used=$(podman network ls --format '{{.Name}}' | while read -r net; do
        podman network inspect "$net" \
            --format '{{range .Subnets}}{{.Subnet}} {{end}}' 2>/dev/null
    done | tr ' ' '\n' | sed -n "s#^${EXTRA_NET_BASE}\.\([0-9]\+\)\.0/24\$#\1#p")
    while echo "$used" | grep -qx "$n"; do n=$((n + 1)); done
    echo "$n"
}

if [[ ${#EXTRA_DOMAINS[@]} -gt 0 ]]; then
    for spec in "${EXTRA_DOMAINS[@]}"; do
        IFS=':' read -r xrealm xnb xslug xcount <<<"$spec"
        [[ -n "$xrealm" && -n "$xnb" ]] || { echo "!! bad EXTRA_DOMAINS entry: '$spec'"; continue; }
        xslug=${xslug:-$(echo "${xrealm%%.*}" | tr '[:upper:]' '[:lower:]')}
        xcount=${xcount:-1}
        xrealm=${xrealm^^}; xnb=${xnb^^}
        net="adlab-$xslug"
        echo "== domain $xrealm (forest on $net) =="
        if podman network exists "$net" 2>/dev/null; then
            prefix=$(podman network inspect "$net" \
                --format '{{range .Subnets}}{{.Subnet}}{{end}}' 2>/dev/null | sed 's#\.0/24$##')
            echo "  network $net exists ($prefix.0/24)"
        else
            n=$(extra_alloc_net); prefix="${EXTRA_NET_BASE}.${n}"
            podman network create "$net" --subnet "$prefix.0/24" >/dev/null
            echo "  created network $net ($prefix.0/24)"
        fi
        labels=( --label "adlab.realm=$xrealm" --label "adlab.domain_nb=$xnb"
                 --label "adlab.net=$net" --label "adlab.net_prefix=$prefix"
                 --label "adlab.dc_base=$EXTRA_DC_BASE" --label "adlab.slug=$xslug" )
        for i in $(seq 1 "$xcount"); do
            n=$(extra_dc_name "$xslug" "$i")
            ip="$prefix.$((EXTRA_DC_BASE + i - 1))"
            if [[ "$(podman inspect -f '{{.State.Status}}' "$n" 2>/dev/null)" == "running" ]]; then
                echo "  $n already running — skipping"; continue
            fi
            podman rm -f "$n" >/dev/null 2>&1 || true
            if [[ $i -eq 1 ]]; then
                role=provision; peer_env=()
                echo "== $xslug DC 1 (provision) =="
            else
                role=join; peer_env=( -e "PEER_IP=$prefix.$EXTRA_DC_BASE" )
                echo "== $xslug DC $i (join) =="
            fi
            podman run -d --init --name "$n" --hostname "$n" \
                --network "$net" --ip "$ip" \
                --cap-add SYS_ADMIN,NET_ADMIN,SYS_TIME --security-opt seccomp=unconfined \
                -v "$PASS_MOUNT" \
                -e ROLE="$role" -e REALM="$xrealm" -e DOMAIN_NB="$xnb" \
                -e DC_IP="$ip" -e FORWARDER="$FORWARDER" \
                -e ADMIN_PASS_FILE=/run/adminpass "${peer_env[@]}" \
                "${labels[@]}" --label "adlab.role=$role" \
                "$IMG_DC" >/dev/null
            echo "  $n at $ip — waiting for the directory"
            wait_for_dc "$ip" "$n" && echo "  $n serving $xrealm" \
                || { echo "  $n FAILED"; podman logs --tail 25 "$n"; }
        done
    done
fi

echo; echo "lab up. run ./30-verify.sh"
