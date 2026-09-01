#!/usr/bin/env bash
# Stress the forest: mass identity creation, replication under load, and
# authentication at scale. Everything is timed, because "it worked" is far less
# useful than "it worked and here is the rate".
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
. ./lab.env
USERS="${USERS:-500}"
GROUP_COUNT="${GROUP_COUNT:-50}"   # NOT "GROUPS": that is a bash special variable
AUTHS="${AUTHS:-100}"
DC1=$(dc_id=1; dc_ip 1)
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1 ($2)"; FAIL=$((FAIL+1)); }
t0(){ date +%s.%N; }
el(){ echo "scale=1; ($(date +%s.%N) - $1)/1" | bc; }

echo "=== A. mass user creation: $USERS users on dc1 ==="
s=$(t0)
podman exec "$(dc_name 1)" bash -c '
  n='"$USERS"'
  for i in $(seq 1 $n); do
    printf "dn: CN=stress%05d,CN=Users,DC=ad,DC=edt1,DC=lab\nchangetype: add\nobjectClass: user\nsAMAccountName: stress%05d\nuserPrincipalName: stress%05d@ad.edt1.lab\n\n" $i $i $i
  done > /tmp/users.ldif
  ldbadd -H /var/lib/samba/private/sam.ldb /tmp/users.ldif >/dev/null 2>&1
  echo "created: $(ldbsearch -H /var/lib/samba/private/sam.ldb "(sAMAccountName=stress*)" dn 2>/dev/null | grep -c "^dn:")"
' 2>&1 | sed 's/^/    /'
d=$(el "$s"); echo "    elapsed ${d}s"
made=$(podman exec "$(dc_name 1)" ldbsearch -H /var/lib/samba/private/sam.ldb '(sAMAccountName=stress*)' dn 2>/dev/null | grep -c '^dn:' || true)
[ "${made:-0}" -ge "$USERS" ] && ok "$made users created in ${d}s ($(echo "scale=1;$made/$d" | bc)/s)" || no "user creation" "$made/$USERS"

echo; echo "=== B. mass group creation + membership: $GROUP_COUNT groups ==="
s=$(t0)
podman exec "$(dc_name 1)" bash -c '
  for i in $(seq 1 '"$GROUP_COUNT"'); do
    samba-tool group add "stressgrp$i" >/dev/null 2>&1
  done
  # put 10 users in each group to exercise linked-attribute replication
  for i in $(seq 1 '"$GROUP_COUNT"'); do
    m=""
    for j in $(seq 1 10); do u=$(( (i-1)*10 + j )); [ $u -le '"$USERS"' ] && m="$m,stress$(printf %05d $u)"; done
    [ -n "$m" ] && samba-tool group addmembers "stressgrp$i" "${m#,}" >/dev/null 2>&1
  done
' 2>&1 | tail -2 | sed 's/^/    /'
d=$(el "$s")
g=$(podman exec "$(dc_name 1)" samba-tool group list 2>/dev/null | grep -c '^stressgrp' || true)
[ "${g:-0}" -ge "$GROUP_COUNT" ] && [ "${g:-0}" -gt 0 ] && ok "$g groups with members created in ${d}s" || no "group creation" "$g/$GROUP_COUNT"

echo; echo "=== C. does that volume replicate to all $((DC_COUNT-1)) partners? ==="
for i in $(seq 2 "$DC_COUNT"); do
  n=$(dc_name $i); s=$(t0); found=0
  for t in $(seq 1 60); do
    c=$(podman exec "$n" ldbsearch -H /var/lib/samba/private/sam.ldb '(sAMAccountName=stress*)' dn 2>/dev/null | grep -c '^dn:' || true)
    [ "${c:-0}" -ge "$USERS" ] && { found=$c; break; }
    sleep 2
  done
  d=$(el "$s")
  [ "$found" -ge "$USERS" ] && ok "$n converged $found users in ${d}s" || no "$n convergence" "only ${c:-0}/$USERS after 120s"
done

echo; echo "=== D. authentication at scale: $AUTHS kinit against rotating DCs ==="
podman exec "$(dc_name 1)" bash -c 'samba-tool user setpassword stress00001 --newpassword="StressPass!2026" >/dev/null 2>&1' || true
s=$(t0); good=0; bad=0
for i in $(seq 1 "$AUTHS"); do
  c=$(client_name $(( (i % CLIENT_COUNT) + 1 )))
  if podman exec "$c" bash -c 'echo "StressPass!2026" | kinit stress00001@'"$REALM"' >/dev/null 2>&1 && klist -s'; then
    good=$((good+1)); else bad=$((bad+1)); fi
done
d=$(el "$s")
echo "    $good succeeded, $bad failed in ${d}s ($(echo "scale=1;$good/$d" | bc) auth/s)"
[ "$bad" -eq 0 ] && ok "$good/$AUTHS authentications succeeded" || no "authentication" "$bad failures"

echo; echo "=== E. authentication failure handling (wrong password must be refused) ==="
if podman exec "$(client_name 1)" bash -c 'echo "WrongPassword!" | kinit stress00001@'"$REALM"' >/dev/null 2>&1'; then
  no "bad password rejected" "kinit ACCEPTED a wrong password"
else ok "wrong password correctly refused"; fi

echo; echo "=== F. directory still healthy after the load ==="
for i in $(seq 1 "$DC_COUNT"); do
  n=$(dc_name $i)
  f=$(podman exec "$n" samba-tool drs showrepl 2>/dev/null | grep -cE '[1-9][0-9]* consecutive failure|WERR_' || true)
  [ "${f:-0}" -eq 0 ] && ok "$n replication still clean" || no "$n replication" "$f failures"
done
echo "    dbcheck on dc1:"
podman exec "$(dc_name 1)" samba-tool dbcheck --cross-ncs 2>&1 | tail -3 | sed 's/^/      /'

echo; echo "==================== $PASS passed, $FAIL failed ===================="
[ "$FAIL" -eq 0 ]
