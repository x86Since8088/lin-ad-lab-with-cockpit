#!/bin/bash
# Entrypoint for both the provisioning DC and any replication partner.
#
# ROLE=provision  -> create a brand new forest/domain
# ROLE=join       -> join an existing domain as an additional DC (replication)
# ROLE=run        -> just start samba against existing state
set -euo pipefail

ROLE="${ROLE:-run}"
REALM="${REALM:?REALM required}"
DOMAIN_NB="${DOMAIN_NB:?DOMAIN_NB required}"
FORWARDER="${FORWARDER:-8.8.8.8}"
DC_IP="${DC_IP:?DC_IP required}"
PEER_IP="${PEER_IP:-}"
# Read the password from a mounted file, never from the environment:
# /proc/<pid>/environ exposes env vars to anything that can read the process.
ADMIN_PASS_FILE="${ADMIN_PASS_FILE:-/run/adminpass}"
[ -r "$ADMIN_PASS_FILE" ] || { echo "[dc-entrypoint] FATAL: cannot read $ADMIN_PASS_FILE"; exit 2; }
ADMIN_PASS="$(tr -d '\n' < "$ADMIN_PASS_FILE")"

log() { echo "[dc-entrypoint] $*"; }

# A DC must resolve its own domain via itself, or provisioning/join records go
# to the wrong place. During a JOIN we must resolve via the EXISTING DC first.
write_resolv() {
    local first="$1"
    { echo "search ${REALM,,}"
      echo "nameserver $first"
      [ "$first" != "$DC_IP" ] && echo "nameserver $DC_IP"
      echo "nameserver $FORWARDER"; } > /etc/resolv.conf
}

if [ ! -f /var/lib/samba/private/sam.ldb ]; then
    case "$ROLE" in
      provision)
        write_resolv "$FORWARDER"
        log "provisioning new forest $REALM ($DOMAIN_NB)"
        samba-tool domain provision \
            --use-rfc2307 \
            --realm="$REALM" \
            --domain="$DOMAIN_NB" \
            --server-role=dc \
            --dns-backend=SAMBA_INTERNAL \
            --adminpass="$ADMIN_PASS" \
            --host-ip="$DC_IP" \
            --option="dns forwarder=$FORWARDER"
        log "provision complete"
        ;;
      join)
        [ -n "$PEER_IP" ] || { log "PEER_IP required to join"; exit 2; }
        write_resolv "$PEER_IP"
        log "waiting for peer $PEER_IP to answer DNS for $REALM"
        for i in $(seq 1 60); do
            host -t SRV "_ldap._tcp.${REALM,,}" "$PEER_IP" >/dev/null 2>&1 && break
            sleep 2
        done
        log "joining $REALM as an additional DC (replication partner)"
        printf '%s' "$ADMIN_PASS" | samba-tool domain join "${REALM,,}" DC \
            -U "${DOMAIN_NB}\\Administrator" --password="$ADMIN_PASS" \
            --dns-backend=SAMBA_INTERNAL
        log "join complete"
        ;;
      *)
        log "no directory present and ROLE=$ROLE; nothing to start"; exit 3 ;;
    esac
fi

# Post-provision/join: always resolve via ourselves.
write_resolv "$DC_IP"

# Kerberos config produced by provisioning is authoritative.
[ -f /var/lib/samba/private/krb5.conf ] && cp -f /var/lib/samba/private/krb5.conf /etc/krb5.conf

# Restart an already-enrolled edy-agent across container restarts (the
# overlay keeps its binary and /etc/edy-agent state). First install and
# enrollment are 40-agent.sh's job. --manage-dns=false is load-bearing: the
# default would prepend the controller ahead of the DC's own resolver.
if [ -x /usr/local/bin/edy-agent ] && [ -s /etc/edy-agent/state.json ]; then
    (setsid /usr/local/bin/edy-agent run --manage-dns=false >>/var/log/edy-agent.log 2>&1 &)
    log "edy-agent restarted"
fi

log "starting samba (AD DC mode) as pid 1"
exec /usr/sbin/samba --foreground --no-process-group --debuglevel=1
