#!/usr/bin/env bash
# tb-load.sh — authentication load for the stress program (design §12, "S1 auth load").
#   tb-load.sh start [VM]   client container `loadgen` on VM's DC macvlan (B: 10.31.0.46, A: 10.31.0.30)
#                           looping once a second over all four DCs: authenticated LDAP search
#                           (ldbsearch, NTLM) + Kerberos AS (kinit) against that DC as KDC.
#                           Log: /var/log/adl-load/auth.log in the VM: "<epoch> <dc> <ldap|krb> <ok|fail> <ms>"
#   tb-load.sh stop [VM]
#   tb-load.sh report FROM TO [VM]   per DC/kind: requests, failures, p50/p99 ms in [FROM,TO] (unix s)
set -Eeuo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
RJ=/home/eddie/.claude/skills/root-job-runner/scripts/rj
VM=${2:-adl-ha-b}; IP=10.31.0.46; [ "$VM" = adl-ha-a ] && IP=10.31.0.30

case ${1:-} in
start)
  "$RJ" -M "$VM" adlha-load-start <<EOF
set -Eeuo pipefail
mkdir -p /var/log/adl-load
podman rm -f -t 2 loadgen >/dev/null 2>&1 || true
cat > /var/log/adl-load/loop.sh <<'L'
#!/bin/bash
PW=\$(cat /run/adminpass)
DCS="dc1=10.31.0.17 dc2=10.31.0.18 dc3=10.31.0.33 dc4=10.31.0.34"
mkdir -p /etc/krb5.d
while true; do
  for x in \$DCS; do n=\${x%%=*}; ip=\${x#*=}
    t0=\$(date +%s%N)
    if timeout 5 ldbsearch -H ldap://\$ip -U "HATEST\\\\Administrator%\$PW" -b DC=ha,DC=test,DC=lab -s base dn >/dev/null 2>&1; then r=ok; else r=fail; fi
    echo "\$(date +%s) \$n ldap \$r \$(( (\$(date +%s%N)-t0)/1000000 ))" >> /log/auth.log
    printf '[libdefaults]\n default_realm = HA.TEST.LAB\n dns_lookup_kdc = false\n rdns = false\n[realms]\n HA.TEST.LAB = { kdc = %s }\n' \$ip > /tmp/krb5-\$n.conf
    t0=\$(date +%s%N)
    # Kerberos end to end: AS + TGS for ldap/<dc> from THIS DC as KDC (samba client; MIT kinit needs a tty)
    if KRB5_CONFIG=/tmp/krb5-\$n.conf timeout 5 ldbsearch -H ldap://\$n.ha.test.lab --use-kerberos=required -U "Administrator@HA.TEST.LAB%\$PW" -b DC=ha,DC=test,DC=lab -s base dn >/dev/null 2>&1; then r=ok; else r=fail; fi
    echo "\$(date +%s) \$n krb \$r \$(( (\$(date +%s%N)-t0)/1000000 ))" >> /log/auth.log
  done
  sleep 1
done
L
chmod 0755 /var/log/adl-load/loop.sh
podman run -d --name loadgen --network adl-dc --ip $IP --restart=always --label adl-ha.role=load \
  --add-host dc1.ha.test.lab:10.31.0.17 --add-host dc2.ha.test.lab:10.31.0.18 \
  --add-host dc3.ha.test.lab:10.31.0.33 --add-host dc4.ha.test.lab:10.31.0.34 \
  -v /opt/adl-forest/secrets/administrator.pass:/run/adminpass:ro -v /var/log/adl-load:/log \
  --entrypoint /log/loop.sh localhost/samba-ad-dc:latest >/dev/null
sleep 8; tail -8 /var/log/adl-load/auth.log
EOF
  ;;
stop)
  "$RJ" -M "$VM" adlha-load-stop <<<'podman rm -f -t 2 loadgen >/dev/null 2>&1; echo stopped'
  ;;
report)
  FROM=${2:?FROM}; TO=${3:?TO}; VM=${4:-adl-ha-b}
  "$RJ" -M "$VM" adlha-load-report <<EOF | grep -v '^\[exit'
awk -v f=$FROM -v t=$TO '\$1>=f && \$1<=t {k=\$2" "\$3; n[k]++; if(\$4!="ok")e[k]++; print k, \$5 > "/tmp/lat"} END{for(k in n) printf "%s req=%d fail=%d\n", k, n[k], e[k]+0}' /var/log/adl-load/auth.log | sort
for k in \$(awk '{print \$1"_"\$2}' /tmp/lat 2>/dev/null | sort -u); do
  sort -n -k3 <(awk -v k="\${k/_/ }" '\$1" "\$2==k{print \$0}' /tmp/lat) | awk -v k=\$k '{a[NR]=\$3} END{if(NR) printf "%s p50=%dms p99=%dms\n", k, a[int(NR*0.5)+1], a[int(NR*0.99)>0?int(NR*0.99):1]}'
done
EOF
  ;;
*) sed -n '2,9p' "$0"; exit 2;;
esac
