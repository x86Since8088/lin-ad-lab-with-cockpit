#!/usr/bin/env bash
#
# Prove SYSVOL is genuinely consistent across every DC.
#
# Five independent checks, because no single one is sufficient:
#
#   1. CONTENT      sha256 of every file + the full path/type listing.
#   2. NT ACL       `samba-tool ntacl get --as-sddl` for every path. SDDL is
#                   SID-based, so it IS expected to be byte-identical on all
#                   DCs. This is the correct cross-DC ACL comparison.
#   3. POSIX ACL    getfacl, with every numeric xid translated back through
#                   THAT DC's OWN idmap.ldb. The raw numbers are expected to
#                   DIFFER between DCs; the SIDs they resolve to must not.
#                   This is the check that catches a naive `rsync --acls`,
#                   which sysvolcheck alone will happily pass. See README.md.
#   4. sysvolcheck  `samba-tool ntacl sysvolcheck` clean on every DC.
#   5. GPO          every GPO in LDAP has its SYSVOL directory on every DC,
#                   and the GPT.INI Version matches the LDAP versionNumber.
#
# Run as root on the host. Exit 0 only if every check passes on every DC.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./sysvol-lib.sh
[[ $EUID -eq 0 ]] || die "must run as root"

WORK="$(mktemp -d /tmp/sysvol-verify.XXXXXX)"
trap 'rm -rf "$WORK"' EXIT
PASS=0; FAIL=0
ok(){ printf '  PASS  %s\n' "$1"; PASS=$((PASS+1)); }
no(){ printf '  FAIL  %s (%s)\n' "$1" "$2"; FAIL=$((FAIL+1)); }

DCS=(); for d in $(all_dcs); do dc_up "$d" && DCS+=("$d"); done
[[ ${#DCS[@]} -gt 1 ]] || die "need at least 2 running DCs"
REF="${DCS[0]}"

# --- collect ----------------------------------------------------------------
for d in "${DCS[@]}"; do
    podman exec "$d" bash -c "cd '$SYSVOL_PATH' && find . -mindepth 1 -printf '%y %p\n' | LC_ALL=C sort" \
        >"$WORK/tree.$d" 2>/dev/null
    podman exec "$d" bash -c "cd '$SYSVOL_PATH' && find . -type f -exec sha256sum {} + 2>/dev/null | LC_ALL=C sort -k2" \
        >"$WORK/sum.$d" 2>/dev/null

    # NT ACL, as SDDL, for every path.
    podman exec "$d" bash -c "
        cd '$SYSVOL_PATH' || exit 1
        find . -mindepth 1 | LC_ALL=C sort | while IFS= read -r p; do
            printf '%s\t%s\n' \"\$p\" \"\$(samba-tool ntacl get --as-sddl \"\$p\" 2>&1 | head -1)\"
        done" >"$WORK/sddl.$d" 2>/dev/null

    # POSIX ACL with xids translated through this DC's idmap.
    podman exec "$d" ldbsearch -H /var/lib/samba/private/idmap.ldb \
        '(objectClass=sidMap)' cn xidNumber >"$WORK/idmap.$d" 2>/dev/null
    podman exec "$d" bash -c "cd '$SYSVOL_PATH' && LC_ALL=C getfacl -pnR . 2>/dev/null" \
        >"$WORK/facl.raw.$d" 2>/dev/null

    # Emit "<path>\t<acl entry>" with every xid replaced by its SID, then sort.
    # Sorting is essential: getfacl orders entries by NUMERIC id, and since the
    # numbers differ per DC the SIDs come out in a different order on each one.
    # Without the sort this check fails on ordering alone.
    awk '
      FILENAME==ARGV[1] {
        if ($1=="cn:")        sid=$2
        else if ($1=="xidNumber:") { map[$2]=sid; sid="" }
        next
      }
      function tr(n) { return (n in map) ? map[n] : "UNMAPPED-XID-" n }
      /^# file:/  { path=$3; next }
      /^# owner:/ { print path "\towner=" tr($3); next }
      /^# group:/ { print path "\tgroup=" tr($3); next }
      /^(default:)?(user|group):[0-9]+:/ {
        split($0, f, ":")
        # forms: user:N:perm   or   default:user:N:perm
        if (f[1]=="default") print path "\tdefault:" f[2] ":" tr(f[3]) ":" f[4]
        else                 print path "\t" f[1] ":" tr(f[2]) ":" f[3]
        next
      }
      /^(default:)?(user|group|other|mask)::/ { print path "\t" $0; next }
    ' "$WORK/idmap.$d" "$WORK/facl.raw.$d" | LC_ALL=C sort >"$WORK/facl.$d"
done

# --- 1. content -------------------------------------------------------------
echo "=== 1. SYSVOL content identical on all ${#DCS[@]} DCs ==="
printf '    reference: %s  (%s files, %s paths)\n' "$REF" \
    "$(wc -l <"$WORK/sum.$REF")" "$(wc -l <"$WORK/tree.$REF")"
for d in "${DCS[@]}"; do
    [[ "$d" == "$REF" ]] && continue
    if diff -q "$WORK/tree.$REF" "$WORK/tree.$d" >/dev/null \
       && diff -q "$WORK/sum.$REF" "$WORK/sum.$d" >/dev/null; then
        ok "$d content matches $REF"
    else
        no "$d content" "$(diff "$WORK/tree.$REF" "$WORK/tree.$d" | head -4 | tr '\n' ' ')$(diff "$WORK/sum.$REF" "$WORK/sum.$d" | head -4 | tr '\n' ' ')"
    fi
done

# --- 2. NT ACLs -------------------------------------------------------------
echo; echo "=== 2. NT ACLs (SDDL, SID-based) identical on all DCs ==="
for d in "${DCS[@]}"; do
    [[ "$d" == "$REF" ]] && continue
    if diff -q "$WORK/sddl.$REF" "$WORK/sddl.$d" >/dev/null; then
        ok "$d NT ACLs match $REF"
    else
        no "$d NT ACLs" "$(diff "$WORK/sddl.$REF" "$WORK/sddl.$d" | head -4 | tr '\n' ' ')"
    fi
done

# --- 3. POSIX ACLs, semantically ------------------------------------------
echo; echo "=== 3. POSIX ACLs resolve to the same SIDs on all DCs ==="
echo "    (raw xids are EXPECTED to differ; the SIDs behind them must not)"
for d in "${DCS[@]}"; do
    [[ "$d" == "$REF" ]] && continue
    rawsame=""; diff -q "$WORK/facl.raw.$REF" "$WORK/facl.raw.$d" >/dev/null && rawsame=" [raw xids also identical]"
    if grep -q 'UNMAPPED-XID' "$WORK/facl.$d"; then
        no "$d POSIX ACL" "unmapped xid: $(grep -m1 -o 'UNMAPPED-XID-[0-9]*' "$WORK/facl.$d")"
    elif diff -q "$WORK/facl.$REF" "$WORK/facl.$d" >/dev/null; then
        ok "$d POSIX ACLs resolve identically to $REF$rawsame"
    else
        no "$d POSIX ACL SIDs" "$(diff "$WORK/facl.$REF" "$WORK/facl.$d" | head -6 | tr '\n' ' ')"
    fi
done

# --- 4. sysvolcheck ---------------------------------------------------------
echo; echo "=== 4. samba-tool ntacl sysvolcheck clean on every DC ==="
for d in "${DCS[@]}"; do
    out=$(podman exec "$d" samba-tool ntacl sysvolcheck 2>&1); rc=$?
    [[ $rc -eq 0 ]] && ok "$d sysvolcheck clean" \
                    || no "$d sysvolcheck" "rc=$rc $(echo "$out" | head -1 | cut -c1-140)"
done

echo; echo "=== 4b. samba-tool gpo aclcheck (LDAP SD vs SYSVOL SD) ==="
echo "    (needs Administrator; -P / the machine account cannot read nTSecurityDescriptor)"
for d in "${DCS[@]}"; do
    # PASSWD_FILE, not --password=: samba's credentials code reads the file
    # itself, so the secret never appears in argv where `ps` would expose it.
    # A Kerberos ccache does NOT work here -- gpo aclcheck also opens SMB to
    # SYSVOL and gensec fails with "No password for user principal".
    out=$(podman exec "$d" bash -c \
            'PASSWD_FILE=/run/adminpass samba-tool gpo aclcheck -U Administrator' 2>&1); rc=$?
    [[ $rc -eq 0 ]] && ok "$d gpo aclcheck clean" \
                    || no "$d gpo aclcheck" "rc=$rc $(echo "$out" | head -1 | cut -c1-140)"
done

# --- 5. GPOs ----------------------------------------------------------------
echo; echo "=== 5. every GPO in LDAP has its files, at the right version, on every DC ==="
mapfile -t GPOS < <(podman exec "$REF" samba-tool gpo listall 2>/dev/null \
                    | sed -n 's/^GPO *: *//p')
printf '    %s GPO(s) in the directory: %s\n' "${#GPOS[@]}" "${GPOS[*]}"
for d in "${DCS[@]}"; do
    bad=""
    # LDAP versionNumber for each GPO, from THIS DC.
    for g in "${GPOS[@]}"; do
        lv=$(podman exec "$d" samba-tool gpo show "$g" 2>/dev/null \
             | sed -n 's/^[[:space:]]*version[[:space:]]*:[[:space:]]*//Ip' | head -1)
        fv=$(podman exec "$d" bash -c "sed -n 's/\r//;s/^[Vv]ersion=//p' '$SYSVOL_DOMAIN_PATH/Policies/$g/GPT.INI' 2>/dev/null" | head -1)
        if [[ -z "$fv" ]]; then bad+="$g:NO-GPT.INI "
        elif [[ -n "$lv" && "$lv" != "$fv" ]]; then bad+="$g:ldap=$lv/file=$fv "
        fi
    done
    [[ -z "$bad" ]] && ok "$d has all ${#GPOS[@]} GPOs on disk at the LDAP version" \
                    || no "$d GPO files" "$bad"
done

echo; echo "==================== $PASS passed, $FAIL failed ===================="
[[ $FAIL -eq 0 ]]
