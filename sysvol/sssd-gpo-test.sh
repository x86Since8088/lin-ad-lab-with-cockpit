#!/usr/bin/env bash
#
# The one part of Group Policy that genuinely acts on a LINUX domain member:
# sssd's GPO-based access control (`ad_gpo_access_control`).
#
# sssd implements exactly ONE Group Policy client-side extension, the Security
# Settings CSE {827D319E-6EAC-11D2-A4EA-00C04F79F83A}. It reads
#
#     Policies/{GUID}/Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf
#     [Privilege Rights]
#     SeInteractiveLogonRight / SeRemoteInteractiveLogonRight / ...
#
# and uses it to decide whether a user may log in, per PAM service. It applies
# NOTHING else from a GPO -- no registry.pol, no drive maps, no software
# installation. It is a policy CONSUMER for access control, not a policy engine.
#
# This script proves it end to end, and then proves why SYSVOL replication
# matters: it points a second client at a DC whose SYSVOL is stale and shows
# the SAME user getting the OPPOSITE access decision.
#
# Run as root on the host.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./sysvol-lib.sh
[[ $EUID -eq 0 ]] || die "must run as root"

GPO_NAME="EDT1 Lab Logon Restriction"
TESTUSER="gpotest"
LOGF="/var/log/sssd/sssd_${DOMAIN_DNS}.log"
SRC="$(pdc_emulator)" || die "no PDC emulator"

# Point a client's sssd at ONE named DC and start it. `ad_server` pins the
# client so we can demonstrate a per-DC difference.
#
# Each step is a SEPARATE podman exec on purpose. `pkill -f <pat>` matches the
# whole command line of every process, INCLUDING the shell running this script
# -- so if the kill pattern and the start command live in one `bash -c` string,
# pkill matches its own argv and kills the shell before it ever starts sssd.
# `pkill -x sssd` matches the process NAME exactly, which the shell never has.
setup_client() {
    local c="$1" server="$2" i
    podman exec "$c" bash -c "
        sed -i '/^ad_gpo_access_control/d;/^ad_gpo_cache_timeout/d;/^ad_server/d;/^debug_level/d' /etc/sssd/sssd.conf
        printf 'ad_gpo_access_control = enforcing\nad_gpo_cache_timeout = 1\nad_server = %s\ndebug_level = 6\n' '$server' >> /etc/sssd/sssd.conf
        chmod 600 /etc/sssd/sssd.conf
        mkdir -p /var/lib/sss/db /var/lib/sss/mc /var/lib/sss/pipes/private /var/log/sssd /var/lib/sss/gpo_cache" >/dev/null 2>&1

    podman exec "$c" pkill -x sssd >/dev/null 2>&1
    sleep 2
    podman exec "$c" bash -c 'rm -rf /var/lib/sss/db/* /var/lib/sss/gpo_cache/*; exit 0' >/dev/null 2>&1
    podman exec "$c" /usr/sbin/sssd -D --logger=files >/dev/null 2>&1

    for i in $(seq 1 40); do
        podman exec "$c" id Administrator >/dev/null 2>&1 && return 0
        sleep 1
    done
    return 1
}

# Ask sssd for a real PAM account decision and read the verdict out of its own
# log, which is authoritative -- `sssctl user-checks` prints the decision only
# on some builds, but the back end always logs POLICY DECISION.
verdict() {
    local c="$1" u="$2" svc="$3"
    # Take the LAST decision line in log order. Do not sort -- that picks the
    # alphabetically first line, not the verdict. Drop sssd's backtrace dump
    # (lines beginning with whitespace and '*'), which re-prints earlier lines.
    podman exec "$c" bash -c "
        : > '$LOGF'
        sssctl user-checks '$u' -a acct -s '$svc' >/dev/null 2>&1
        sleep 1
        grep -vE '^[[:space:]]*\*' '$LOGF' \
          | grep -oE 'access_granted = [01]|service $svc maps to Denied|Unable to retrieve policy data' \
          | tail -1" 2>/dev/null
}
show() {
    case "$1" in
        "access_granted = 1")           echo "ALLOW" ;;
        "access_granted = 0")           echo "DENY " ;;
        *"maps to Denied")              echo "DENY  (service unmapped -> ad_gpo_default_right)" ;;
        "Unable to retrieve policy data") echo "ERROR (GPO unreadable -> fail closed, everyone locked out)" ;;
        *)                              echo "?     ($1)" ;;
    esac
}

# ------------------------------------------------------------ prepare ------
podman exec "$SRC" samba-tool user list 2>/dev/null | grep -qx "$TESTUSER" || {
    podman exec "$SRC" bash -c \
        "PASSWD_FILE=/run/adminpass samba-tool user create $TESTUSER --random-password" >/dev/null 2>&1 \
        && log "created test user $TESTUSER (Domain Users only)"
}

GUID=$(podman exec "$SRC" samba-tool gpo listall 2>/dev/null \
       | awk -v RS='' -v n="$GPO_NAME" '$0 ~ "display name *: *"n' \
       | sed -n 's/^GPO *: *//p' | head -1)
[[ -n "$GUID" ]] || die "GPO '$GPO_NAME' not found -- run ./gpo-demo.sh first"

echo "=== the policy, as it sits in SYSVOL on $SRC ==="
podman exec "$SRC" cat \
    "$SYSVOL_DOMAIN_PATH/Policies/$GUID/Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf" \
    2>/dev/null | sed -n '/Privilege Rights/,$p' | sed 's/^/    /'
echo
echo "    512 = Domain Admins, 513 = Domain Users"
echo "    Administrator is in both. $TESTUSER is in Domain Users only."

# sssd's CSE filter skips any GPO whose LDAP gPCMachineExtensionNames does not
# register the Security CSE. samba-tool gpo create leaves that attribute empty,
# so a hand-written GptTmpl.inf is IGNORED until this is set.
podman exec "$SRC" bash -c "
  ldbsearch -H /var/lib/samba/private/sam.ldb '(cn=$GUID)' gPCMachineExtensionNames 2>/dev/null \
    | grep -q gPCMachineExtensionNames || ldbmodify -H /var/lib/samba/private/sam.ldb <<L
dn: CN=$GUID,CN=Policies,CN=System,$(echo "$DOMAIN_DNS" | sed 's/^/DC=/; s/\./,DC=/g')
changetype: modify
replace: gPCMachineExtensionNames
gPCMachineExtensionNames: [{827D319E-6EAC-11D2-A4EA-00C04F79F83A}{803E14A0-B4FB-11D0-A0D0-00A0C90F574B}]
L" >/dev/null 2>&1

# The GPO is linked to an empty OU by default so it cannot restrict anyone by
# accident. It has to reach the client to be testable, so link it to the domain
# root for the duration of this test and take the link away again on exit --
# including on Ctrl-C. Leaving a live "Domain Admins only" remote-logon policy
# on a shared lab is exactly the kind of thing that locks people out of an RDP
# or ssh host without explanation.
DOMAIN_DN="$(echo "$DOMAIN_DNS" | sed 's/^/DC=/; s/\./,DC=/g')"
unlink_domain() {
    podman exec "$SRC" bash -c \
        "PASSWD_FILE=/run/adminpass samba-tool gpo dellink '$DOMAIN_DN' $GUID -U Administrator" \
        >/dev/null 2>&1 && log "removed the domain-root link (GPO is inert again)"
}
trap unlink_domain EXIT INT TERM
podman exec "$SRC" bash -c \
    "PASSWD_FILE=/run/adminpass samba-tool gpo setlink '$DOMAIN_DN' $GUID -U Administrator" \
    >/dev/null 2>&1 && log "temporarily linked the GPO to the domain root for this test"

# --------------------------------------------- 1. enforcement on client1 ---
echo; echo "=== 1. client1, pinned to $SRC (SYSVOL is current there) ==="
setup_client client1 "$SRC.$DOMAIN_DNS" || die "sssd would not come up on client1"
printf '    %-14s %-10s %s\n' USER SERVICE DECISION
for u in Administrator "$TESTUSER"; do
    for svc in login sshd crond; do
        printf '    %-14s %-10s %s\n' "$u" "$svc" "$(show "$(verdict client1 "$u" "$svc")")"
    done
done
cat <<'NOTE'

    login -> ad_gpo_map_interactive        -> SeInteractiveLogonRight       (512,513)
    sshd  -> ad_gpo_map_remote_interactive -> SeRemoteInteractiveLogonRight (512 only)
    crond -> ad_gpo_map_batch, but no SeBatchLogonRight is set anywhere, and
             this build's ad_gpo_default_right is `deny`, so it is refused.
NOTE

# ------------------------------- 2. the same question against a stale DC ---
echo; echo "=== 2. THE OPERATIONAL RISK: the same user, against a stale DC ==="
STALE=""
for d in $(all_dcs); do [[ "$d" != "$SRC" ]] && dc_up "$d" && { STALE="$d"; break; }; done
[[ -n "$STALE" ]] || die "no second DC available"

GPODIR="$SYSVOL_DOMAIN_PATH/Policies/$GUID"
DOMSID=$(podman exec "$SRC" net getdomainsid 2>/dev/null | sed -n 's/.*domain .* is: *//p' | head -1)
setup_client client2 "$STALE.$DOMAIN_DNS" || warn "sssd would not come up on client2"

# --- 2a. the state dc2..dc5 were ACTUALLY found in: no policy files at all ---
echo "    2a. GPO files absent entirely -- the state every non-PDC DC in this"
echo '        lab was found in, straight after "samba-tool domain join".'
podman exec "$STALE" rm -rf "$GPODIR" 2>/dev/null
podman exec client2 bash -c 'rm -rf /var/lib/sss/gpo_cache/*; sss_cache -E' >/dev/null 2>&1
sleep 2
printf '        %-8s %-14s %-10s %s\n' "$STALE" "$TESTUSER" sshd "$(show "$(verdict client2 "$TESTUSER" sshd)")"
echo "        LDAP says the GPO exists, so sssd tries to fetch it, fails, and"
echo "        fails CLOSED. Every domain user is locked out of every mapped"
echo "        PAM service on every client bound to that DC."

# --- 2b. the subtler and more dangerous case: a STALE copy -------------------
echo
echo "    2b. GPO files present but STALE -- the DC still serves the policy as"
echo "        it was before the last edit on the PDC emulator."
podman exec "$STALE" mkdir -p "$GPODIR/Machine/Microsoft/Windows NT/SecEdit"
podman exec -i "$STALE" tee "$GPODIR/Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf" >/dev/null <<INF
[Unicode]
Unicode=yes
[Version]
signature="\$CHICAGO\$"
Revision=1
[Privilege Rights]
SeInteractiveLogonRight = *$DOMSID-512,*$DOMSID-513
SeRemoteInteractiveLogonRight = *$DOMSID-512,*$DOMSID-513
INF
printf '[General]\nVersion=1\n' | podman exec -i "$STALE" tee "$GPODIR/GPT.INI" >/dev/null
podman exec "$STALE" samba-tool ntacl sysvolreset >/dev/null 2>&1
podman exec client2 bash -c 'rm -rf /var/lib/sss/gpo_cache/*; sss_cache -E' >/dev/null 2>&1
sleep 2
echo
printf '        %-8s %-14s %-10s %s\n' DC USER SERVICE DECISION
printf '        %-8s %-14s %-10s %s\n' "$STALE" "$TESTUSER" sshd "$(show "$(verdict client2 "$TESTUSER" sshd)")"
printf '        %-8s %-14s %-10s %s\n' "$SRC"   "$TESTUSER" sshd "$(show "$(verdict client1 "$TESTUSER" sshd)")"
echo
echo "        Two clients, one domain, one user, one GPO, the same second --"
echo "        opposite security decisions, settled only by which DC the client"
echo "        happened to bind to. Nothing logs an error. Nothing alerts."

# ------------------------------------------------------- 3. converge -------
echo; echo "=== 3. run the replication and ask again ==="
./sysvol-replicate.sh -q && log "SYSVOL replicated -- $STALE now serves the same bytes as $SRC"

# The files converge immediately; the CLIENT does not. sssd keeps its parsed
# access decision in its own cache, and it decides whether to re-read a GPO by
# comparing GPT.INI's Version to the version it cached -- exactly as Windows
# does. Clearing gpo_cache is not enough; the evaluated result survives it.
# So client-side latency STACKS on top of the replication interval, and a
# stale replica carrying the SAME version number is never re-read at all.
log "re-initialising sssd on client2 (what a refresh or a reboot would do)"
setup_client client2 "$STALE.$DOMAIN_DNS" || warn "sssd would not come up on client2"
printf '    %-8s %-14s %-10s %s\n' DC USER SERVICE DECISION
printf '    %-8s %-14s %-10s %s\n' "$STALE" "$TESTUSER" sshd "$(show "$(verdict client2 "$TESTUSER" sshd)")"
printf '    %-8s %-14s %-10s %s\n' "$SRC" "$TESTUSER" sshd "$(show "$(verdict client1 "$TESTUSER" sshd)")"
echo
log "done"
