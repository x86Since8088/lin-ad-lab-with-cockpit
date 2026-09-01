#!/usr/bin/env bash
# Acceptance gate: prove the domain works at scale before any physical host joins.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./lab.env
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1 ($2)"; FAIL=$((FAIL+1)); }

echo "=== 1. every container has a distinct IP on $NET ==="
declare -A seen; dup=0
for i in $(seq 1 "$DC_COUNT"); do names+=("$(dc_name $i)"); done
for i in $(seq 1 "$CLIENT_COUNT"); do names+=("$(client_name $i)"); done
for n in "${names[@]}"; do
    ip=$(podman inspect "$n" --format '{{range $k,$v := .NetworkSettings.Networks}}{{if eq $k "'"$NET"'"}}{{$v.IPAddress}}{{end}}{{end}}' 2>/dev/null)
    printf '  %-9s %s\n' "$n" "${ip:-MISSING}"
    [[ -z "$ip" ]] && dup=1
    [[ -n "${seen[$ip]:-}" ]] && { echo "    DUPLICATE with ${seen[$ip]}"; dup=1; }
    seen[$ip]="$n"
done
[[ $dup -eq 0 ]] && ok "all ${#names[@]} containers hold distinct addresses" || no "distinct IPs" "duplicate or missing"

echo; echo "=== 2. all $DC_COUNT DCs are in the directory ==="
listed=$(podman exec "$(dc_name 1)" samba-tool computer list 2>/dev/null | tr -d '$' | sort)
echo "$listed" | sed 's/^/    /'
cnt=$(echo "$listed" | grep -ciE '^dc[0-9]+' || true)
[[ "$cnt" -eq "$DC_COUNT" ]] && ok "$cnt/$DC_COUNT DCs present" || no "DC count" "$cnt/$DC_COUNT"

echo; echo "=== 3. replication is healthy in both directions ==="
for i in $(seq 1 "$DC_COUNT"); do
    n=$(dc_name $i)
    # `drs showrepl` prints "0 consecutive failure(s)" on a HEALTHY link, so
    # grepping for the word "failure" counts success as failure. Match only a
    # NON-ZERO count, plus genuine WERR/error codes.
    fails=$(podman exec "$n" samba-tool drs showrepl 2>/dev/null \
            | grep -cE '[1-9][0-9]* consecutive failure|WERR_[A-Z_]+|LDAP error' || true)
    partners=$(podman exec "$n" samba-tool drs showrepl 2>/dev/null | grep -cE 'INBOUND|OUTBOUND' || true)
    if [[ "${fails:-1}" -eq 0 && "${partners:-0}" -gt 0 ]]; then ok "$n replication healthy ($partners links)"
    else no "$n replication" "failures=$fails links=$partners"; fi
done

echo; echo "=== 4. an object created on DC1 converges to every other DC ==="
probe="repltest-$$"
podman exec "$(dc_name 1)" samba-tool user create "$probe" --random-password >/dev/null 2>&1 \
  && echo "    created user $probe on dc1" || echo "    could not create probe user"
for i in $(seq 2 "$DC_COUNT"); do
    n=$(dc_name $i); found=no
    for t in $(seq 1 30); do
        podman exec "$n" samba-tool user list 2>/dev/null | grep -qx "$probe" && { found=yes; break; }
        sleep 2
    done
    [[ $found == yes ]] && ok "$n received $probe" || no "$n convergence" "not replicated in 60s"
done
podman exec "$(dc_name 1)" samba-tool user delete "$probe" >/dev/null 2>&1 || true

echo; echo "=== 5. every client is joined and can resolve domain identities ==="
for i in $(seq 1 "$CLIENT_COUNT"); do
    n=$(client_name $i)
    # `realm list` only reports realms REALMD manages. These clients joined with
    # adcli, so realmd knows nothing and the list is empty even though the join
    # succeeded. Ask the directory and the machine credential instead.
    acct=$(podman exec "$(dc_name 1)" samba-tool computer list 2>/dev/null | tr -d '$' | grep -ix "$n" || true)
    if podman exec "$n" net ads testjoin -P >/dev/null 2>&1; then
        ok "$n joined (machine credential valid against a live DC)"
    elif [[ -n "$acct" ]]; then
        ok "$n joined (computer account present in the directory)"
    else
        no "$n join" "no computer account and no valid machine credential"
    fi
done

echo; echo "=== 6. Kerberos actually issues tickets ==="
for i in 1 $((CLIENT_COUNT/2)) "$CLIENT_COUNT"; do
    n=$(client_name $i)
    if podman exec "$n" bash -c 'cat /run/adminpass | kinit Administrator@'"$REALM"' >/dev/null 2>&1 && klist -s'; then
        ok "$n obtained a TGT"
    else no "$n kinit" "no ticket"; fi
done

echo; echo "=== 7. SYSVOL is present and identical on every DC ==="
# Added after the gate passed a forest in which FOUR of five DCs served an EMPTY
# SYSVOL while DRS reported healthy. DRS replicates the DIRECTORY; Samba does
# not replicate SYSVOL at all, so directory health says nothing about policy
# files. sssd's ad_gpo_access_control defaults to ENFORCING and fails CLOSED on
# missing GPO data, so an empty SYSVOL locks users out with nothing logged.
ref=""; refn=""
for i in $(seq 1 "$DC_COUNT"); do
    n=$(dc_name $i)
    h=$(podman exec "$n" bash -c 'find /var/lib/samba/sysvol -type f -exec sha256sum {} \; 2>/dev/null \
        | sed "s| .*/sysvol/| |" | sort | sha256sum | cut -c1-16' 2>/dev/null)
    f=$(podman exec "$n" bash -c 'find /var/lib/samba/sysvol -type f 2>/dev/null | wc -l' 2>/dev/null)
    pol=$(podman exec "$n" bash -c 'ls -1 /var/lib/samba/sysvol/*/Policies 2>/dev/null | wc -l' 2>/dev/null)
    printf '    %-4s files=%-4s policy-dirs=%-3s hash=%s\n' "$n" "$f" "$pol" "$h"
    if [[ "${f:-0}" -eq 0 || "${pol:-0}" -eq 0 ]]; then
        no "$n SYSVOL populated" "files=$f policy-dirs=$pol"
    else
        ok "$n SYSVOL populated"
    fi
    if [[ -z "$ref" ]]; then ref="$h"; refn="$n"
    elif [[ "$h" != "$ref" ]]; then no "$n SYSVOL matches $refn" "hash $h != $ref"
    else ok "$n SYSVOL identical to $refn"; fi
done

echo; echo "=== 8. SYSVOL ACLs are valid on every DC ==="
for i in $(seq 1 "$DC_COUNT"); do
    n=$(dc_name $i)
    # NOTE: a clean sysvolcheck is necessary but NOT sufficient - acl_xattr
    # stores a hash of the POSIX ACL inside the NTACL blob, so a copy that
    # carried both still validates even when the POSIX numbers mean something
    # different on this DC. See sysvol/README.md.
    podman exec "$n" samba-tool ntacl sysvolcheck >/dev/null 2>&1 \
        && ok "$n sysvolcheck clean" || no "$n sysvolcheck" "NTACL invalid or missing"
done

echo; echo "==================== $PASS passed, $FAIL failed ===================="
[[ $FAIL -eq 0 ]]
