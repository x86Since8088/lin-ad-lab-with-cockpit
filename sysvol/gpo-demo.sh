#!/usr/bin/env bash
#
# GPO lifecycle demonstration, end to end, with the SYSVOL divergence made
# visible at every step.
#
#   1. create an OU and a GPO on the PDC emulator
#   2. link the GPO to the OU and to the domain
#   3. write an actual policy value into it (a [Privilege Rights] logon
#      restriction in GptTmpl.inf -- the one thing sssd on a Linux member
#      will genuinely read and act on)
#   4. show the GPO object reaching every DC through DRS within seconds,
#      while the FILES stay on the PDC emulator alone
#   5. run sysvol-replicate.sh and show the files converging
#
# Run as root on the host.  --cleanup removes everything it created.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./sysvol-lib.sh
[[ $EUID -eq 0 ]] || die "must run as root"

GPO_NAME="EDT1 Lab Logon Restriction"
OU_NAME="LabWorkstations"
DOMAIN_DN="$(echo "$DOMAIN_DNS" | sed 's/^/DC=/; s/\./,DC=/g')"
OU_DN="OU=$OU_NAME,$DOMAIN_DN"
CLEANUP=0
[[ "${1:-}" == "--cleanup" ]] && CLEANUP=1

SRC="$(pdc_emulator)" || die "could not determine the PDC emulator"
log "PDC emulator (where all GPO edits must happen): $SRC"

# Authenticate with Kerberos so the password never reaches a command line.
# `ps` on a shared host would otherwise expose --password=...
kinit_admin() {
    podman exec -i "$1" bash -c \
        'cat /run/adminpass | kinit Administrator@'"$REALM"' >/dev/null 2>&1 && klist -s'
}
sam() { podman exec "$SRC" bash -c "KRB5CCNAME=/tmp/krb5cc_0 $*"; }

kinit_admin "$SRC" || die "kinit failed on $SRC"

# ---------------------------------------------------------------- cleanup ---
if [[ $CLEANUP -eq 1 ]]; then
    log "removing demo objects"
    guid=$(sam "samba-tool gpo listall" 2>/dev/null \
           | awk -v n="$GPO_NAME" 'BEGIN{RS="\n\n"} $0 ~ "display name *: *"n {print}' \
           | sed -n 's/^GPO *: *//p')
    for g in $guid; do
        sam "samba-tool gpo dellink '$OU_DN' $g --use-kerberos=required" >/dev/null 2>&1
        sam "samba-tool gpo dellink '$DOMAIN_DN' $g --use-kerberos=required" >/dev/null 2>&1
        sam "samba-tool gpo del $g --use-kerberos=required" >/dev/null 2>&1 && log "deleted GPO $g"
    done
    sam "samba-tool ou delete '$OU_DN'" >/dev/null 2>&1 && log "deleted $OU_DN"
    ./sysvol-replicate.sh -q && log "replicated the deletion to all DCs"
    exit 0
fi

# ------------------------------------------------------------ 1. create ----
echo; echo "=== 1. create the OU and the GPO on $SRC ==="
if sam "samba-tool ou list" 2>/dev/null | grep -qx "$OU_DN"; then
    log "$OU_DN already exists"
else
    sam "samba-tool ou create '$OU_DN'" && log "created $OU_DN"
fi

GUID=$(sam "samba-tool gpo listall" 2>/dev/null \
       | awk -v RS='' -v n="$GPO_NAME" '$0 ~ "display name *: *"n' \
       | sed -n 's/^GPO *: *//p' | head -1)
if [[ -n "$GUID" ]]; then
    log "GPO '$GPO_NAME' already exists: $GUID"
else
    out=$(sam "samba-tool gpo create '$GPO_NAME' --use-kerberos=required" 2>&1) \
        || die "gpo create failed: $out"
    GUID=$(echo "$out" | grep -oE '\{[0-9A-Fa-f-]{36}\}' | head -1)
    [[ -n "$GUID" ]] || die "could not parse the new GUID from: $out"
    log "created GPO '$GPO_NAME' = $GUID"
fi

# -------------------------------------------------------------- 2. link ----
# Linked to the OU ONLY by default. The OU is empty, so the GPO is inert --
# a complete, verifiable artifact that cannot restrict anyone's logon by
# accident. Pass --link-domain to link it to the domain root as well, which
# is what makes it apply to every domain member running sssd. Do that only on
# a lab you own outright: SeRemoteInteractiveLogonRight here allows Domain
# Admins only, and any PAM service that is not in an ad_gpo_map_* list falls
# through to ad_gpo_default_right, which is `deny`.
LINK_TARGETS=("$OU_DN")
[[ "${1:-}" == "--link-domain" ]] && LINK_TARGETS+=("$DOMAIN_DN")
echo; echo "=== 2. link it to ${LINK_TARGETS[*]} ==="
for target in "${LINK_TARGETS[@]}"; do
    if sam "samba-tool gpo getlink '$target'" 2>/dev/null | grep -q "$GUID"; then
        log "already linked to $target"
    else
        sam "samba-tool gpo setlink '$target' $GUID --use-kerberos=required" >/dev/null \
            && log "linked to $target"
    fi
done
sam "samba-tool gpo listcontainers $GUID" 2>/dev/null | sed 's/^/    /'

# ------------------------------------------------------- 3. policy value ----
# A real setting, in the exact location sssd reads:
#   Policies/{GUID}/Machine/Microsoft/Windows NT/SecEdit/GptTmpl.inf
#   [Privilege Rights]
#   SeRemoteInteractiveLogonRight = *<SID>,*<SID>
#
# NOTE: sssd deliberately IGNORES BUILTIN groups (S-1-5-32-*), so the allow
# list must name a real domain principal. We use Domain Admins (RID 512).
echo; echo "=== 3. write a policy value into SYSVOL ==="
DOMSID=$(podman exec "$SRC" net getdomainsid 2>/dev/null | sed -n 's/.*domain .* is: *//p' | head -1)
[[ -n "$DOMSID" ]] || die "could not read the domain SID"
SECEDIT="$SYSVOL_DOMAIN_PATH/Policies/$GUID/Machine/Microsoft/Windows NT/SecEdit"

podman exec "$SRC" mkdir -p "$SECEDIT"
podman exec -i "$SRC" tee "$SECEDIT/GptTmpl.inf" >/dev/null <<INF
[Unicode]
Unicode=yes
[Version]
signature="\$CHICAGO\$"
Revision=1
[Privilege Rights]
SeInteractiveLogonRight = *$DOMSID-512,*$DOMSID-513
SeRemoteInteractiveLogonRight = *$DOMSID-512
INF
log "wrote GptTmpl.inf ([Privilege Rights]: Domain Admins may log on remotely)"

# Bump the GPT.INI version and the LDAP versionNumber together. A Windows
# client -- and sssd -- compare the two and reapply only when they change.
GPT="$SYSVOL_DOMAIN_PATH/Policies/$GUID/GPT.INI"
CUR=$(podman exec "$SRC" bash -c "sed -n 's/\r//;s/^[Vv]ersion=//p' '$GPT' 2>/dev/null" | head -1)
NEW=$(( ${CUR:-0} + 1 ))
podman exec -i "$SRC" tee "$GPT" >/dev/null <<INI
[General]
Version=$NEW
INI
sam "samba-tool gpo manage --help" >/dev/null 2>&1   # keep the ccache warm
podman exec "$SRC" bash -c \
    "ldbmodify -H /var/lib/samba/private/sam.ldb <<L
dn: CN=$GUID,CN=Policies,CN=System,$DOMAIN_DN
changetype: modify
replace: versionNumber
versionNumber: $NEW
L" >/dev/null 2>&1 && log "GPT.INI and LDAP versionNumber both now $NEW"

podman exec "$SRC" samba-tool ntacl sysvolreset >/dev/null 2>&1 \
    && log "sysvolreset on $SRC: new files given the correct SYSVOL ACLs"

# ---------------------------------------------- 4. the divergence, live ----
echo; echo "=== 4. THE POINT: the object replicates, the files do not ==="
sleep 3
printf '    %-5s %-28s %-22s %s\n' DC "GPO in LDAP (DRS)" "GPT.INI on disk" "GptTmpl.inf on disk"
for d in $(all_dcs); do
    dc_up "$d" || continue
    inldap=no; podman exec "$d" samba-tool gpo listall 2>/dev/null | grep -q "$GUID" && inldap=yes
    ver=$(podman exec "$d" bash -c "sed -n 's/\r//;s/^[Vv]ersion=//p' '$GPT' 2>/dev/null" | head -1)
    tmpl=no; podman exec "$d" test -f "$SECEDIT/GptTmpl.inf" 2>/dev/null && tmpl=yes
    printf '    %-5s %-28s %-22s %s\n' "$d" "$inldap" "${ver:-ABSENT}" "$tmpl"
done

# ------------------------------------------------------- 5. converge -------
echo; echo "=== 5. run the replication, then look again ==="
./sysvol-replicate.sh 2>&1 | sed 's/^/    /'
echo
printf '    %-5s %-28s %-22s %s\n' DC "GPO in LDAP (DRS)" "GPT.INI on disk" "GptTmpl.inf on disk"
for d in $(all_dcs); do
    dc_up "$d" || continue
    inldap=no; podman exec "$d" samba-tool gpo listall 2>/dev/null | grep -q "$GUID" && inldap=yes
    ver=$(podman exec "$d" bash -c "sed -n 's/\r//;s/^[Vv]ersion=//p' '$GPT' 2>/dev/null" | head -1)
    tmpl=no; podman exec "$d" test -f "$SECEDIT/GptTmpl.inf" 2>/dev/null && tmpl=yes
    printf '    %-5s %-28s %-22s %s\n' "$d" "$inldap" "${ver:-ABSENT}" "$tmpl"
done

echo; log "GPO $GUID ('$GPO_NAME') is live on all DCs"
echo "$GUID" > /run/sysvol-demo-gpo.guid
