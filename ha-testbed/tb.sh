#!/usr/bin/env bash
# tb.sh — the HA testbed's two Ubuntu VMs (design docs/design/HA-MULTI-HOST.md §10). Run as eddie;
# root steps go through the host job runner (rj), like edy-rapid-update's vm.sh.
#   tb.sh net [--dry-run]            define+start libvirt network adl-shared (10.31.0.0/24, edt1 .1, no forward/DHCP/DNS)
#   tb.sh create VM [--dry-run]      stock Ubuntu noble cloud image (full copy), cloud-init seed:
#                                    ssh (key only) + cockpit + podman + guest agent; runner share
#   tb.sh status [VM]                one line per VM
#   tb.sh destroy VM --yes-destroy-VM   undefine + remove exactly its disk and seed
#   tb.sh snapshot NAME              shut BOTH VMs down (guest agent, never forced), qemu-img snapshot
#                                    each OS disk as NAME, start both, wait for ssh
#   tb.sh snapshots                  list snapshots per VM
#   tb.sh revert NAME --yes-revert   shut both down, revert BOTH disks to NAME, start both. Always both
#                                    together: the testbed forest and edy cluster span the two VMs, so
#                                    reverting one alone would be a USN rollback (design §2)
# Only names listed in testbed.env are accepted: this script cannot touch any other VM.
set -Eeuo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
. "$HERE/testbed.env"
RJ=/home/eddie/.claude/skills/root-job-runner/scripts/rj
SHARE_SH=/srv/jobs/vm-config/host/vm-runner-share.sh
V=(virsh -q -c qemu:///system)
DRY=0; ARGS=(); for a in "$@"; do [ "$a" = --dry-run ] && DRY=1 || ARGS+=("$a"); done; set -- "${ARGS[@]+"${ARGS[@]}"}"
die() { echo "tb: $*" >&2; exit 1; }
need_vm() { tb_vm "${1:-}" || die "unknown testbed VM '${1:-}' (known: $(printf '%s ' "${TB_VMS[@]%% *}"))"; }
dom_exists() { "${V[@]}" dominfo "$1" >/dev/null 2>&1; }
root_job() { # NAME TIMEOUT  (body on stdin)
  if ((DRY)); then echo "[dry-run] root job $1:"; sed 's/^/    | /'; else "$RJ" -t "$2" "$1"; fi; }

cmd_net() {
  if "${V[@]}" net-info "$TB_NET" >/dev/null 2>&1; then echo "net $TB_NET exists ($( "${V[@]}" net-info "$TB_NET" | awk -F': *' '/^Active/{print "active="$2}'))"; return 0; fi
  root_job "adlha-net" 120 <<EOF
set -Eeuo pipefail
x=\$(mktemp)
cat > "\$x" <<'XML'
<network>
  <name>$TB_NET</name>
  <!-- HA testbed shared subnet on edt1: both test VMs + edt1 (.1). No <forward> (not routed to the
       LAN), DNS off, no DHCP. docs/design/HA-MULTI-HOST.md §10 -->
  <bridge name='$TB_BRIDGE' stp='on' delay='0'/>
  <dns enable='no'/>
  <ip address='$TB_SHARED_HOST_IP' netmask='255.255.255.0'/>
</network>
XML
virsh -q net-define "\$x"; rm -f "\$x"
virsh -q net-autostart $TB_NET; virsh -q net-start $TB_NET
virsh net-info $TB_NET | grep -E 'Name|Active|Bridge'
ip -br addr show $TB_BRIDGE
EOF
}

render_seed() { # -> $OUT/{user-data,meta-data,network-config}
  local OUT=$1 key hash peer peer_ha peer_sub hosts="" l f
  key=$(cat "$HOME/.ssh/id_ed25519.pub")
  install -d -m 0700 "$TB_SECRETS"
  if [ ! -s "$TB_SECRETS/eddie.pass" ]; then
    (umask 077; head -c 24 /dev/urandom | base64 | tr -dc A-Za-z0-9 | head -c 20 > "$TB_SECRETS/eddie.pass")
  fi
  hash=$(openssl passwd -6 -stdin < "$TB_SECRETS/eddie.pass")
  for l in "${TB_VMS[@]}"; do read -r -a f <<<"$l"
    hosts+="      ${f[5]} ${f[0]}.$TB_DOMAIN ${f[0]} edy-${f[0]#adl-ha-}.$TB_DOMAIN\n"
    [ "${f[0]}" != "$VM" ] && { peer=${f[0]}; peer_ha=${f[5]}; }
  done
  local mv="TB_ISO_SUBNET_${VM//-/_}" dv="TB_DC_RANGE_${VM//-/_}"; my_sub=${!mv}; dc_range=${!dv}
  cat > "$OUT/user-data" <<EOF
#cloud-config
# adl-ha testbed seed for $VM (tb.sh). Contains a password HASH, no secret.
hostname: $VM
fqdn: $VM.$TB_DOMAIN
manage_etc_hosts: false
ssh_pwauth: false
disable_root: true
users:
  - name: eddie
    gecos: testbed admin (ssh key; password for cockpit/sudo is in ~/.config/adl-ha/eddie.pass on edt1)
    shell: /bin/bash
    groups: [sudo]
    lock_passwd: false
    hashed_passwd: "$hash"
    ssh_authorized_keys: ["$key"]
package_update: true
package_upgrade: true
packages: [openssh-server, qemu-guest-agent, cockpit, cockpit-podman, podman, chrony, rsync, jq, curl, acl, attr, git]
ntp:
  enabled: true
  ntp_client: chrony
  servers: ["$TB_NTP"]
write_files:
  - path: /etc/hosts
    content: |
      127.0.0.1 localhost
      127.0.1.1 $VM.$TB_DOMAIN $VM
$(printf "$hosts")
  - path: /etc/adl-ha/identity
    content: "vm=$VM lan0=$LAB_IP sh0=$HA_IP iso=$my_sub dc_range=$dc_range peer=$peer peer_sh0=$peer_ha testbed=adl-ha isolated-edy=1\n"
runcmd:
  - [ systemctl, enable, --now, qemu-guest-agent, ssh, cockpit.socket ]
  # isolated VM-local subnet: NON-DC test containers only (testbed.env TB_ISO_*)
  - [ /bin/bash, -c, "podman network exists $TB_ISO_NET || podman network create --subnet $my_sub --gateway ${my_sub%.0/24}.1 $TB_ISO_NET" ]
  # DC network: macvlan on sh0 = the shared subnet on edt1; this VM hands out only its own /28 to DCs
  - [ /bin/bash, -c, "podman network exists $TB_DC_NET || podman network create -d macvlan -o parent=sh0 --subnet $TB_SHARED_SUBNET --ip-range $dc_range $TB_DC_NET" ]
  - [ /bin/bash, -c, "echo net.ipv4.ip_forward=1 > /etc/sysctl.d/60-adl-ha.conf && sysctl -q -p /etc/sysctl.d/60-adl-ha.conf" ]
  - [ /bin/bash, -c, "mkdir -p /mnt/edt1 && chmod 0700 /mnt/edt1 && for i in \$(seq 1 10); do mountpoint -q /mnt/edt1 || mount -t 9p -o trans=virtio,version=9p2000.L,access=0,rw,nodev,nosuid edt1 /mnt/edt1; [ -x /mnt/edt1/app/setup-guest-runner.sh ] && break; sleep 3; done; /mnt/edt1/app/setup-guest-runner.sh" ]
final_message: "adl-ha $VM first boot done after \$UPTIME s"
EOF
  cat > "$OUT/network-config" <<EOF
network:
  version: 2
  ethernets:
    lab0:
      match: {macaddress: "$MACP:01"}
      set-name: lab0
      dhcp4: false
      addresses: ["$LAB_IP/24"]
      routes: [{to: default, via: $TB_LAN_GW}]
      nameservers: {addresses: [$(sed 's/ /, /' <<<"$TB_DNS")]}
    sh0:
      match: {macaddress: "$MACP:02"}
      set-name: sh0
      dhcp4: false
      addresses: ["$HA_IP/24"]
      optional: true
EOF
  printf 'instance-id: %s-%s\nlocal-hostname: %s\n' "$VM" "$(cat "$OUT/user-data" "$OUT/network-config" | sha256sum | cut -c1-12)" "$VM" > "$OUT/meta-data"
}

cmd_create() {
  need_vm "${1:-}"
  dom_exists "$VM" && { echo "exists: $VM"; cmd_status "$VM"; return 0; }
  "${V[@]}" net-info "$TB_NET" >/dev/null 2>&1 || ((DRY)) || die "network $TB_NET missing: tb.sh net first"
  ping -c1 -W1 "$LAB_IP" >/dev/null 2>&1 && die "$LAB_IP already answers ping: collision"
  ip neigh show "$LAB_IP" | grep -q lladdr && die "$LAB_IP has a live ARP entry: collision"
  local d mac; for d in $("${V[@]}" list --all --name); do for mac in "$MACP:01" "$MACP:02"; do
    "${V[@]}" domiflist "$d" 2>/dev/null | grep -qi "$mac" && die "MAC $mac already used by $d"; done; done
  local S="$TB_STATE/$VM"; install -d -m 0700 "$S/seed"
  render_seed "$S/seed"
  cloud-localds -N "$S/seed/network-config" "$S/seed.iso" "$S/seed/user-data" "$S/seed/meta-data"
  ((DRY)) && { echo "--- seed user-data (hash masked)"; sed 's/hashed_passwd: .*/hashed_passwd: <hash>/' "$S/seed/user-data" | cut -c1-160; echo "--- network-config"; cat "$S/seed/network-config"; }
  local OS=$TB_IMG_DIR/$VM.qcow2 SEED=$TB_IMG_DIR/$VM-seed.iso
  local VI="virt-install --connect qemu:///system --name $VM --memory $MEM --vcpus $CPUS --cpu host-passthrough --machine q35 --os-variant ubuntu24.04 --import --disk path=$OS,format=qcow2,bus=virtio --disk path=$SEED,device=cdrom --network bridge=$TB_LAN_BRIDGE,model=virtio,mac=$MACP:01 --network bridge=$TB_BRIDGE,model=virtio,mac=$MACP:02 --filesystem source=/srv/jobs/byMachine/$VM,target=edt1,accessmode=squash --graphics none --noautoconsole --metadata title=$VM,description=adl-ha-HA-testbed-isolated-edy-samba-ad-lab-ha-testbed"
  root_job "adlha-create-$VM" 900 <<EOF
set -Eeuo pipefail
OS=$OS; SEED=$SEED
for f in "\$OS" "\$SEED"; do [ -e "\$f" ] && { echo "leftover \$f exists without a domain: refusing"; exit 3; }; done
install -d -m 0711 $TB_IMG_DIR
qemu-img convert -O qcow2 $TB_BASE "\$OS.new"; qemu-img resize "\$OS.new" ${DISK}G >/dev/null; mv "\$OS.new" "\$OS"; chmod 0600 "\$OS"
install -m 0644 $S/seed.iso "\$SEED"
mkdir -p /srv/jobs/byMachine/$VM
x=\$(mktemp); $VI --print-xml > "\$x"; virsh -q define "\$x"; rm -f "\$x"
virsh -q autostart --disable $VM || true
$SHARE_SH $VM
virsh -q start $VM
echo "started $VM"
EOF
  ((DRY)) && return 0
  echo "waiting for first boot (apt upgrade + cockpit install: 3-8 min) ..."
  local i; for i in $(seq 1 120); do
    ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=3 "eddie@$LAB_IP" 'cloud-init status --wait >/dev/null 2>&1; cloud-init status' 2>/dev/null | grep -q 'status: done' && break; sleep 10; done
  cmd_status "$VM"
}

cmd_status() {
  local l f; for l in "${TB_VMS[@]}"; do read -r -a f <<<"$l"; [ -n "${1:-}" ] && [ "$1" != "${f[0]}" ] && continue
    if ! dom_exists "${f[0]}"; then echo "${f[0]}  not defined"; continue; fi
    local st ssh_ok ck
    st=$("${V[@]}" domstate "${f[0]}")
    ssh_ok=$(ssh -o BatchMode=yes -o ConnectTimeout=3 "eddie@${f[4]}" 'echo ok' 2>/dev/null || echo NO)
    ck=$(curl -sk -m 3 -o /dev/null -w '%{http_code}' "https://${f[4]}:9090/" 2>/dev/null || true)
    echo "${f[0]}  $st  lab0=${f[4]} sh0=${f[5]}  ssh=$ssh_ok  cockpit=${ck:-000}"
  done
}

cmd_destroy() {
  need_vm "${1:-}"; [ "${2:-}" = "--yes-destroy-$VM" ] || die "confirm with: tb.sh destroy $VM --yes-destroy-$VM"
  root_job "adlha-destroy-$VM" 300 <<EOF
set -Eeuo pipefail
virsh dominfo $VM >/dev/null 2>&1 || { echo "gone"; exit 0; }
virsh -q destroy $VM 2>/dev/null || true
virsh -q undefine $VM --nvram --snapshots-metadata || virsh -q undefine $VM
rm -f -- $TB_IMG_DIR/$VM.qcow2 $TB_IMG_DIR/$VM-seed.iso
echo "destroyed $VM (byMachine/$VM kept)"
EOF
}

all_vms() { local l f; for l in "${TB_VMS[@]}"; do read -r -a f <<<"$l"; echo "${f[0]}"; done; }
stop_all() {
  local v; for v in $(all_vms); do [ "$("${V[@]}" domstate "$v")" = running ] && "${V[@]}" shutdown "$v" --mode agent >/dev/null; done
  for v in $(all_vms); do local i; for i in $(seq 1 90); do [ "$("${V[@]}" domstate "$v")" = "shut off" ] && break; sleep 2; done
    [ "$("${V[@]}" domstate "$v")" = "shut off" ] || die "$v did not shut down in 180 s (not forcing)"; done
}
start_all() {
  local v; for v in $(all_vms); do "${V[@]}" start "$v" >/dev/null; done
  for v in $(all_vms); do tb_vm "$v"; local i; for i in $(seq 1 60); do
    ssh -o BatchMode=yes -o ConnectTimeout=3 "eddie@$LAB_IP" true 2>/dev/null && break; sleep 3; done; done
  cmd_status
}
cmd_snapshot() {
  local name=${1:?snapshot NAME}; [[ $name =~ ^[A-Za-z0-9._-]+$ ]] || die "bad snapshot name"
  stop_all
  root_job "adlha-snapshot" 600 <<EOF
set -Eeuo pipefail
for v in $(all_vms | tr '\n' ' '); do qemu-img snapshot -c "$name" $TB_IMG_DIR/\$v.qcow2 && echo "snapshot $name: \$v"; done
EOF
  start_all
}
cmd_snapshots() { root_job "adlha-snapshots" 120 <<EOF
for v in $(all_vms | tr '\n' ' '); do echo "== \$v"; qemu-img snapshot -l $TB_IMG_DIR/\$v.qcow2 | tail -n +3; done
EOF
}
cmd_revert() {
  local name=${1:?revert NAME}; [ "${2:-}" = --yes-revert ] || die "confirm with: tb.sh revert $name --yes-revert"
  stop_all
  root_job "adlha-revert" 600 <<EOF
set -Eeuo pipefail
for v in $(all_vms | tr '\n' ' '); do qemu-img snapshot -l $TB_IMG_DIR/\$v.qcow2 | grep -qw "$name" || { echo "\$v has no snapshot $name"; exit 3; }; done
for v in $(all_vms | tr '\n' ' '); do qemu-img snapshot -a "$name" $TB_IMG_DIR/\$v.qcow2 && echo "reverted \$v to $name"; done
EOF
  start_all
}

case ${1:-} in
  net) cmd_net;; create) cmd_create "${2:-}";; status) cmd_status "${2:-}";; destroy) cmd_destroy "${2:-}" "${3:-}";;
  snapshot) cmd_snapshot "${2:-}";; snapshots) cmd_snapshots;; revert) cmd_revert "${2:-}" "${3:-}";;
  *) sed -n '2,15p' "$0"; exit 2;;
esac
