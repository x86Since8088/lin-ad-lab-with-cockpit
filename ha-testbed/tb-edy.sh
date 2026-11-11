#!/usr/bin/env bash
# tb-edy.sh — the testbed's OWN edy-proxy-go deployment (design §10). It never registers with,
# or uses, edt1's edy fleet: A runs the first-run "new cluster" path; B joins A (second trusted
# node). Runs like edy-testcluster: rootful podman in the VM, alpine + the promoted main build
# (static EdyNetworkServices + edy-files.tgz) bind-mounted read-only, --network host with
# listen_ips = the VM's sh0 address only, DHCP/PXE/netboot/ARP/bootlog off.
#   tb-edy.sh stage VM            copy the current promoted build into VM's share (app/edy/)
#   tb-edy.sh up-a                new cluster on adl-ha-a (idempotent: "exists" if running)
#   tb-edy.sh join-b              second TRUSTED node on adl-ha-b, registered with A (recipe from the
#                                 PR #515 two-trusted test: vault_host config, PKI off until registered,
#                                 then A's fleet master password as a file + pki on; own vault passphrase)
#   tb-edy.sh reset-b             retire adl-edy-b on A and wipe B's edy data (container, volume,
#                                 join marker); keeps B's vault passphrase. For re-joins and drills.
#   tb-edy.sh status              per node: version, /up, peers
#   tb-edy.sh update              rolling update B then A: stage, swap binary, restart, health
#                                 gate (/up 200 + new version), automatic rollback on failure;
#                                 logs to ha-testbed/edy-versions.log
# Secrets: generated INSIDE the VM (root 0600 under /var/lib/adl-edy/secrets); the admin API key
# reaches edt1 via the VM share's secrets/ (moved at once to ~/.config/adl-ha/, 0600, then deleted
# from the share). Nothing secret on argv, in git or in this script's output.
set -Eeuo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
. "$HERE/testbed.env"
RJ=/home/eddie/.claude/skills/root-job-runner/scripts/rj
EDY_BIN=${EDY_BIN:-/home/eddie/edy-worktrees/main-check/bin/EdyNetworkServices.exe}
EDY_TGZ=${EDY_TGZ:-/usr/local/lib/edy/bin/edy-files.tgz}
VLOG=$HERE/edy-versions.log
die() { echo "tb-edy: $*" >&2; exit 1; }
binver() { strings -n 8 "$1" | grep -m1 -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]{12}$' || true; }

cmd_stage() {
  tb_vm "${1:-}" || die "unknown VM ${1:-}"
  local v; v=$(binver "$EDY_BIN"); [ -n "$v" ] || die "$EDY_BIN has no stamped version: refusing (it would skip unpacking its files bundle)"
  local D=/srv/jobs/byMachine/$VM/app/edy
  mkdir -p "$D"
  install -m 0755 "$EDY_BIN" "$D/EdyNetworkServices.new" && mv -f "$D/EdyNetworkServices.new" "$D/EdyNetworkServices"
  install -m 0644 "$EDY_TGZ" "$D/edy-files.tgz.new" && mv -f "$D/edy-files.tgz.new" "$D/edy-files.tgz"
  echo "$v" > "$D/VERSION"
  echo "staged $v for $VM"
}

# the in-VM installer/runner (same for A and B); $1 = sh0 IP
vm_install_job() {
  cat <<EOF
set -Eeuo pipefail
IP=$1
EOF
  cat <<'EOF'
S=/srv/jobs/app/edy
install -d -m 0755 /opt/adl-edy/bin; install -d -m 0700 /var/lib/adl-edy/secrets
install -m 0755 "$S/EdyNetworkServices" /opt/adl-edy/bin/EdyNetworkServices.new
install -m 0644 "$S/edy-files.tgz" /opt/adl-edy/bin/edy-files.tgz.new
mv -f /opt/adl-edy/bin/EdyNetworkServices.new /opt/adl-edy/bin/EdyNetworkServices
mv -f /opt/adl-edy/bin/edy-files.tgz.new /opt/adl-edy/bin/edy-files.tgz
cp "$S/VERSION" /opt/adl-edy/VERSION
cat > /opt/adl-edy/entry.sh <<EOS
#!/bin/sh
# first start exits 78 after writing server.yaml: pin listen_ips to sh0, then run for real
EdyNetworkServices; rc=\$?; [ \$rc = 78 ] || exit \$rc
grep -q "^listen_ips:" /data/config/server.yaml || printf '\nlisten_ips: ["$IP", "127.0.0.1"]\n' >> /data/config/server.yaml
exec EdyNetworkServices
EOS
chmod 0755 /opt/adl-edy/entry.sh
podman image exists docker.io/library/alpine:latest || podman pull -q docker.io/library/alpine:latest >/dev/null
podman volume exists adl-edy-data || podman volume create adl-edy-data >/dev/null
ENVF=(); [ -f /var/lib/adl-edy/secrets/edy.env ] && ENVF=(--env-file /var/lib/adl-edy/secrets/edy.env)
if ! podman container exists adl-edy; then
  podman run -d --name adl-edy --network host --init --restart=always --stop-timeout 5 "${ENVF[@]}" \
    --label adl-ha.role=edy --memory 1g --pids-limit 1024 --security-opt no-new-privileges \
    -v adl-edy-data:/data -w /data \
    -v /opt/adl-edy/bin/EdyNetworkServices:/usr/local/bin/EdyNetworkServices:ro \
    -v /opt/adl-edy/bin/edy-files.tgz:/usr/local/bin/edy-files.tgz:ro \
    -v /opt/adl-edy/entry.sh:/entry.sh:ro \
    -e EDY_PROXY_GO_STORAGE=/data -e EDY_RESTRICTED_DIR=/data/restricted \
    docker.io/library/alpine:latest /entry.sh >/dev/null
fi
systemctl enable podman-restart.service >/dev/null 2>&1 || true
for i in $(seq 1 45); do curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$IP:8080/up" | grep -q 200 && break; sleep 2; done
echo "edy http /up: $(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://$IP:8080/up")  version $(cat /opt/adl-edy/VERSION)"
EOF
}

cmd_up_a() {
  tb_vm adl-ha-a; local A_IP=$HA_IP
  cmd_stage adl-ha-a
  { vm_install_job "$A_IP"; cat <<'EOF'
VOL=$(podman volume inspect adl-edy-data --format '{{.Mountpoint}}')
if grep -q '^listen_ips:' "$VOL/config/server.yaml" && ! grep -q '127.0.0.1' "$VOL/config/server.yaml"; then
  sed -i "s/^listen_ips: \[\"$IP\"\]/listen_ips: [\"$IP\", \"127.0.0.1\"]/" "$VOL/config/server.yaml"
  podman restart -t 5 adl-edy >/dev/null
  for i in $(seq 1 45); do curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:8080/up" | grep -q 200 && break; sleep 2; done
fi
if [ -f /var/lib/adl-edy/secrets/cluster.done ]; then echo "cluster exists"; exit 0; fi
rnd() { head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 24; }
for f in admin master safe vault; do [ -s /var/lib/adl-edy/secrets/$f.pass ] || (umask 077; rnd > /var/lib/adl-edy/secrets/$f.pass); done
# first-run "new cluster" (request body only in a root 0600 file, never argv)
umask 077
printf '{"node_name":"adl-edy-a","admin_username":"adladmin","admin_password":"Adl9-%s","master_password":"%s","safe_password":"%s"}' \
  "$(cat /var/lib/adl-edy/secrets/admin.pass)" "$(cat /var/lib/adl-edy/secrets/master.pass)" "$(cat /var/lib/adl-edy/secrets/safe.pass)" \
  > /var/lib/adl-edy/secrets/setup.json
# setup/cluster is local-only: call it over loopback (edy also listens on 127.0.0.1, not reachable off-VM)
R=$(curl -s -m 60 -H 'Content-Type: application/json' --data-binary @/var/lib/adl-edy/secrets/setup.json "http://127.0.0.1:8080/api/setup/cluster" || true)
shred -u /var/lib/adl-edy/secrets/setup.json
echo "$R" | grep -q '"ok":true' || { echo "setup/cluster failed: $(echo "$R" | head -c 300)"; exit 1; }
# features the testbed must not run: no DHCP/PXE/netboot/ARP/bootlog on any interface; TLS on
C=$VOL/config/config.json
jq '.server.tls.enabled=true | .dhcp.enabled=false | .pxe.enabled=false | .netboot.enabled=false
    | .arp.enabled=false | .bootlog.enabled=false | .bootlog.syslog_addr="127.0.0.1:514"
    | .bootlog.netconsole_addr="127.0.0.1:6666"' "$C" > "$C.new" && mv "$C.new" "$C"
podman restart -t 5 adl-edy >/dev/null
for i in $(seq 1 60); do curl -sk -m 3 -o /dev/null -w '%{http_code}' "https://$IP:8444/up" | grep -q 200 && break; sleep 2; done
echo "edy https /up: $(curl -sk -m 3 -o /dev/null -w '%{http_code}' "https://$IP:8444/up")"
# admin API key -> the share's secrets/ (edt1 moves it to ~/.config/adl-ha at once)
k=""; for i in 1 2 3 4 5; do k=$(podman exec adl-edy EdyNetworkServices --force account apikey create --roles global_admin --ttl 720h 2>/dev/null | tail -n1 | tr -d '[:space:]') || true; [ -n "$k" ] && break; sleep 3; done
[ -n "$k" ] || { echo "api key mint failed"; exit 1; }
(umask 007; printf '%s' "$k" > /srv/jobs/secrets/edy-a.token); unset k
touch /var/lib/adl-edy/secrets/cluster.done
ss -ltnp | awk 'NR>1 && /EdyNetwork/{print "listen", $4}' | sort -u | head -20
EOF
  } | "$RJ" -t 900 -M adl-ha-a adlha-edy-up-a
  local tok=/srv/jobs/byMachine/adl-ha-a/secrets/edy-a.token
  if [ -s "$tok" ]; then
    install -d -m 0700 "$TB_SECRETS"; install -m 0600 "$tok" "$TB_SECRETS/edy-a.token.new"
    mv -f "$TB_SECRETS/edy-a.token.new" "$TB_SECRETS/edy-a.token"; rm -f "$tok"
    echo "https://$A_IP:8444" > "$TB_SECRETS/edy-a.url"
    echo "api key -> $TB_SECRETS/edy-a.token (0600)"
  fi
  printf '%s up-a %s\n' "$(date -u +%FT%TZ)" "$(binver "$EDY_BIN")" >> "$VLOG"
}

cmd_join_b() {
  tb_vm adl-ha-a; local A_IP=$HA_IP; tb_vm adl-ha-b; local B_IP=$HA_IP
  [ -s "$TB_SECRETS/edy-a.token" ] || die "A is not up (tb-edy.sh up-a)"
  local SA=/srv/jobs/byMachine/adl-ha-a/secrets SB=/srv/jobs/byMachine/adl-ha-b/secrets
  # 1. A's fleet master password -> B's share (A share -> B share; deleted on use)
  "$RJ" -M adl-ha-a adlha-edy-master-out <<'EOF'
set -e; (umask 007; cat /var/lib/adl-edy/secrets/master.pass > /srv/jobs/secrets/master.pass); echo handed
EOF
  install -m 0660 "$SA/master.pass" "$SB/master.pass"; rm -f "$SA/master.pass"
  # 2. registration bundle minted on A (role trusted); only {bundle} kept, 0660 in B's share
  local T; T=$(mktemp -d); trap 'rm -rf "$T"' RETURN
  # names must be in the certificates edy issues: the VM hostnames (sh0 in both VMs' /etc/hosts),
  # not edy-*.adlha.test (A's cert carries adl-ha-a + its IPs only; B's register dial fails TLS otherwise)
  printf '{"node_name":"adl-edy-b","role":"trusted","dns_name":"adl-ha-b","https_url":"https://adl-ha-b:8444","controller_url":"https://adl-ha-a:8444","ttl_seconds":3600}' > "$T/mint.json"
  local H; H=$(curl -sk -m 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TB_SECRETS/edy-a.token")") \
      -X POST -H 'Content-Type: application/json' --data-binary @"$T/mint.json" -o "$T/resp.json" -w '%{http_code}' \
      "https://$A_IP:8444/api/registrations")
  [ "$H" = 201 ] || [ "$H" = 200 ] || { echo "mint -> HTTP $H: $(jq -r '.error // .message // empty' "$T/resp.json" | head -c 200)"; rm -f "$SB/master.pass"; exit 1; }
  (umask 007; jq -c '{bundle: .bundle}' "$T/resp.json" > "$SB/reg.json"); shred -u "$T/resp.json"
  echo "bundle minted on A (HTTP $H)"
  cmd_stage adl-ha-b
  # 3. B: own vault passphrase (root-only env file), container, vault_host config + seed cert, register, PKI on
  { cat <<EOF
set -Eeuo pipefail
IP=$B_IP; DNS=adl-ha-b
install -d -m 0700 /var/lib/adl-edy/secrets
[ -s /var/lib/adl-edy/secrets/edy.env ] || (umask 077; printf 'EDY_VAULT_PASSPHRASE=%s\n' "\$(head -c 32 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 24)" > /var/lib/adl-edy/secrets/edy.env)
EOF
    vm_install_job "$B_IP" | sed '1,2d'
    cat <<'EOF'
DNS=adl-ha-b
VOL=$(podman volume inspect adl-edy-data --format '{{.Mountpoint}}')
if [ -f /var/lib/adl-edy/secrets/joined.done ]; then echo "B already joined"; exit 0; fi
wait_https() { for i in $(seq 1 60); do [ "$(curl -sk -m 3 -o /dev/null -w '%{http_code}' https://$IP:8444/up)" = 200 ] && return 0; sleep 2; done; return 1; }
install -d -m 0700 "$VOL/restricted"
openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 400 -subj "/CN=$DNS" \
  -addext "subjectAltName=DNS:$DNS,IP:$IP" -addext "extendedKeyUsage=serverAuth" \
  -keyout "$VOL/restricted/seed.key" -out "$VOL/restricted/seed.crt" >/dev/null 2>&1
chmod 0600 "$VOL/restricted/seed.key"
cat > "$VOL/config/config.json" <<'JSON'
{"server":{"host":"0.0.0.0","port":8080,
  "tls":{"enabled":true,"port":8444,"cert_file":"/data/restricted/seed.crt","key_file":"/data/restricted/seed.key"},
  "node_role":"vault_host","restricted_dir":"/data/restricted"},
 "database":{"path":"/data/edy.db"},"dns":{"enabled":false},"dns_external":{"enabled":false},"dhcp":{"enabled":false},
 "pxe":{"enabled":false},"arp":{"enabled":false},"bootlog":{"enabled":false,"syslog_addr":"127.0.0.1:514","netconsole_addr":"127.0.0.1:6666"},"netboot":{"enabled":false},"pki":{"enabled":false},
 "hypervisor":{"hyperv":{"enabled":false},"kvm":{"enabled":false}}}
JSON
podman restart -t 2 adl-edy >/dev/null; wait_https || { echo "B https (seed) never came up"; exit 1; }
echo "B up on seed cert"
# register over loopback with the first-run token (header via a 0600 curl config, never argv)
umask 077; printf 'header = "X-Setup-Token: %s"\n' "$(tr -d '[:space:]' < "$VOL/restricted/first-run-token")" > /var/lib/adl-edy/secrets/reg.cfg
H=$(curl -s -m 150 -K /var/lib/adl-edy/secrets/reg.cfg -X POST -H 'Content-Type: application/json' \
    --data-binary @/srv/jobs/secrets/reg.json -o /var/lib/adl-edy/secrets/reg.out -w '%{http_code}' http://127.0.0.1:8080/api/setup/register || true)
shred -u /var/lib/adl-edy/secrets/reg.cfg; rm -f /srv/jobs/secrets/reg.json   # 9p share: shred cannot truncate
[ "$H" = 200 ] || [ "$H" = 201 ] || { echo "setup/register -> HTTP $H: $(jq -r '[.error,.failure_class,.fix]|map(select(.!=null))|join(" | ")' /var/lib/adl-edy/secrets/reg.out 2>/dev/null | head -c 400)"; shred -u /var/lib/adl-edy/secrets/reg.out; rm -f /srv/jobs/secrets/master.pass; exit 1; }
shred -u /var/lib/adl-edy/secrets/reg.out
echo "B registered with A"
podman restart -t 2 adl-edy >/dev/null; wait_https || { echo "B https after register never came up"; exit 1; }
# AFTER registering: the fleet master password as a file, then PKI on
install -m 0600 /srv/jobs/secrets/master.pass "$VOL/restricted/pki-master-password"; rm -f /srv/jobs/secrets/master.pass
# pki.enabled must be UNSET, not true: in this build an EXPLICIT enable makes the node a CA origin that
# mints its own root ("only an explicit enable mints"); unset = replica that adopts A's root via ca_key
# replication (and can fetch the master password from a trusted peer). The PR #515 recipe's "set true"
# minted a second fleet root here on 2026-11-11.
C=$VOL/config/config.json; jq 'del(.pki.enabled) | .dhcp.enabled=false | .pxe.enabled=false | .netboot.enabled=false | .arp.enabled=false | .bootlog.enabled=false | .bootlog.syslog_addr="127.0.0.1:514" | .bootlog.netconsole_addr="127.0.0.1:6666"' "$C" > "$C.new" && mv "$C.new" "$C"
podman restart -t 2 adl-edy >/dev/null; wait_https || { echo "B https after PKI on never came up"; podman logs --tail 15 adl-edy 2>&1 | cut -c1-200; exit 1; }
echo "B PKI as replica (pki.enabled unset), fleet master password provided"
k=""; for i in 1 2 3 4 5; do k=$(podman exec adl-edy EdyNetworkServices --force account apikey create --roles global_admin --ttl 720h 2>/dev/null | tail -n1 | tr -d '[:space:]') || true; [ -n "$k" ] && break; sleep 3; done
[ -n "$k" ] && (umask 007; printf '%s' "$k" > /srv/jobs/secrets/edy-b.token); unset k
touch /var/lib/adl-edy/secrets/joined.done
{ ss -ltnp | awk 'NR>1 && /EdyNetwork/{print "tcp", $4}'; ss -lunp | awk 'NR>1 && /EdyNetwork/{print "udp", $4}'; } | sort -u
EOF
  } | "$RJ" -t 900 -M adl-ha-b adlha-edy-join-b
  local tok=$SB/edy-b.token
  if [ -s "$tok" ]; then
    install -m 0600 "$tok" "$TB_SECRETS/edy-b.token.new"; mv -f "$TB_SECRETS/edy-b.token.new" "$TB_SECRETS/edy-b.token"
    rm -f "$tok"; echo "https://$B_IP:8444" > "$TB_SECRETS/edy-b.url"
    echo "api key -> $TB_SECRETS/edy-b.token (0600)"
  fi
  rm -f "$SB/master.pass" "$SB/reg.json" 2>/dev/null || true
  printf '%s join-b %s\n' "$(date -u +%FT%TZ)" "$(binver "$EDY_BIN")" >> "$VLOG"
}

cmd_reset_b() {
  tb_vm adl-ha-a; local A_IP=$HA_IP
  local H; H=$(curl -sk -m 60 -K <(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$TB_SECRETS/edy-a.token")") \
      -X POST -H 'Content-Type: application/json' -d '{"confirm":"adl-edy-b","reason":"adl-ha testbed: reset B for a re-join"}' \
      -o /dev/null -w '%{http_code}' "https://$A_IP:8444/api/nodes/adl-edy-b/retire")
  echo "retire adl-edy-b on A -> HTTP $H"
  "$RJ" -t 300 -M adl-ha-b adlha-edy-reset-b <<'EOF'
set -Eeuo pipefail
podman rm -f -t 2 adl-edy >/dev/null 2>&1 || true
podman volume rm -f adl-edy-data >/dev/null 2>&1 || true
rm -f /var/lib/adl-edy/secrets/joined.done
echo "B edy wiped (vault passphrase kept)"
EOF
  rm -f "$TB_SECRETS/edy-b.token" "$TB_SECRETS/edy-b.url"
  printf '%s reset-b\n' "$(date -u +%FT%TZ)" >> "$VLOG"
}

api() { # NODE(a|b) METHOD PATH
  local t="$TB_SECRETS/edy-$1.token" u; u=$(cat "$TB_SECRETS/edy-$1.url")
  [ -s "$t" ] || die "no token for $1"
  curl -sk -m 15 -K <(printf 'header = "Authorization: Bearer %s"\n' "$(cat "$t")") -X "$2" "$u$3"
}

cmd_status() {
  local n; for n in a b; do
    [ -s "$TB_SECRETS/edy-$n.url" ] || { echo "edy-$n: not set up"; continue; }
    local u; u=$(cat "$TB_SECRETS/edy-$n.url")
    printf 'edy-%s %s  up=%s  ' "$n" "$u" "$(curl -sk -m 5 -o /dev/null -w '%{http_code}' "$u/up")"
    api "$n" GET /api/peers 2>/dev/null | jq -r '[.peers[]? | "\(.name):\(.status)"] | "peers=" + (join(",") | if .=="" then "-" else . end)' 2>/dev/null || echo "peers=?"
  done
}

cmd_update() {
  local new; new=$(binver "$EDY_BIN"); [ -n "$new" ] || die "unstamped build"
  local vm ip
  for vm in adl-ha-b adl-ha-a; do                       # B first, A (the founder) last
    tb_vm "$vm"; ip=$HA_IP
    "$RJ" -M "$vm" "adlha-edy-has-$vm" <<<'podman container exists adl-edy && echo yes || echo no' | grep -q '^yes' \
      || { echo "$vm: no edy node yet, skipped"; continue; }
    cmd_stage "$vm"
    if "$RJ" -t 600 -M "$vm" "adlha-edy-update-$vm" <<EOF
set -Eeuo pipefail
IP=$ip; NEW=$new
B=/opt/adl-edy/bin
cp -f \$B/EdyNetworkServices \$B/EdyNetworkServices.prev; cp -f \$B/edy-files.tgz \$B/edy-files.tgz.prev; cp -f /opt/adl-edy/VERSION /opt/adl-edy/VERSION.prev
install -m 0755 /srv/jobs/app/edy/EdyNetworkServices \$B/EdyNetworkServices.new && mv -f \$B/EdyNetworkServices.new \$B/EdyNetworkServices
install -m 0644 /srv/jobs/app/edy/edy-files.tgz \$B/edy-files.tgz.new && mv -f \$B/edy-files.tgz.new \$B/edy-files.tgz
cp /srv/jobs/app/edy/VERSION /opt/adl-edy/VERSION
podman restart -t 10 adl-edy >/dev/null
ok=0; for i in \$(seq 1 60); do [ "\$(curl -sk -m 3 -o /dev/null -w '%{http_code}' https://\$IP:8444/up)" = 200 ] && { ok=1; break; }; sleep 2; done
if [ \$ok = 1 ]; then echo "updated to \$NEW, /up 200"; exit 0; fi
echo "health gate FAILED: rolling back"
mv -f \$B/EdyNetworkServices.prev \$B/EdyNetworkServices; mv -f \$B/edy-files.tgz.prev \$B/edy-files.tgz; mv -f /opt/adl-edy/VERSION.prev /opt/adl-edy/VERSION
podman restart -t 10 adl-edy >/dev/null; exit 1
EOF
    then printf '%s update %s %s ok\n' "$(date -u +%FT%TZ)" "$vm" "$new" >> "$VLOG"
    else printf '%s update %s %s ROLLED-BACK\n' "$(date -u +%FT%TZ)" "$vm" "$new" >> "$VLOG"; die "$vm failed its health gate; rolled back, A not touched"
    fi
  done
}

case ${1:-} in
  stage) cmd_stage "${2:-}";; up-a) cmd_up_a;; join-b) cmd_join_b;; reset-b) cmd_reset_b;; status) cmd_status;; update) cmd_update;;
  *) sed -n '2,15p' "$0"; exit 2;;
esac
