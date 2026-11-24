#!/usr/bin/env bash
# tb-reset.sh SNAPSHOT — put the testbed back to a known state for a stress pass.
#   1. revert BOTH VMs to SNAPSHOT (tb.sh revert: graceful shutdown, never forced; never one VM alone)
#   2. install the current adlab-ha; if the snapshot predates the HA build (forest-baseline): put both sites in the
#      site link (change notification, 15 min) and force one cross-site sync + KCC, recreate the DCs
#      under agent supervision (--restart=no)
#   3. start the auth load, reset the controller's state, start the controller (detached)
# The controller and stress runs must be stopped first (the script refuses otherwise).
set -Eeuo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
RJ=/home/eddie/.claude/skills/root-job-runner/scripts/rj
SNAP=${1:?usage: tb-reset.sh SNAPSHOT}
SIM_STATE=$HOME/.local/state/adl-ha/ha-sim
if pgrep -f "python3 -u .*ha-s[i]m.py" >/dev/null || pgrep -f "run-stres[s].sh" >/dev/null; then
  echo "stop the controller and any stress run first" >&2; exit 1
fi

echo "== revert both VMs to $SNAP"
"$HERE/tb.sh" revert "$SNAP" --yes-revert

# always (re)install the CURRENT host engine: a snapshot carries the agent it was taken with
echo "== install adlab-ha"
"$HERE/tb-ha.sh" install | grep -E 'adlab-ha|active'
if [ "$SNAP" = forest-baseline ]; then
  echo "== site link (both sites, notify, 15 min) + cross-site sync"
  "$RJ" -M adl-ha-a adlha-reset-sitelink <<'EOF' | grep -v '^\[exit'
podman exec dc1 sh -c 'B="DC=ha,DC=test,DC=lab"; L="CN=DEFAULTIPSITELINK,CN=IP,CN=Inter-Site Transports,CN=Sites,CN=Configuration,$B"
printf "dn: %s\nchangetype: modify\nadd: siteList\nsiteList: CN=adl-ha-b,CN=Sites,CN=Configuration,%s\n-\nreplace: replInterval\nreplInterval: 15\n-\nreplace: options\noptions: 1\n" "$L" "$B" > /tmp/sl.ldif
ldbmodify -H /var/lib/samba/private/sam.ldb /tmp/sl.ldif 2>&1 | tail -1'
EOF
  xsite() { # DEST(local) SRC VM
    "$RJ" -t 600 -M "$3" "adlha-reset-xsite-$1" <<EOF | grep -cE 'successful' || true
for nc in "CN=Configuration,DC=ha,DC=test,DC=lab" "DC=ha,DC=test,DC=lab" "DC=DomainDnsZones,DC=ha,DC=test,DC=lab" "DC=ForestDnsZones,DC=ha,DC=test,DC=lab" "CN=Schema,CN=Configuration,DC=ha,DC=test,DC=lab"; do
  podman exec $1 sh -c "umask 077; f=\\\$(mktemp); printf 'username=Administrator\npassword=%s\ndomain=HATEST\n' \"\\\$(cat /run/adminpass)\" > \\\$f; samba-tool drs replicate $1 $2 '\$nc' --full-sync -A \\\$f 2>&1 | tail -1; rm -f \\\$f"
done
podman exec $1 sh -c "umask 077; f=\\\$(mktemp); printf 'username=Administrator\npassword=%s\ndomain=HATEST\n' \"\\\$(cat /run/adminpass)\" > \\\$f; samba-tool drs kcc $1 -A \\\$f 2>&1 | tail -1; rm -f \\\$f"
EOF
  }
  echo "   dc3<-dc1 ok NCs: $(xsite dc3 dc1 adl-ha-b)  dc1<-dc3 ok NCs: $(xsite dc1 dc3 adl-ha-a)"
  echo "== recreate DCs under agent supervision (state is bind-mounted; one at a time)"
  for pair in adl-ha-a:dc2 adl-ha-b:dc4 adl-ha-b:dc3 adl-ha-a:dc1; do
    vm=${pair%%:*}; dc=${pair#*:}
    "$RJ" -M "$vm" "adlha-reset-rm-$dc" <<<"podman rm -f -t 10 $dc >/dev/null && echo removed $dc" | grep removed
    "$HERE/tb-forest.sh" up 2>&1 | grep -E "^== $dc|starting samba" | head -2
  done
fi

echo "== auth load"
"$HERE/tb-load.sh" start >/dev/null 2>&1 && echo loadgen started
echo "== controller: fresh state, detached"
rm -rf "$SIM_STATE"; mkdir -p "$SIM_STATE"
# the WHOLE subshell gets the log as stdout/stderr and execs the controller: with only the python
# command redirected, the backgrounded `cd && setsid …` list kept this script's stdout open, so a
# caller piping tb-reset.sh (… | grep) never saw EOF (2026-11-19: the S1 sample after it never ran)
( cd "$HERE" && exec setsid python3 -u ha-sim.py run --timers stress ) >>"$SIM_STATE/controller.log" 2>&1 < /dev/null &
for i in $(seq 1 60); do
  python3 -c 'import json,sys; sys.exit(0 if json.load(open(sys.argv[1]))["mode"]=="healthy" else 1)' "$SIM_STATE/state.json" 2>/dev/null && break
  sleep 5
done
python3 "$HERE/drills.py" check | python3 -c 'import json,sys; s=json.load(sys.stdin); print(s["mode"], s["holder"], "epoch", s["epoch"]); [print(" ", k, v["state"], v["roles"], "fails", v["fails"], "sv", v["sv"]) for k, v in sorted(s["dcs"].items())]'
