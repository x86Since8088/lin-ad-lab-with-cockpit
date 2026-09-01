#!/usr/bin/env bash
# Join rdp1 to AD.EDT1.LAB and create the AD account used for the RDP login.
#
# The join itself is done by the existing installer — this script only adds the
# two things an RDP target needs beyond a plain domain member:
#   1. a GPO service mapping, so sssd treats an xrdp-sesman login as an
#      interactive logon rather than an unknown service
#   2. a running sssd, because the container entrypoint already ran before
#      /etc/sssd/sssd.conf existed
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./rdp.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

N=$(rdp_name "$RDP_JOINED")
PEER=$(dc_ip 1)

echo "== joining $N to $REALM via $PEER =="
podman exec "$N" /usr/local/sbin/edy-domain-install \
    --role client --realm "$REALM" --domain-nb "$DOMAIN_NB" \
    --peer "$PEER" --forwarder "$FORWARDER" --pass-file /run/adminpass

echo
echo "== sssd tuning for interactive RDP logons =="
# The installer writes access_provider = ad. sssd's AD access provider
# evaluates GPO "log on locally" rights, and it only knows a fixed list of PAM
# service names — xrdp-sesman is not one of them, so it lands in the
# unmapped-service bucket and is denied before krb5 is ever consulted.
# ad_gpo_map_interactive teaches it the service name.
podman exec "$N" bash -c '
set -e
f=/etc/sssd/sssd.conf
grep -q "^ad_gpo_map_interactive" "$f" || \
  printf "ad_gpo_map_interactive = +xrdp-sesman\nad_gpo_access_control = enforcing\n" >> "$f"
chmod 600 "$f"
sed -n "/^\[domain/,\$p" "$f"
'

echo
echo "== starting sssd on $N =="
podman exec "$N" bash -c '
pkill -x sssd 2>/dev/null; sleep 1
rm -f /var/lib/sss/db/*.ldb /var/lib/sss/mc/* 2>/dev/null
sssd -D && sleep 4 && pgrep -a sssd | head -5
'

echo
echo "== creating domain account $DOMAIN_USER on $(dc_name 1) =="
gen_pass "$DOMAIN_PASS_FILE"
# Password goes in on stdin via a here-doc-free path: samba-tool reads
# --newpassword from argv, which would expose it in /proc, so use the
# interactive form fed from a pipe instead.
if podman exec "$(dc_name 1)" samba-tool user list | grep -qx "$DOMAIN_USER"; then
    echo "  $DOMAIN_USER already exists — resetting its password"
    podman exec -i "$(dc_name 1)" bash -c \
      'p=$(cat); samba-tool user setpassword '"$DOMAIN_USER"' --newpassword="$p" >/dev/null && echo "  password reset"' \
      < "$DOMAIN_PASS_FILE"
else
    podman exec -i "$(dc_name 1)" bash -c \
      'p=$(cat); samba-tool user create '"$DOMAIN_USER"' "$p" \
         --given-name=RDP --surname=Tester \
         --description="RDP login test account" >/dev/null && echo "  created"' \
      < "$DOMAIN_PASS_FILE"
fi
podman exec "$(dc_name 1)" samba-tool user show "$DOMAIN_USER" \
    | grep -E '^(sAMAccountName|userPrincipalName|userAccountControl|distinguishedName)' | sed 's/^/  /'

echo
echo "== NSS resolution of the domain account on $N =="
podman exec "$N" bash -c "getent passwd $DOMAIN_USER || echo '  NOT RESOLVED'"
podman exec "$N" bash -c "id $DOMAIN_USER || true"

echo
echo "join stage complete."
