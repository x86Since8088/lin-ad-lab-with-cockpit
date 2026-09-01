#!/usr/bin/env bash
# Acceptance gate for the edy-proxy-go agent rollout: prove that every lab
# container trusts the controller CA, holds valid client-auth material, runs
# the agent, and — the end-to-end check — that the CONTROLLER has seen each
# one recently. A green run here means cert+agent+trust all work in both
# directions, not merely that files exist.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./agent.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1 ($2)"; FAIL=$((FAIL+1)); }

CA_TMP=$(mktemp); trap 'rm -f "$CA_TMP"' EXIT
fetch_ca "$CA_TMP" || { echo "FATAL: cannot fetch CA from the controller"; exit 1; }
CA_PROBE=$(sed -n '3p' "$CA_TMP")

echo "=== 1. agent binary present and executable ==="
for c in $(all_lab_containers); do
    ctr_up "$c" || { no "$c binary" "container not running"; continue; }
    podman exec "$c" test -x /usr/local/bin/edy-agent 2>/dev/null \
        && ok "$c has /usr/local/bin/edy-agent" || no "$c binary" "missing or not executable"
done

echo; echo "=== 2. controller CA is in the OS trust store ==="
for c in $(all_lab_containers); do
    ctr_up "$c" || { no "$c CA trust" "container not running"; continue; }
    if podman exec "$c" grep -qsF "$CA_PROBE" /etc/ssl/certs/ca-certificates.crt 2>/dev/null; then
        ok "$c trusts the EDY Proxy Root CA"
    else
        no "$c CA trust" "CA not in /etc/ssl/certs/ca-certificates.crt"
    fi
done

echo; echo "=== 3. client-auth certificate material ==="
for c in $(all_lab_containers); do
    ctr_up "$c" || { no "$c cert material" "container not running"; continue; }
    missing=$(podman exec "$c" bash -c \
        'for f in agent.crt agent.key ca.crt state.json; do
             [ -s "/etc/edy-agent/$f" ] || printf "%s " "$f"
         done' 2>/dev/null)
    if [[ -n "${missing// /}" ]]; then
        no "$c cert material" "missing: $missing"
        continue
    fi
    # The private key must never be group/other-readable.
    mode=$(podman exec "$c" stat -c %a /etc/edy-agent/agent.key 2>/dev/null)
    [[ "$mode" == "600" ]] && ok "$c has agent.crt/agent.key/ca.crt (key mode 600)" \
                           || no "$c key mode" "agent.key mode $mode, want 600"
done

echo; echo "=== 4. agent process is running ==="
for c in $(all_lab_containers); do
    ctr_up "$c" || { no "$c agent process" "container not running"; continue; }
    podman exec "$c" pgrep -f '/usr/local/bin/edy-agent run' >/dev/null 2>&1 \
        && ok "$c agent running" || no "$c agent process" "not running — re-run 40-agent.sh"
done

echo; echo "=== 5. the controller has seen every agent recently ==="
# This is the check that proves the client-auth cert actually WORKS: the
# agent long-polls the controller continuously, so a fresh last_seen means
# authenticated round-trips are happening right now.
_edy_admin_curl "$EDY_ADMIN_API/api/agents" > "$CA_TMP.fleet" 2>/dev/null
EXPECTED_AGENTS="$(all_lab_containers | tr '\n' ' ')"
export EXPECTED_AGENTS
while IFS=$'\t' read -r name verdict detail; do
    [[ "$verdict" == "OK" ]] && ok "$name $detail" || no "$name controller view" "$detail"
done < <(python3 - "$CA_TMP.fleet" <<'PY'
import json, sys, datetime, os
try:
    d = json.load(open(sys.argv[1]))
except Exception as e:
    print(f"fleet\tFAIL\tcould not parse /api/agents: {e}")
    sys.exit(0)
agents = d if isinstance(d, list) else d.get("agents", [])
by_host = {}
for a in agents:
    h = a.get("hostname") or ""
    by_host.setdefault(h, a)
now = datetime.datetime.now(datetime.timezone.utc)
expected = os.environ.get("EXPECTED_AGENTS", "").split()
for n in expected:
    a = by_host.get(n)
    if not a:
        print(f"{n}\tFAIL\tnot enrolled on the controller")
        continue
    if not a.get("enabled", False):
        print(f"{n}\tFAIL\tenrolled but disabled")
        continue
    ls = a.get("last_seen") or ""
    try:
        seen = datetime.datetime.fromisoformat(ls.replace("Z", "+00:00"))
        age = (now - seen).total_seconds()
    except Exception:
        print(f"{n}\tFAIL\tunparseable last_seen {ls!r}")
        continue
    if age <= 180:
        print(f"{n}\tOK\tseen {int(age)}s ago")
    else:
        print(f"{n}\tFAIL\tlast seen {int(age)}s ago (>180s — agent not polling)")
PY
)
rm -f "$CA_TMP.fleet"

echo; echo "==================== $PASS passed, $FAIL failed ===================="
[[ $FAIL -eq 0 ]]
