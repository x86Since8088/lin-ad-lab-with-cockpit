#!/usr/bin/env bash
# tb-ha.sh — install the HA host engine (cockpit-adlab/adlab-ha) into the testbed VMs.
#   tb-ha.sh install [VM]   /usr/local/sbin/adlab-ha, /etc/adlab-ha/host.json (this VM's DCs + its
#                           peer), adlab-ha-agent.service (collector, lease watchdog, SYSVOL timer),
#                           rsync, and a sudoers rule letting eddie run ONLY `adlab-ha json` (the
#                           controller's channel: ssh eddie@VM sudo -n /usr/local/sbin/adlab-ha json)
#   tb-ha.sh call VM VERB [ARGS-JSON] [EPOCH]   one envelope via that channel (op_id generated)
set -Eeuo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
REPO=$(dirname "$HERE")
. "$HERE/testbed.env"
RJ=/home/eddie/.claude/skills/root-job-runner/scripts/rj

host_json() { # VM -> host.json
  python3 - "$1" <<'PY'
import json, sys
vm = sys.argv[1]
dcs = {"dc1": ("adl-ha-a", "10.31.0.17", "Default-First-Site-Name"), "dc2": ("adl-ha-a", "10.31.0.18", "Default-First-Site-Name"),
       "dc3": ("adl-ha-b", "10.31.0.33", "adl-ha-b"), "dc4": ("adl-ha-b", "10.31.0.34", "adl-ha-b")}
hosts = {"adl-ha-a": "10.31.0.11", "adl-ha-b": "10.31.0.12"}
print(json.dumps({
  "host_id": vm, "host_name": vm, "sh0_ip": hosts[vm],
  "realm": "HA.TEST.LAB", "domain_nb": "HATEST",
  "dcs": {d: {"ip": ip, "site": site, "state_dir": "/opt/adl-forest/state/" + d}
          for d, (h, ip, site) in dcs.items() if h == vm},
  "all_dcs": {d: ip for d, (h, ip, s) in dcs.items()},
  "dc_host": {d: h for d, (h, ip, s) in dcs.items()},
  "peer_hosts": {h: ip for h, ip in hosts.items() if h != vm},
  "dc_network": "adl-dc", "dc_image": "localhost/samba-ad-dc:latest",
  "admin_pass_file": "/opt/adl-forest/secrets/administrator.pass", "forwarder": "10.31.0.11",
  "sysvol_allow": "10.31.0.0/24"}, indent=1))
PY
}

cmd_install() {
  local vms=("${1:-adl-ha-a}"); [ -z "${1:-}" ] && vms=(adl-ha-a adl-ha-b)
  local vm
  for vm in "${vms[@]}"; do
    local D=/srv/jobs/byMachine/$vm/app/ha; mkdir -p "$D"
    install -m 0755 "$REPO/cockpit-adlab/adlab-ha" "$D/adlab-ha"
    host_json "$vm" > "$D/host.json"
    "$RJ" -t 600 -M "$vm" "adlha-ha-install" <<'EOF'
set -Eeuo pipefail
command -v rsync >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q rsync >/dev/null
install -m 0755 /srv/jobs/app/ha/adlab-ha /usr/local/sbin/adlab-ha
install -d -m 0755 /etc/adlab-ha; install -m 0644 /srv/jobs/app/ha/host.json /etc/adlab-ha/host.json
install -d -m 0750 /var/lib/adlab/ha
cat > /etc/systemd/system/adlab-ha-agent.service <<'U'
[Unit]
Description=adlab-ha agent: collector, lease watchdog (self-fencing), SYSVOL single-writer replication
After=network-online.target podman-restart.service
Wants=network-online.target

[Service]
ExecStart=/usr/local/sbin/adlab-ha agent
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
U
umask 0337; printf 'eddie ALL=(root) NOPASSWD: /usr/local/sbin/adlab-ha json\n' > /etc/sudoers.d/60-adlab-ha
visudo -cf /etc/sudoers.d/60-adlab-ha >/dev/null
systemctl daemon-reload; systemctl enable adlab-ha-agent >/dev/null 2>&1; systemctl restart adlab-ha-agent
sleep 3; systemctl is-active adlab-ha-agent
echo "adlab-ha $(sha256sum /usr/local/sbin/adlab-ha | cut -c1-12) on $(hostname)"
EOF
  done
}

cmd_call() { # VM VERB [ARGS] [EPOCH]
  tb_vm "${1:?VM}" || { echo "unknown VM" >&2; exit 2; }
  local verb=${2:?VERB} args=${3:-"{}"} ep=${4:-}
  local req
  req=$(python3 -c 'import json,sys,uuid; r={"schema_version":"adlab-ha/1","verb":sys.argv[1],"args":json.loads(sys.argv[2]),"op_id":"cli-"+uuid.uuid4().hex[:16]}
if sys.argv[3]: r["epoch"]=int(sys.argv[3])
print(json.dumps(r))' "$verb" "$args" "$ep")
  ssh -o BatchMode=yes -o ConnectTimeout=5 "eddie@$LAB_IP" sudo -n /usr/local/sbin/adlab-ha json <<<"$req"
}

case ${1:-} in
  install) cmd_install "${2:-}";; call) shift; cmd_call "$@";;
  *) sed -n '2,8p' "$0"; exit 2;;
esac
