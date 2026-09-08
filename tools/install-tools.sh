#!/usr/bin/env bash
#
# install-tools.sh — install and configure everything needed to VIEW and INSPECT
#                    the samba-ad-lab directory from the host edt1.
#
# This host is deliberately NOT joined to AD.EDT1.LAB and must stay that way.
# Nothing here joins anything, creates a machine account, or writes to the
# directory. It installs client tooling and teaches local resolvers where the
# lab DCs are.
#
# Run it as root through the job runner (eddie cannot sudo):
#
#     cd ~/Documents/ClaudeSystem
#     ./submit-job.sh --wait install-ad-tools \
#         /srv/smb/share/sc/ai-orchestrator-group/ai-orchestrator-storage/\
#         projects/samba-ad-lab/source/tools/install-tools.sh
#
#   (path shown for the dev checkout; from an installed host, run the copy
#    under the checkout you actually have -- this script derives its own
#    location and does not care where that is.)
#
#   ./install-tools.sh                  install everything (idempotent)
#   ./install-tools.sh --no-gui         CLI only, skip jxplorer and its JRE
#   ./install-tools.sh --check          report state, change nothing
#   ./install-tools.sh --revert-resolution
#                                       undo the /etc/hosts block and the krb5
#                                       snippet; leave the packages alone
#
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
. "$HERE/../lab.env"

HOSTS_BEGIN="# >>> samba-ad-lab (edt1) BEGIN - managed by source/tools/install-tools.sh >>>"
HOSTS_END="# <<< samba-ad-lab (edt1) END <<<"
KRB_SNIPPET="/etc/krb5.conf.d/ad-edt1-lab.conf"

MODE=install; GUI=yes
for a in "$@"; do case "$a" in
    --no-gui)            GUI=no ;;
    --check)             MODE=check ;;
    --revert-resolution) MODE=revert ;;
    -h|--help)           sed -n '2,26p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 1 ;;
esac; done

step() { printf '\n== %s ==\n' "$*"; }
ok()   { printf '   ok    %s\n' "$*"; }
warn() { printf '   WARN  %s\n' "$*"; }

need_root() {
    [[ $EUID -eq 0 ]] && return 0
    cat >&2 <<EOF
This needs root, and eddie cannot sudo. Submit it as a job instead:

    cd ~/Documents/ClaudeSystem
    ./submit-job.sh --wait install-ad-tools $HERE/install-tools.sh

EOF
    exit 1
}

# --------------------------------------------------------------------------
# 1. packages
#
# Why each one is here:
#
#   ldap-utils        ldapsearch/ldapmodify. The ONLY tool on the host that can
#                     do an authenticated LDAP bind to these DCs, because it
#                     speaks SASL/GSSAPI. Everything in inspect.sh leans on it.
#   krb5-user         kinit/klist/kdestroy. Without a ticket nothing else works;
#                     these DCs refuse simple binds on port 389.
#   smbclient         brings smbclient AND `net`. `net ads search` is Samba's own
#                     authenticated LDAP client and, unlike samba-tool, it really
#                     does use the Kerberos ticket (see README).
#   samba-common-bin  samba-tool. Only useful from the host for the RPC/CLDAP
#                     subcommands (`domain info`, `dns query`); its LDAP path
#                     cannot authenticate on Ubuntu. Kept because those two
#                     subcommands are genuinely useful.
#   python3-samba     decodes the NDR blobs LDAP hands back as base64: objectSid,
#                     objectGUID, nTSecurityDescriptor, and repsFrom (which is
#                     how inspect.sh reports replication health without touching
#                     a container). Used by addecode.py and ldap-web.py.
#   ldb-tools         ldbsearch/ldbdump for OFFLINE inspection of a partition
#                     file copied out of a DC. No network, no credentials.
#   ldapvi            interactive: pulls a result set into $EDITOR as LDIF and
#                     writes back only what you changed. Speaks GSSAPI natively.
#   jxplorer          the only desktop LDAP browser still packaged in Ubuntu
#                     26.04. Pulls a JRE (~12 packages). --no-gui skips it.
# --------------------------------------------------------------------------
CLI_PKGS=(ldap-utils krb5-user smbclient samba-common-bin python3-samba ldb-tools ldapvi)
GUI_PKGS=(jxplorer)

do_packages() {
    step "packages"
    local want=("${CLI_PKGS[@]}"); [[ $GUI == yes ]] && want+=("${GUI_PKGS[@]}")
    local missing=()
    for p in "${want[@]}"; do
        dpkg -s "$p" >/dev/null 2>&1 && ok "$p already installed" || missing+=("$p")
    done
    if ((${#missing[@]} == 0)); then ok "nothing to install"; return; fi
    if [[ $MODE == check ]]; then warn "would install: ${missing[*]}"; return; fi
    echo "   installing: ${missing[*]}"
    DEBIAN_FRONTEND=noninteractive apt-get update -qq
    DEBIAN_FRONTEND=noninteractive apt-get install -y -o Dpkg::Use-Pty=0 "${missing[@]}" \
      || { warn "apt-get failed"; return 1; }
    for p in "${missing[@]}"; do dpkg -s "$p" >/dev/null 2>&1 && ok "$p installed"; done
}

# --------------------------------------------------------------------------
# 2. name resolution
#
# The host resolver is 8.8.8.8 and knows nothing about ad.edt1.lab. GSSAPI needs
# a NAME, not an address, because the service principal is ldap/<fqdn>@REALM —
# point ldapsearch at 172.15.4.10 and it will try to build ldap/172.15.4.10 and
# fail. So the DCs need forward and reverse names locally.
#
# /etc/hosts is used rather than reconfiguring systemd-resolved because it is
# the smallest possible change: it affects only these five names, survives
# reboots and podman network churn, and is removed by deleting one marked block.
# The host still resolves everything else through 8.8.8.8, and is still not
# joined to the domain.
#
# Reverse matters as much as forward: OpenLDAP canonicalises the target host
# before building the SPN, so the FQDN must be the FIRST name on each line.
# --------------------------------------------------------------------------
do_hosts() {
    step "/etc/hosts entries for the lab DCs"
    if [[ $MODE == check ]]; then
        grep -qF "$HOSTS_BEGIN" /etc/hosts && ok "managed block present" || warn "managed block absent"
        return
    fi
    local esc_b esc_e
    esc_b=$(printf '%s' "$HOSTS_BEGIN" | sed 's|[][\\/.*^$]|\\&|g')
    esc_e=$(printf '%s' "$HOSTS_END"   | sed 's|[][\\/.*^$]|\\&|g')
    if grep -qF "$HOSTS_BEGIN" /etc/hosts; then
        sed -i "/$esc_b/,/$esc_e/d" /etc/hosts
        ok "removed previous managed block"
    fi
    cp -a /etc/hosts "/etc/hosts.samba-ad-lab.bak"
    {
        echo "$HOSTS_BEGIN"
        echo "# The host is NOT domain-joined. These names exist only so GSSAPI can"
        echo "# build the ldap/<fqdn>@$REALM service principal, and so reverse"
        echo "# lookups canonicalise to the same name. FQDN must stay first."
        echo "# Undo with: install-tools.sh --revert-resolution"
        for i in $(seq 1 "$DC_COUNT"); do
            printf '%-14s %s %s\n' "$(dc_ip "$i")" "$(dc_name "$i").$DOMAIN_DNS" "$(dc_name "$i")"
        done
        printf '%-14s %s\n' "$(dc_ip 1)" "$DOMAIN_DNS"
        echo "$HOSTS_END"
    } >> /etc/hosts
    for i in $(seq 1 "$DC_COUNT"); do
        getent hosts "$(dc_name "$i").$DOMAIN_DNS" >/dev/null \
            && ok "$(dc_name "$i").$DOMAIN_DNS resolves" \
            || warn "$(dc_name "$i").$DOMAIN_DNS does not resolve"
    done
    getent hosts "$(dc_ip 1)" | grep -q "$DOMAIN_DNS" \
        && ok "reverse lookup of $(dc_ip 1) canonicalises to a lab FQDN" \
        || warn "reverse lookup missing — GSSAPI will fail"
}

# --------------------------------------------------------------------------
# 3. Kerberos realm
#
# /etc/krb5.conf already carries default_realm = AD.EDT1.LAB but has no [realms]
# entry for it, and SRV discovery (_kerberos._udp.ad.edt1.lab) cannot work
# through 8.8.8.8. Naming the KDCs explicitly in a drop-in fixes that without
# editing the distribution's krb5.conf. Undo = delete one file.
# --------------------------------------------------------------------------
do_krb5() {
    step "Kerberos realm drop-in ($KRB_SNIPPET)"
    if ! grep -q '^includedir /etc/krb5.conf.d/' /etc/krb5.conf 2>/dev/null; then
        warn "/etc/krb5.conf has no 'includedir /etc/krb5.conf.d/' — the drop-in will be ignored"
    fi
    if [[ $MODE == check ]]; then
        [[ -f $KRB_SNIPPET ]] && ok "present" || warn "absent"
        return
    fi
    { echo "# samba-ad-lab (edt1) — managed by source/tools/install-tools.sh"
      echo "# The host is NOT joined to this domain. This only lets local client"
      echo "# tools obtain tickets. Undo with: install-tools.sh --revert-resolution"
      echo "[realms]"
      echo "    $REALM = {"
      for i in $(seq 1 "$DC_COUNT"); do echo "        kdc = $(dc_name "$i").$DOMAIN_DNS"; done
      echo "        admin_server = dc1.$DOMAIN_DNS"
      echo "        default_domain = $DOMAIN_DNS"
      echo "    }"
      echo
      echo "[domain_realm]"
      echo "    .$DOMAIN_DNS = $REALM"
      echo "    $DOMAIN_DNS  = $REALM"
    } > "$KRB_SNIPPET"
    chmod 644 "$KRB_SNIPPET"
    ok "wrote $KRB_SNIPPET naming $DC_COUNT KDCs"
    grep -q "^\s*default_realm = $REALM" /etc/krb5.conf \
        && ok "default_realm is already $REALM" \
        || warn "default_realm in /etc/krb5.conf is not $REALM — use kinit user@$REALM explicitly"
}

# --------------------------------------------------------------------------
# 4. TLS trust for GUI clients
#
# Each DC self-signs with its own auto-generated CA. ldapsearch -Y GSSAPI does
# not need TLS (SASL already seals the connection at SSF 256), but any GUI doing
# a simple bind MUST use LDAPS, because these DCs run with
# 'ldap server require strong auth = Yes' and refuse simple binds on port 389.
# So collect the five CA certs into a PEM bundle (for OpenLDAP/curl) and a JKS
# (for JXplorer and anything else on the JVM).
# --------------------------------------------------------------------------
do_certs() {
    step "TLS trust bundle for the 5 DCs"
    if [[ $MODE == check ]]; then
        [[ -f $HERE/dc-ca.pem ]] && ok "dc-ca.pem present" || warn "dc-ca.pem absent"
        return
    fi
    command -v podman >/dev/null || { warn "no podman — skipping"; return; }
    local tmp; tmp=$(mktemp -d); local n=0
    : > "$tmp/bundle.pem"
    for i in $(seq 1 "$DC_COUNT"); do
        if podman cp "$(dc_name "$i"):/var/lib/samba/private/tls/ca.pem" "$tmp/ca$i.pem" 2>/dev/null; then
            cat "$tmp/ca$i.pem" >> "$tmp/bundle.pem"; n=$((n+1))
        else
            warn "could not read ca.pem from $(dc_name "$i")"
        fi
    done
    if (( n == 0 )); then warn "no CA certs collected"; rm -rf "$tmp"; return; fi
    install -m 644 "$tmp/bundle.pem" "$HERE/dc-ca.pem"; ok "dc-ca.pem ($n CA certs)"
    if command -v keytool >/dev/null; then
        rm -f "$HERE/dc-ca.jks"
        for i in $(seq 1 "$DC_COUNT"); do
            [[ -f "$tmp/ca$i.pem" ]] && keytool -importcert -noprompt -trustcacerts \
                -alias "dc$i-ca" -file "$tmp/ca$i.pem" \
                -keystore "$HERE/dc-ca.jks" -storepass changeit >/dev/null 2>&1
        done
        [[ -f "$HERE/dc-ca.jks" ]] && { chmod 644 "$HERE/dc-ca.jks"; ok "dc-ca.jks (password: changeit)"; }
    else
        warn "no keytool (JRE not installed) — skipping the Java truststore"
    fi
    # Prove the bundle actually validates a live DC rather than assuming it does.
    if echo | timeout 10 openssl s_client -connect "$(dc_ip 1):636" -CAfile "$HERE/dc-ca.pem" 2>/dev/null \
        | grep -q 'Verify return code: 0'; then
        ok "bundle verifies dc1's LDAPS certificate"
    else
        warn "bundle does NOT verify dc1's LDAPS certificate"
    fi
    rm -rf "$tmp"
    chown eddie:users "$HERE/dc-ca.pem" "$HERE/dc-ca.jks" 2>/dev/null || true
}

do_perms() {
    step "script permissions"
    for f in inspect.sh install-tools.sh addecode.py ldap-web.py; do
        [[ -f "$HERE/$f" ]] && { chmod 0775 "$HERE/$f"; ok "$f executable"; }
    done
}

do_revert() {
    need_root
    step "reverting resolution changes (packages are left installed)"
    local esc_b esc_e
    esc_b=$(printf '%s' "$HOSTS_BEGIN" | sed 's|[][\\/.*^$]|\\&|g')
    esc_e=$(printf '%s' "$HOSTS_END"   | sed 's|[][\\/.*^$]|\\&|g')
    if grep -qF "$HOSTS_BEGIN" /etc/hosts; then
        cp -a /etc/hosts /etc/hosts.samba-ad-lab.bak
        sed -i "/$esc_b/,/$esc_e/d" /etc/hosts
        ok "removed the /etc/hosts block (backup: /etc/hosts.samba-ad-lab.bak)"
    else
        ok "/etc/hosts had no managed block"
    fi
    [[ -f $KRB_SNIPPET ]] && { rm -f "$KRB_SNIPPET"; ok "removed $KRB_SNIPPET"; } \
                          || ok "$KRB_SNIPPET already absent"
    echo
    echo "   The host is back to its original resolver behaviour."
    echo "   Nothing else was touched: /etc/resolv.conf, systemd-resolved, and"
    echo "   /etc/samba/smb.conf were never modified by this script."
}

# ------------------------------------------------------------------- main --

case $MODE in
    revert) do_revert; exit 0 ;;
    check)  ;;
    *)      need_root ;;
esac

echo "samba-ad-lab host tooling — realm $REALM, ${DC_COUNT} DCs on $NET"
echo "mode: $MODE   gui: $GUI"
do_packages
do_hosts
do_krb5
do_certs
[[ $MODE == install ]] && do_perms

if [[ $MODE == install ]]; then
cat <<EOF

== next ==
   The host is installed but holds no Kerberos ticket. As eddie:

       cd $HERE
       ./inspect.sh ticket     # ticket without ever typing the password
       ./inspect.sh            # the full read-only sweep
       ./inspect.sh web        # browser UI on http://127.0.0.1:8389/

   See README.md for what each tool is good for, and for the one real trap:
   samba-tool cannot authenticate over ldap:// on Ubuntu.
EOF
fi
