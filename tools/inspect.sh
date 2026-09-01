#!/usr/bin/env bash
#
# inspect.sh — a ready-made, read-only view of the samba-ad-lab directory,
#              run from the HOST (edt1), which is deliberately NOT domain-joined.
#
# Everything in here is a query. Nothing writes to the directory, nothing
# restarts a container, nothing changes host configuration.
#
#   ./inspect.sh              # the full sweep
#   ./inspect.sh ticket       # get/refresh a Kerberos ticket (asks the job runner)
#   ./inspect.sh <section>    # one section, see `./inspect.sh help`
#
# Authentication: everything uses a Kerberos ticket via GSSAPI. There is no
# password anywhere in this script, and no password is ever passed on a command
# line — argv is world-readable through /proc.
#
set -uo pipefail

HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
LAB="$(dirname "$(dirname "$HERE")")"          # /opt/sc/git/samba-ad-lab
. "$HERE/../lab.env"

DC="${AD_DC:-dc1.$DOMAIN_DNS}"
BASE="DC=ad,DC=edt1,DC=lab"
CONFIG="CN=Configuration,$BASE"
CONF="$HERE/smb.lab.conf"
export TERM="${TERM:-xterm}"                   # ldapvi refuses to start without it

# Prefer the lab-specific ccache the `ticket` action creates, but never stomp on
# a ticket the user already chose.
if [[ -z "${KRB5CCNAME:-}" && -r "/run/user/$(id -u)/krb5cc_ad_edt1_lab" ]]; then
    export KRB5CCNAME="FILE:/run/user/$(id -u)/krb5cc_ad_edt1_lab"
fi

bold=$'\033[1m'; dim=$'\033[2m'; red=$'\033[31m'; off=$'\033[0m'
[[ -t 1 ]] || { bold=""; dim=""; red=""; off=""; }
h()  { printf '\n%s== %s ==%s\n' "$bold" "$*" "$off"; }
note(){ printf '%s   %s%s\n' "$dim" "$*" "$off"; }
die() { printf '%s%s%s\n' "$red" "$*" "$off" >&2; exit 1; }

# ldapsearch with GSSAPI, unwrapped output, quiet SASL banner.
ls_() { ldapsearch -LLL -Y GSSAPI -Q -o ldif-wrap=no -H "ldap://$DC" "$@" 2>&1; }
# one attribute value from a base-scope lookup
attr1() { ls_ -b "$1" -s base "$2" 2>/dev/null | sed -n "s/^$2: //p"; }

have_ticket() { klist -s 2>/dev/null; }

require_ticket() {
    have_ticket && return 0
    cat >&2 <<EOF
No usable Kerberos ticket.

  ./inspect.sh ticket        mint one via the root job runner (no password typed)
  kinit Administrator@$REALM  type the password yourself

EOF
    exit 1
}

# ---------------------------------------------------------------- sections --

sec_env() {
    h "host tooling"
    printf '   %-14s %s\n' realm "$REALM" dc "$DC" base "$BASE"
    for b in ldapsearch ldapvi ldbsearch smbclient net samba-tool kinit jxplorer; do
        p=$(command -v "$b" 2>/dev/null)
        printf '   %-14s %s\n' "$b" "${p:-${red}MISSING$off}"
    done
    printf '   %-14s ' "ticket"
    if have_ticket; then klist 2>/dev/null | sed -n '2p' | sed 's/Default principal: //'
    else echo "${red}none — run ./inspect.sh ticket$off"; fi
}

sec_rootdse() {
    h "RootDSE on $DC (anonymous — the only thing these DCs answer unauthenticated)"
    ldapsearch -x -LLL -H "ldap://$DC" -s base -b "" \
        dnsHostName defaultNamingContext supportedSASLMechanisms \
        domainFunctionality forestFunctionality highestCommittedUSN currentTime 2>&1 | sed 's/^/   /'
}

sec_gssapi() {
    h "GSSAPI bind proof (Kerberos end to end: TGT -> service ticket -> SASL bind)"
    note "this is the check that proves Kerberos works, not just LDAP"
    klist 2>/dev/null | sed -n '1,2p' | sed 's/^/   /'
    ldapsearch -LLL -Y GSSAPI -o ldif-wrap=no -H "ldap://$DC" \
        -b "$BASE" -s base dn 2>&1 | grep -E 'SASL|^dn:' | sed 's/^/   /'
    note "service ticket now in the cache:"
    klist 2>/dev/null | grep -i "ldap/" | sed 's/^/   /'
}

sec_dcs() {
    h "domain controllers"
    ls_ -b "OU=Domain Controllers,$BASE" "(objectClass=computer)" \
        dNSHostName operatingSystem \
      | awk '/^dn:/{d=$2} /^dNSHostName:/{n=$2} /^operatingSystem:/{sub(/^operatingSystem: /,""); o=$0}
             /^$/{if(n) printf "   %-22s %s\n", n, o; n=""; o=""}
             END{if(n) printf "   %-22s %s\n", n, o}'
    note "$(ls_ -b "OU=Domain Controllers,$BASE" "(objectClass=computer)" dn | grep -c '^dn:') DC objects"
    h "per-DC liveness (RootDSE straight off each one)"
    for i in $(seq 1 "$DC_COUNT"); do
        n="$(dc_name "$i")"; ip="$(dc_ip "$i")"
        u=$(ldapsearch -x -LLL -H "ldap://$ip" -s base -b "" highestCommittedUSN 2>/dev/null \
            | sed -n 's/^highestCommittedUSN: //p')
        printf '   %-6s %-14s highestCommittedUSN=%s\n' "$n" "$ip" "${u:-${red}unreachable$off}"
    done
}

sec_fsmo() {
    h "FSMO role owners"
    note "read from fSMORoleOwner over LDAP — no samba-tool, no container"
    for pair in \
        "PDC Emulator|$BASE" \
        "RID Master|CN=RID Manager\$,CN=System,$BASE" \
        "Infrastructure|CN=Infrastructure,$BASE" \
        "Schema Master|CN=Schema,$CONFIG" \
        "Domain Naming|CN=Partitions,$CONFIG" \
        "DomainDnsZones|CN=Infrastructure,DC=DomainDnsZones,$BASE" \
        "ForestDnsZones|CN=Infrastructure,DC=ForestDnsZones,$BASE"
    do
        owner=$(attr1 "${pair#*|}" fSMORoleOwner)
        printf '   %-16s %s\n' "${pair%%|*}" \
            "$(echo "$owner" | sed 's/CN=NTDS Settings,CN=//; s/,CN=Servers.*//')"
    done
}

sec_repl() {
    h "replication health (decoded from each DC's repsFrom attribute)"
    hosts=(); for i in $(seq 1 "$DC_COUNT"); do hosts+=("$(dc_name "$i").$DOMAIN_DNS"); done
    "$HERE/addecode.py" repl "${hosts[@]}"
}

sec_users() {
    h "users"
    total=$(ls_ -b "$BASE" "(&(objectCategory=person)(objectClass=user))" dn | grep -c '^dn:')
    printf '   %s user objects in the domain\n' "$total"
    note "built-in and non-stress accounts:"
    # LDAP does not promise attribute order within an entry, so collect per
    # entry (entries are separated by a blank line) rather than pairing lines.
    ls_ -b "$BASE" "(&(objectCategory=person)(objectClass=user)(!(sAMAccountName=stress*)))" \
        sAMAccountName userAccountControl \
      | awk '/^sAMAccountName:/{s=$2}
             /^userAccountControl:/{u=$2}
             /^$/{if(s!="") printf "   %-24s uac=%s%s\n", s, u, (and(u,2)?"  (DISABLED)":""); s=""; u=""}
             END{if(s!="") printf "   %-24s uac=%s%s\n", s, u, (and(u,2)?"  (DISABLED)":"")}'
    note "privileged group membership:"
    for g in "Domain Admins" "Enterprise Admins" "Schema Admins"; do
        m=$(attr1 "CN=$g,CN=Users,$BASE" member | sed 's/CN=\([^,]*\).*/\1/' | paste -sd, -)
        printf '   %-20s %s\n' "$g" "${m:-<empty>}"
    done
}

sec_groups() {
    h "groups"
    printf '   %s group objects\n' "$(ls_ -b "$BASE" "(objectClass=group)" dn | grep -c '^dn:')"
    note "groups outside the stress set:"
    ls_ -b "$BASE" "(&(objectClass=group)(!(cn=stressgrp*)))" cn \
      | sed -n 's/^cn: /   /p' | sort | column -c 100 2>/dev/null || true
}

sec_computers() {
    h "computers"
    ls_ -b "$BASE" "(objectClass=computer)" sAMAccountName dNSHostName operatingSystem \
      | awk '/^sAMAccountName:/{s=$2} /^dNSHostName:/{d=$2}
             /^operatingSystem:/{sub(/^operatingSystem: /,""); o=$0}
             /^$/{if(s) printf "   %-12s %-22s %s\n", s, d, o; s="";d="";o=""}
             END{if(s) printf "   %-12s %-22s %s\n", s, d, o}'
    printf '   --- %s computer objects\n' "$(ls_ -b "$BASE" "(objectClass=computer)" dn | grep -c '^dn:')"
}

sec_ous() {
    h "organizational units and containers"
    ls_ -b "$BASE" -s one "(objectClass=*)" objectClass \
      | awk '/^dn:/{sub(/^dn: /,""); d=$0} /^objectClass:/{c=$2} /^$/{if(d) printf "   %-46s %s\n", d, c; d=""}
             END{if(d) printf "   %-46s %s\n", d, c}'
}

sec_dns() {
    h "AD-integrated DNS zone (dnsserver RPC + Kerberos — works from the host)"
    samba-tool dns query "$DC" "$DOMAIN_DNS" @ ALL \
        --use-kerberos=required --configfile="$CONF" 2>&1 \
      | grep -E 'Name=|SOA:|NS:|A:' | head -20 | sed 's/^/   /'
}

sec_sysvol() {
    h "SYSVOL over SMB (smbclient, Kerberos)"
    smbclient -s "$CONF" --use-kerberos=required "//$DC/sysvol" \
        -c "cd $DOMAIN_DNS; ls; cd Policies; ls" 2>&1 | head -20 | sed 's/^/   /'
    h "shares offered by $DC"
    smbclient -s "$CONF" --use-kerberos=required -L "$DC" 2>&1 | head -10 | sed 's/^/   /'
}

sec_netads() {
    h "net ads — Samba's own authenticated LDAP client"
    note "this path DOES honour Kerberos, unlike samba-tool over ldap:// (see README)"
    net ads info -s "$CONF" -S "$DC" 2>&1 | sed 's/^/   /'
    net ads search -s "$CONF" --use-kerberos=required -S "$DC" \
        "(sAMAccountName=Administrator)" sAMAccountName objectSid whenCreated 2>&1 \
      | grep -E ':' | sed 's/^/   /'
}

sec_schema() {
    h "schema"
    printf '   schema NC        %s\n' "$(attr1 "" schemaNamingContext)"
    printf '   objectClasses    %s\n' "$(ls_ -b "CN=Schema,$CONFIG" "(objectClass=classSchema)" dn | grep -c '^dn:')"
    printf '   attributes       %s\n' "$(ls_ -b "CN=Schema,$CONFIG" "(objectClass=attributeSchema)" dn | grep -c '^dn:')"
    printf '   schema version   %s\n' "$(attr1 "CN=Schema,$CONFIG" objectVersion)"
}

# --------------------------------------------------------------- actions ----

act_ticket() {
    h "minting a Kerberos ticket"
    cc="/run/user/$(id -u)/krb5cc_ad_edt1_lab"
    note "the admin password is root-only; the job runner reads it and hands back a"
    note "TICKET owned by you. The password is never printed and never in argv."
    # We check the artefact the job produces rather than submit-job.sh's exit
    # status. That is the stronger test: a job can exit 0 having written nothing
    # useful. (submit-job.sh --wait does propagate the job's real exit code now -
    # the EXIT-trap bug that used to make every success report 1 is fixed.)
    "$LAB_SUBMIT" --wait --timeout 120 ad-inspect-ticket <<EOF
#!/usr/bin/env bash
set -uo pipefail
cc="$cc"
rm -f "\$cc"
KRB5CCNAME="FILE:\$cc" kinit Administrator@$REALM < "$ADMIN_PASS_FILE" 2>&1 | grep -vi password
chown $(id -u):$(id -g) "\$cc" && chmod 600 "\$cc"
KRB5CCNAME="FILE:\$cc" klist
EOF
    export KRB5CCNAME="FILE:$cc"
    echo
    [[ -r $cc ]] && klist -s 2>/dev/null \
        || die "no ticket at $cc — check the job output above"
    note "ticket at $cc — export KRB5CCNAME=FILE:$cc in your shell, or just re-run inspect.sh"
}

act_entry() {
    [[ $# -ge 1 ]] || die "usage: inspect.sh entry <DN>"
    require_ticket
    h "$1"
    ls_ -b "$1" -s base "(objectClass=*)" '*' '+' nTSecurityDescriptor \
      | "$HERE/addecode.py" entry
}

act_search() {
    [[ $# -ge 1 ]] || die "usage: inspect.sh search '<filter>' [attrs...]"
    require_ticket
    f="$1"; shift
    h "search $f"
    ls_ -b "$BASE" "$f" "$@" | "$HERE/addecode.py" entry
}

act_edit() {
    require_ticket
    note "ldapvi opens the result set in \$EDITOR. It only writes back if you change"
    note "something and confirm — quitting without edits changes nothing."
    exec ldapvi -h "ldap://$DC" -b "$BASE" --sasl-mech GSSAPI "${@:-(objectClass=*)}"
}

act_offline() {
    h "offline inspection with ldb-tools"
    note "copies ONE partition file out of dc1 read-only and searches it with ldbsearch."
    note "No network, no credentials, nothing written to the container."
    out="${1:-/tmp/adlab-offline}"
    "$LAB_SUBMIT" --wait --timeout 180 ad-inspect-offline <<EOF
#!/usr/bin/env bash
set -uo pipefail
mkdir -p "$out"
podman cp 'dc1:/var/lib/samba/private/sam.ldb.d/DC=AD,DC=EDT1,DC=LAB.ldb' "$out/domain.ldb"
chown -R $(id -u):$(id -g) "$out"
ls -lh "$out/domain.ldb"
EOF
    # As above: check the artefact, not just the exit status.
    [[ -r "$out/domain.ldb" ]] || die "no partition copy at $out/domain.ldb"
    for f in "(objectClass=user)" "(objectClass=computer)" "(objectClass=group)"; do
        printf '   %-24s %s\n' "$f" \
            "$(ldbsearch -H "$out/domain.ldb" "$f" dn 2>/dev/null | grep -c '^dn:')"
    done
    note "browse it with:  ldbsearch -H $out/domain.ldb '(sAMAccountName=dc1\$)'"
}

act_web() {
    require_ticket
    exec "$HERE/ldap-web.py" --host "$DC" --base "$BASE" "$@"
}

act_gui() {
    h "JXplorer"
    command -v jxplorer >/dev/null || die "jxplorer not installed — run install-tools.sh"
    cat <<EOF
   These DCs set 'ldap server require strong auth = Yes', so a plain simple bind
   on port 389 is REFUSED. JXplorer must use LDAPS. Connect with:

       Host      dc1.$DOMAIN_DNS
       Port      636
       Protocol  LDAP v3
       Base DN   $BASE
       Level     SSL + User + Password
       User DN   CN=Administrator,CN=Users,$BASE

   The DCs use self-signed certs, so point JXplorer's truststore at the bundle
   this repo builds (Security > Trusted Servers and CAs):

       $HERE/dc-ca.jks      (password: changeit)

   Launching now.
EOF
    exec jxplorer
}

act_all() {
    require_ticket
    sec_env; sec_rootdse; sec_gssapi; sec_dcs; sec_fsmo; sec_repl
    sec_ous; sec_users; sec_groups; sec_computers; sec_schema
    sec_dns; sec_sysvol; sec_netads
    h "done"
    note "single sections: ./inspect.sh help"
}

usage() {
    sed -n '2,12p' "$0" | sed 's/^# \?//'
    cat <<'EOF'
Sections (all read-only):
  env        which tools are installed, and whether you hold a ticket
  rootdse    unauthenticated RootDSE — what a stranger can see
  gssapi     Kerberos end-to-end proof: TGT -> ldap/ service ticket -> SASL bind
  dcs        the DC objects, plus a liveness probe against each DC's own IP
  fsmo       all seven FSMO role owners, read over LDAP
  repl       inbound replication health, decoded from repsFrom
  ous        top-level containers and OUs
  users      user counts, non-stress accounts, privileged group membership
  groups     group counts and the non-stress groups
  computers  every computer object with its OS string
  schema     schema NC, class/attribute counts, version
  dns        the AD-integrated DNS zone (RPC + Kerberos)
  sysvol     SYSVOL and share listing over SMB
  netads     net ads info/search — Samba's own authenticated LDAP client

Actions:
  ticket             mint a Kerberos ticket via the root job runner
  entry <DN>         one entry, with SIDs/GUIDs/SDs/UAC decoded
  search '<filter>'  subtree search, decoded
  edit ['<filter>']  open the result set in ldapvi (writes only if you save)
  offline [dir]      copy a partition file out of dc1 and search it with ldbsearch
  web                start the local web browser on 127.0.0.1:8389
  gui                connection settings for JXplorer, then launch it

Environment:
  AD_DC=dc3.ad.edt1.lab ./inspect.sh dcs     point at a different DC
EOF
}

LAB_SUBMIT="${LAB_SUBMIT:-/home/eddie/Documents/ClaudeSystem/submit-job.sh}"

cmd="${1:-all}"; shift 2>/dev/null || true
case "$cmd" in
    all)                 act_all ;;
    ticket)              act_ticket ;;
    entry)               act_entry "$@" ;;
    search)              act_search "$@" ;;
    edit)                act_edit "$@" ;;
    offline)             act_offline "$@" ;;
    web)                 act_web "$@" ;;
    gui)                 act_gui ;;
    env)                 sec_env ;;
    rootdse)             sec_rootdse ;;
    help|-h|--help)      usage ;;
    gssapi|dcs|fsmo|repl|ous|users|groups|computers|schema|dns|sysvol|netads)
                         require_ticket; "sec_$cmd" ;;
    *)                   usage; exit 1 ;;
esac
