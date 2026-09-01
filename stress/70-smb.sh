#!/usr/bin/env bash
# SMB access tests against the domain controllers and the host file server.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")/.."
. ./lab.env
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1 ($2)"; FAIL=$((FAIL+1)); }
DC1=$(dc_ip 1); C1=$(client_name 1)

# Without this, "smbclient: command not found" reads as "server refused" and the
# anonymous-access test passes vacuously.
if ! podman exec "$C1" bash -c 'command -v smbclient' >/dev/null 2>&1; then
    echo "  installing smbclient into $C1 (absent from the image)"
    podman exec "$C1" bash -c 'DEBIAN_FRONTEND=noninteractive apt-get update -qq && apt-get install -y smbclient' >/dev/null 2>&1
fi
podman exec "$C1" bash -c 'command -v smbclient' >/dev/null 2>&1 \
    || { echo "  FATAL: smbclient unavailable - results would be meaningless"; exit 2; }
# Password reaches smbclient via the environment inside the container only,
# never on a command line (argv is world-readable through /proc).
PW=$(tr -d '\n' < "$ADMIN_PASS_FILE")

echo "=== 1. share enumeration on every DC (NTLM bind) ==="
for i in $(seq 1 "$DC_COUNT"); do
  n=$(dc_name $i); ip=$(dc_ip $i)
  out=$(podman exec -e PW="$PW" "$C1" bash -c \
        'smbclient -L //'"$ip"' -U EDT1LAB\\Administrator%"$PW" 2>&1' | grep -cE 'sysvol|netlogon' || true)
  [ "${out:-0}" -ge 2 ] && ok "$n exposes sysvol + netlogon" || no "$n shares" "found $out of 2"
done

echo; echo "=== 2. SYSVOL is readable and contains the domain policy tree ==="
out=$(podman exec -e PW="$PW" "$C1" bash -c \
      'smbclient //'"$DC1"'/sysvol -U EDT1LAB\\Administrator%"$PW" -c "cd ad.edt1.lab; ls" 2>&1')
echo "$out" | grep -E 'Policies|scripts' | sed 's/^/    /'
echo "$out" | grep -q 'Policies' && ok "SYSVOL contains Policies/" || no "SYSVOL content" "no Policies dir"

echo; echo "=== 3. write + read back through SMB ==="
podman exec -e PW="$PW" "$C1" bash -c '
  echo "smb-write-test-$$" > /tmp/probe.txt
  smbclient //'"$DC1"'/sysvol -U EDT1LAB\\Administrator%"$PW" \
    -c "cd ad.edt1.lab; put /tmp/probe.txt probe.txt" >/dev/null 2>&1' \
  && ok "wrote a file to SYSVOL over SMB" || no "SMB write" "put failed"
back=$(podman exec -e PW="$PW" "$C1" bash -c \
       'smbclient //'"$DC1"'/sysvol -U EDT1LAB\\Administrator%"$PW" -c "cd ad.edt1.lab; get probe.txt -" 2>/dev/null' | grep -c 'smb-write-test' || true)
[ "${back:-0}" -ge 1 ] && ok "read the same file back" || no "SMB read-back" "content not returned"

echo; echo "=== 4. KERBEROS-authenticated SMB (no password on the wire) ==="
podman exec -e PW="$PW" "$C1" bash -c '
  echo "$PW" | kinit Administrator@'"$REALM"' >/dev/null 2>&1
  klist -s || exit 1
  smbclient //dc1.ad.edt1.lab/sysvol --use-kerberos=required -c "ls" 2>&1' >/tmp/krbsmb.txt 2>&1
if grep -qE 'blocks of size|Policies|\.\.' /tmp/krbsmb.txt; then ok "SMB over Kerberos succeeded (GSSAPI, ticket-based)"
else no "Kerberos SMB" "$(tail -1 /tmp/krbsmb.txt | cut -c1-80)"; fi

echo; echo "=== 5. anonymous access must be refused ==="
anon=$(podman exec "$C1" bash -c 'smbclient //'"$DC1"'/sysvol -N -c "ls" 2>&1' || true)
if echo "$anon" | grep -qE 'blocks of size|Policies'; then
  no "anonymous refused" "SYSVOL served an UNAUTHENTICATED client"
elif echo "$anon" | grep -qiE 'NT_STATUS_(ACCESS_DENIED|LOGON_FAILURE)'; then
  ok "anonymous access refused by the server ($(echo "$anon" | grep -oE 'NT_STATUS_[A-Z_]+' | head -1))"
else
  no "anonymous test inconclusive" "$(echo "$anon" | tail -1 | cut -c1-70)"
fi

echo; echo "=== 6. the HOST file server (standalone, hardened, NOT domain-joined) ==="
echo "    it enforces: hosts allow = 127.0.0.1 192.168.2.0/24, guest disabled, SMB3 + mandatory encryption"

# (a) from OUTSIDE the allowed subnet: the lab is 172.15.4.0/24, so smbd should
#     drop the connection before any protocol negotiation completes.
outside=$(podman exec "$C1" bash -c 'smbclient -L //192.168.2.14 -N 2>&1' || true)
if echo "$outside" | grep -qiE 'negotiation|NT_STATUS_CONNECTION|refused|timed out'; then
    ok "host refuses 172.15.4.0/24 at connection level (hosts allow working)"
elif echo "$outside" | grep -qiE 'Sharename|sc[[:space:]]'; then
    no "hosts allow" "an out-of-subnet client ENUMERATED the shares"
else
    no "hosts allow inconclusive" "$(echo "$outside" | tail -1 | cut -c1-70)"
fi

# (b) from INSIDE the allowed subnet (the host itself): the connection should be
#     accepted, then anonymous rejected because guest access is disabled.
inside=$(smbclient -L //192.168.2.14 -N 2>&1 || true)
if echo "$inside" | grep -qiE 'NT_STATUS_ACCESS_DENIED|NT_STATUS_LOGON_FAILURE'; then
    ok "host accepts the LAN then refuses anonymous ($(echo "$inside" | grep -oE 'NT_STATUS_[A-Z_]+' | head -1))"
elif echo "$inside" | grep -qi 'Sharename'; then
    no "guest disabled" "anonymous ENUMERATED shares from the LAN"
else
    echo "    from-LAN probe: $(echo "$inside" | tail -1 | cut -c1-70)"
    no "anonymous-from-LAN inconclusive" "see above"
fi

echo; echo "==================== $PASS passed, $FAIL failed ===================="
[ "$FAIL" -eq 0 ]
