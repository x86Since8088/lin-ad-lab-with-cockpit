#!/usr/bin/env bash
# tb-forest.sh — the testbed's own AD forest HA.TEST.LAB (design §10). Never AD.EDT1.LAB.
#   tb-forest.sh build [VM]   build localhost/samba-ad-dc:latest INSIDE the VM(s) from this repo's
#                             Containerfile.dc + dc-entrypoint.sh + dc-chrony.conf (same image as the lab)
#   tb-forest.sh up           dc1 (A, provisions) + dc2 (A) + dc3/dc4 (B) on the shared subnet,
#                             one AD site per VM; idempotent (existing DCs are left alone)
#   tb-forest.sh status       per DC: container, site, replication failures; fsmo; SID
# Layout: DCs are podman macvlan containers on sh0 (net adl-dc; A .16/28, B .32/28), state bind-
# mounted under /opt/adl-forest/state/dcN (like the lab's /opt/sc/lab-state), --init, hostname dcN.
# Sites: A = Default-First-Site-Name (subnet 10.31.0.16/28), B = adl-ha-b (10.31.0.32/28).
# Time: each DC's chrony serves signed NTP from the OTHER VM's chrony (a macvlan child cannot reach
# its own host). The admin password is generated root-only in A and reaches B via the shares.
set -Eeuo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
REPO=$(dirname "$HERE")
. "$HERE/testbed.env"
RJ=/home/eddie/.claude/skills/root-job-runner/scripts/rj
REALM=HA.TEST.LAB; DOMAIN_NB=HATEST; IMG=localhost/samba-ad-dc:latest
FORWARDER=10.31.0.11            # the testbed's own edy DNS (A); never edt1's
SITE_A=Default-First-Site-Name; SITE_B=adl-ha-b
# name vm ip role site
DCS=("dc1 adl-ha-a 10.31.0.17 provision $SITE_A"
     "dc2 adl-ha-a 10.31.0.18 join $SITE_A"
     "dc3 adl-ha-b 10.31.0.33 join $SITE_B"
     "dc4 adl-ha-b 10.31.0.34 join $SITE_B")
die() { echo "tb-forest: $*" >&2; exit 1; }

cmd_build() {
  local vms=("${1:-adl-ha-a}"); [ -z "${1:-}" ] && vms=(adl-ha-a adl-ha-b)
  local vm
  for vm in "${vms[@]}"; do
    local D=/srv/jobs/byMachine/$vm/app/forest; mkdir -p "$D"
    tar -C "$REPO" -czf "$D/ctx.tgz" Containerfile.dc dc-entrypoint.sh dc-chrony.conf edy-domain-install.sh
    echo "== build $IMG in $vm"
    "$RJ" -t 1800 -M "$vm" "adlha-forest-build" <<EOF
set -Eeuo pipefail
rm -rf /opt/adl-forest/ctx; mkdir -p /opt/adl-forest/ctx
tar -C /opt/adl-forest/ctx -xzf /srv/jobs/app/forest/ctx.tgz
cd /opt/adl-forest/ctx && podman build -q -f Containerfile.dc -t $IMG . | tail -1
# the VM's chrony serves the DCs on the shared subnet (they sync from the other VM)
echo 'allow 10.31.0.0/24' > /etc/chrony/conf.d/60-adl-ha.conf
# cloud-init's ntp module writes chrony.conf WITHOUT the conf.d include
grep -q '^confdir /etc/chrony/conf.d' /etc/chrony/chrony.conf || echo 'confdir /etc/chrony/conf.d' >> /etc/chrony/chrony.conf
systemctl restart chrony
podman image exists $IMG && echo "image ok"
EOF
  done
}

cmd_up() {
  local SA=/srv/jobs/byMachine/adl-ha-a/secrets SB=/srv/jobs/byMachine/adl-ha-b/secrets
  local l f
  for l in "${DCS[@]}"; do read -r -a f <<<"$l"
    local n=${f[0]} vm=${f[1]} ip=${f[2]} role=${f[3]} site=${f[4]}
    # the admin password: generated on A once; handed to B through the shares when B first needs it
    if [ "$vm" = adl-ha-b ]; then
      "$RJ" -M adl-ha-b adlha-forest-haspass <<<'[ -s /opt/adl-forest/secrets/administrator.pass ] && echo have || echo need' | grep -q '^have' || {
        "$RJ" -M adl-ha-a adlha-forest-passout <<<'(umask 007; cat /opt/adl-forest/secrets/administrator.pass > /srv/jobs/secrets/administrator.pass); echo ok' >/dev/null
        install -m 0660 "$SA/administrator.pass" "$SB/administrator.pass"; rm -f "$SA/administrator.pass"; }
    fi
    local peer=10.31.0.17 other_vm_ip=10.31.0.12; [ "$vm" = adl-ha-b ] && other_vm_ip=10.31.0.11
    echo "== $n ($role) on $vm $ip site $site"
    "$RJ" -t 1200 -M "$vm" "adlha-forest-$n" <<EOF
set -Eeuo pipefail
N=$n; IP=$ip; ROLE=$role; SITE="$site"; PEER=$peer; OTHER=$other_vm_ip
install -d -m 0700 /opt/adl-forest/secrets
if [ ! -s /opt/adl-forest/secrets/administrator.pass ]; then
  if [ -s /srv/jobs/secrets/administrator.pass ]; then install -m 0600 /srv/jobs/secrets/administrator.pass /opt/adl-forest/secrets/administrator.pass; rm -f /srv/jobs/secrets/administrator.pass
  else python3 -c "import secrets,string; a=string.ascii_letters+string.digits; print(''.join(secrets.choice(a) for _ in range(24))+'!aA1', end='')" > /opt/adl-forest/secrets/administrator.pass; chmod 0600 /opt/adl-forest/secrets/administrator.pass; fi
fi
if podman container exists \$N; then echo "\$N exists (\$(podman inspect -f '{{.State.Status}}' \$N)); left alone"; exit 0; fi
S=/opt/adl-forest/state/\$N; install -d -m 0755 \$S/var-lib-samba \$S/etc-samba
# chrony for this DC: upstream = the OTHER VM (own host is unreachable from a macvlan child)
cat > \$S/chrony.conf <<CH
server \$OTHER iburst
server 10.31.0.11 iburst
server 10.31.0.12 iburst
local stratum 10
ntpsigndsocket /var/lib/samba/ntp_signd/socket
allow 10.31.0.0/24
driftfile /var/lib/chrony/adlab-dc.drift
CH
env=(-e ROLE=\$ROLE -e REALM=$REALM -e DOMAIN_NB=$DOMAIN_NB -e DC_IP=\$IP -e FORWARDER=$FORWARDER -e ADMIN_PASS_FILE=/run/adminpass)
[ "\$ROLE" = join ] && env+=(-e PEER_IP=\$PEER -e "SITE=\$SITE")
# same privileges as the lab's DCs (20-up.sh): SYSVOL NT ACLs are security.* xattrs (SYS_ADMIN)
podman run -d --init --name \$N --hostname \$N --network adl-dc --ip \$IP --restart=always \
  --cap-add SYS_ADMIN,NET_ADMIN,SYS_TIME --security-opt seccomp=unconfined \
  --label adl-ha.role=dc --label adl-ha.forest=$REALM \
  -v /opt/adl-forest/secrets/administrator.pass:/run/adminpass:ro \
  -v \$S/var-lib-samba:/var/lib/samba -v \$S/etc-samba:/etc/samba \
  -v \$S/chrony.conf:/etc/chrony/adlab-dc.conf:ro \
  "\${env[@]}" $IMG >/dev/null
systemctl enable podman-restart.service >/dev/null 2>&1 || true
for i in \$(seq 1 120); do
  podman logs \$N 2>&1 | grep -q 'starting samba' && podman exec \$N sh -c 'ss -ltn | grep -q ":389 "' 2>/dev/null && break
  podman inspect -f '{{.State.Running}}' \$N | grep -q true || { echo "\$N exited:"; podman logs --tail 20 \$N 2>&1 | cut -c1-200; exit 1; }
  sleep 3; done
podman logs \$N 2>&1 | grep 'dc-entrypoint' | tail -4
if [ "\$ROLE" = provision ]; then
  # sites: A keeps Default-First-Site-Name; B gets adl-ha-b; subnets map the per-VM /28s
  podman exec \$N sh -c 'samba-tool sites create $SITE_B >/dev/null 2>&1 || true
    samba-tool sites subnet create 10.31.0.16/28 $SITE_A >/dev/null 2>&1 || true
    samba-tool sites subnet create 10.31.0.32/28 $SITE_B >/dev/null 2>&1 || true
    samba-tool sites list'
fi
EOF
  done
}

cmd_status() {
  "$RJ" -M adl-ha-a adlha-forest-status <<'EOF' | grep -v '^\[exit'
podman exec dc1 sh -c 'samba-tool fsmo show 2>/dev/null | sed "s/,CN=Servers.*//; s/owner: CN=NTDS Settings,CN=/-> /"; echo; samba-tool domain info 127.0.0.1 2>/dev/null | grep -E "Forest|Domain|DC name|Server site"'
for n in dc1 dc2; do podman exec $n sh -c "echo == $n; samba-tool drs showrepl --summary 2>&1 | tail -2" 2>/dev/null; done
EOF
  "$RJ" -M adl-ha-b adlha-forest-status-b <<'EOF' | grep -v '^\[exit'
for n in dc3 dc4; do podman exec $n sh -c "echo == $n; samba-tool drs showrepl --summary 2>&1 | tail -2; samba-tool domain info 127.0.0.1 2>/dev/null | grep 'Server site'" 2>/dev/null; done
EOF
}

case ${1:-} in
  build) cmd_build "${2:-}";; up) cmd_up;; status) cmd_status;;
  *) sed -n '2,13p' "$0"; exit 2;;
esac
