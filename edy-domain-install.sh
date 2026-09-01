#!/usr/bin/env bash
#
# edy-domain-install — turnkey domain installer for BOTH scenarios:
#
#   --role server --mode provision   create a new forest/domain (first DC)
#   --role server --mode join        add a replication partner (additional DC)
#   --role client                    join a Linux host to the realm
#   --verify                         report state, change nothing
#
# Designed to run identically inside a container or on a physical host. It is
# idempotent: re-running against an already-configured system reports and exits
# 0 rather than corrupting state.
#
# SAFETY: refuses to modify a PHYSICAL host unless EDY_ALLOW_HOST_JOIN=yes.
# The lab must pass its acceptance gate before a real machine is joined.
#
# The admin password is read from a FILE, never from argv — anything on the
# command line is world-readable in /proc/<pid>/cmdline for the process's life.

set -euo pipefail

ROLE=""; MODE=""; VERIFY=0
REALM=""; DOMAIN_NB=""; DC_IP=""; PEER=""; FORWARDER="8.8.8.8"
PASS_FILE=""; COMPUTER_OU=""

die()  { echo "[edy-domain-install] FATAL: $*" >&2; exit 1; }
log()  { echo "[edy-domain-install] $*"; }
ok()   { echo "[edy-domain-install]   OK   $*"; }
warn() { echo "[edy-domain-install]   WARN $*"; }

usage() { sed -n '3,20p' "$0" | sed 's/^# \?//'; exit "${1:-0}"; }

while (($#)); do
  case "$1" in
    --role) ROLE="$2"; shift 2 ;;
    --mode) MODE="$2"; shift 2 ;;
    --realm) REALM="$2"; shift 2 ;;
    --domain-nb) DOMAIN_NB="$2"; shift 2 ;;
    --dc-ip) DC_IP="$2"; shift 2 ;;
    --peer) PEER="$2"; shift 2 ;;
    --forwarder) FORWARDER="$2"; shift 2 ;;
    --pass-file) PASS_FILE="$2"; shift 2 ;;
    --computer-ou) COMPUTER_OU="$2"; shift 2 ;;
    --verify) VERIFY=1; shift ;;
    -h|--help) usage 0 ;;
    *) die "unknown argument: $1" ;;
  esac
done

[[ $EUID -eq 0 ]] || die "must run as root"

# ---------------------------------------------------------------- safety gate
in_container() {
    [[ -f /run/.containerenv || -f /.dockerenv ]] && return 0
    grep -qaE '(docker|podman|libpod|containerd)' /proc/1/cgroup 2>/dev/null && return 0
    [[ "$(systemd-detect-virt --container 2>/dev/null)" != "none" ]] && return 0
    return 1
}
if ! in_container && [[ $VERIFY -eq 0 ]]; then
    if [[ "${EDY_ALLOW_HOST_JOIN:-no}" != "yes" ]]; then
        die "refusing to modify a PHYSICAL host.
    This installer must pass its lab acceptance gate (5 DCs + 10 clients) first.
    To override deliberately:  EDY_ALLOW_HOST_JOIN=yes $0 ..."
    fi
    warn "operating on a PHYSICAL host because EDY_ALLOW_HOST_JOIN=yes"
fi

# ---------------------------------------------------------------- preflight
preflight() {
    local need_realm="$1"
    log "preflight"
    if [[ $need_realm -eq 1 ]]; then
        [[ -n "$REALM" ]] || die "--realm required"
        [[ "$REALM" == "${REALM^^}" ]] || die "realm must be UPPERCASE: ${REALM^^}"
    fi
    # Kerberos rejects a skew beyond 5 minutes; this is the single most common
    # cause of an otherwise inexplicable join failure.
    local sync; sync=$(timedatectl show -p NTPSynchronized --value 2>/dev/null || echo unknown)
    case "$sync" in
      yes) ok "clock synchronised" ;;
      no)  warn "clock NOT NTP-synchronised — Kerberos fails past 5 min skew" ;;
      *)   warn "clock sync state unknown (no systemd-timesyncd here)" ;;
    esac
    # A DC must have a resolvable, non-localhost hostname.
    local hn; hn=$(hostname -s 2>/dev/null || echo "")
    [[ -n "$hn" && "$hn" != "localhost" ]] || die "hostname is unset or localhost"
    ok "hostname: $hn"
    if [[ -n "$PASS_FILE" ]]; then
        [[ -r "$PASS_FILE" ]] || die "password file unreadable: $PASS_FILE"
        local m; m=$(stat -c %a "$PASS_FILE")
        [[ "$m" == "600" || "$m" == "400" ]] || warn "password file mode $m (want 600)"
        ok "password file present (contents never echoed)"
    fi
}

read_pass() { [[ -n "$PASS_FILE" ]] || die "--pass-file required"; tr -d '\n' < "$PASS_FILE"; }

# ---------------------------------------------------------------- verify
do_verify() {
    echo "=== role/state ==="
    if [[ -f /var/lib/samba/private/sam.ldb ]]; then
        echo "  directory  : PRESENT (this is a domain controller)"
        samba-tool domain info 127.0.0.1 2>/dev/null | sed 's/^/    /' || true
        echo "  DCs known to this directory:"
        samba-tool drs showrepl 2>/dev/null | grep -E '^[A-Za-z-]+\\' | sort -u | sed 's/^/    /' || \
          echo "    (drs showrepl unavailable)"
    elif command -v realm >/dev/null && realm list 2>/dev/null | grep -q .; then
        echo "  directory  : absent (this is a domain MEMBER)"
        realm list 2>/dev/null | sed 's/^/    /'
    else
        echo "  directory  : absent, not joined (standalone)"
    fi
    echo "=== kerberos ==="
    [[ -f /etc/krb5.conf ]] && grep -E 'default_realm|kdc =' /etc/krb5.conf | sed 's/^/  /' || echo "  no /etc/krb5.conf"
    klist -s 2>/dev/null && echo "  ticket cache: present" || echo "  ticket cache: none"
    exit 0
}
[[ $VERIFY -eq 1 ]] && do_verify

[[ -n "$ROLE" ]] || usage 1

# ---------------------------------------------------------------- server
install_server() {
    preflight 1
    [[ -n "$DOMAIN_NB" ]] || die "--domain-nb required"
    [[ -n "$DC_IP" ]] || die "--dc-ip required"
    local pass; pass=$(read_pass)

    if [[ -f /var/lib/samba/private/sam.ldb ]]; then
        ok "directory already present — nothing to do (idempotent)"
        return 0
    fi

    case "$MODE" in
      provision)
        log "provisioning new forest $REALM ($DOMAIN_NB)"
        printf 'search %s\nnameserver %s\n' "${REALM,,}" "$FORWARDER" > /etc/resolv.conf
        samba-tool domain provision \
            --use-rfc2307 --realm="$REALM" --domain="$DOMAIN_NB" \
            --server-role=dc --dns-backend=SAMBA_INTERNAL \
            --adminpass="$pass" \
            --host-ip="$DC_IP" \
            --option="dns forwarder=$FORWARDER"
        ok "forest provisioned"
        ;;
      join)
        [[ -n "$PEER" ]] || die "--peer <ip-of-existing-dc> required for join"
        log "joining $REALM as an additional DC via $PEER"
        printf 'search %s\nnameserver %s\nnameserver %s\n' "${REALM,,}" "$PEER" "$FORWARDER" > /etc/resolv.conf
        local i
        for i in $(seq 1 90); do
            host -t SRV "_ldap._tcp.${REALM,,}" "$PEER" >/dev/null 2>&1 && break
            sleep 2
        done
        host -t SRV "_ldap._tcp.${REALM,,}" "$PEER" >/dev/null 2>&1 \
            || die "peer $PEER never published _ldap._tcp.${REALM,,}"
        ok "peer is advertising the domain"
        samba-tool domain join "${REALM,,}" DC \
            -U "${DOMAIN_NB}\\Administrator" --password="$pass" \
            --dns-backend=SAMBA_INTERNAL
        ok "joined as replication partner"
        ;;
      *) die "--mode must be provision or join" ;;
    esac
    printf 'search %s\nnameserver %s\nnameserver %s\n' "${REALM,,}" "$DC_IP" "$FORWARDER" > /etc/resolv.conf
    [[ -f /var/lib/samba/private/krb5.conf ]] && cp -f /var/lib/samba/private/krb5.conf /etc/krb5.conf
    ok "server install complete"
}

# ---------------------------------------------------------------- client
install_client() {
    preflight 1
    [[ -n "$PEER" ]] || die "--peer <ip-of-a-dc> required"
    local pass; pass=$(read_pass)

    if realm list 2>/dev/null | grep -qi "^${REALM,,}"; then
        ok "already joined to ${REALM} — nothing to do (idempotent)"
        return 0
    fi

    printf 'search %s\nnameserver %s\nnameserver %s\n' "${REALM,,}" "$PEER" "$FORWARDER" > /etc/resolv.conf
    cat > /etc/krb5.conf <<KRB
[libdefaults]
    default_realm = ${REALM}
    dns_lookup_realm = false
    dns_lookup_kdc = true
    rdns = false
KRB
    log "discovering realm"
    realm discover "${REALM,,}" 2>&1 | sed 's/^/    /' || warn "realm discover found nothing (continuing)"

    log "obtaining a Kerberos ticket as Administrator"
    printf '%s' "$pass" | kinit "Administrator@${REALM}" 2>&1 | sed 's/^/    /' \
        || die "kinit failed — realm/DNS/time are the usual causes"
    ok "kinit succeeded"

    local args=(--verbose)
    [[ -n "$COMPUTER_OU" ]] && args+=(--computer-ou="$COMPUTER_OU")
    log "joining with adcli (low-level path, clearer errors than realmd)"
    if printf '%s' "$pass" | adcli join "${REALM,,}" -U Administrator --stdin-password "${args[@]}" 2>&1 | sed 's/^/    /'; then
        ok "adcli join succeeded"
    else
        warn "adcli failed; falling back to realm join"
        printf '%s' "$pass" | realm join --user=Administrator "${REALM,,}" 2>&1 | sed 's/^/    /' \
            || die "both adcli and realmd failed to join"
        ok "realm join succeeded"
    fi

    # sssd is what makes domain users resolvable through NSS/PAM afterwards.
    cat > /etc/sssd/sssd.conf <<SSSD
[sssd]
domains = ${REALM,,}
config_file_version = 2
services = nss, pam

[domain/${REALM,,}]
ad_domain = ${REALM,,}
krb5_realm = ${REALM}
realmd_tags = manages-system joined-with-adcli
cache_credentials = True
id_provider = ad
krb5_store_password_if_offline = True
default_shell = /bin/bash
ldap_id_mapping = True
use_fully_qualified_names = False
fallback_homedir = /home/%u
access_provider = ad
SSSD
    chmod 600 /etc/sssd/sssd.conf
    ok "sssd configured"
    ok "client install complete"
}

case "$ROLE" in
  server) install_server ;;
  client) install_client ;;
  *) die "--role must be server or client" ;;
esac
