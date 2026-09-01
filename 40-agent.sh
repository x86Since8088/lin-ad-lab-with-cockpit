#!/usr/bin/env bash
# Install the edy-proxy-go trust anchor, endpoint agent, and a client-auth
# certificate onto EVERY lab container (DCs, clients, RDP targets).
#
# Three artifacts, all sourced from the controller on this host:
#   CA     -> /usr/local/share/ca-certificates/edy-proxy-ca.crt
#             (+ update-ca-certificates; the exact anchor `edy-agent catrust`
#             manages, so its uninstall stays usable)
#   agent  -> /usr/local/bin/edy-agent, copied from the controller's own
#             release staging dir — the same bytes self-update serves
#   cert   -> enrollment: a 4096-bit key is generated INSIDE the container and
#             never leaves it; the controller signs the CSR (profile
#             `machine`: ClientAuth+ServerAuth, 1 year) into
#             /etc/edy-agent/agent.crt. The agent then authenticates with
#             mTLS + Bearer on every request.
#
# Idempotent by design — every step checks before acting — because the
# containers have neither systemd nor persistent volumes: a container RESTART
# keeps the overlay (the image entrypoints re-start an enrolled agent), but a
# RECREATE (20-up.sh) starts from the image, so re-run this script after any
# 20-up.sh. Identity survives recreation anyway: each container's GUID is
# pinned in agent-guids.txt and passed as --proposed-guid, so a rebuilt
# container re-enrolls as the SAME fleet entry.
#
# Enrollment pins the controller's TLS leaf fingerprint (queried live) rather
# than passing --insecure: --insecure would also silently disable
# self-update. Tokens are single-use, 1h TTL, minted per container, and
# travel only on stdin — never argv, never a log line (job-runner output.log
# is group-readable).
#
# --manage-dns=false is LOAD-BEARING: the agent's default prepends the
# controller as a DNS server on the routing interface, which inside this lab
# would put a non-AD resolver ahead of the DCs and break domain SRV
# resolution in exactly the way 30-verify.sh exists to catch.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./agent.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

CA_TMP=$(mktemp)
trap 'rm -f "$CA_TMP"' EXIT
fetch_ca "$CA_TMP" || { echo "FATAL: could not fetch CA from $EDY_ADMIN_API/api/ca"; exit 1; }
# One distinctive base64 line is enough to test bundle membership without
# needing openssl inside the containers.
CA_PROBE=$(sed -n '3p' "$CA_TMP")
FP=$(server_fp)
[[ -n "$FP" ]] || { echo "FATAL: could not read current_fingerprint from /api/cert-pinning"; exit 1; }
[[ -x "$EDY_AGENT_BIN" ]] || { echo "FATAL: $EDY_AGENT_BIN missing"; exit 1; }

echo "== phase 1: ca-certificates package (parallel — apt is the slow step) =="
# The ubuntu base images ship WITHOUT ca-certificates, and the containers'
# resolvers are the DCs (no forwarder for the archive), so: point
# /etc/resolv.conf at the forwarder for the fetch and restore it after.
# resolv.conf is a bind mount — write in place; `mv` fails with EBUSY.
pids=(); pnames=()
for c in $(all_lab_containers); do
    ctr_up "$c" || { echo "  $c is not running; skipping"; continue; }
    podman exec "$c" bash -c 'command -v update-ca-certificates >/dev/null 2>&1' && continue
    podman exec "$c" bash -c "
        cp /etc/resolv.conf /tmp/resolv.keep
        printf 'nameserver %s\n' '$FORWARDER' > /etc/resolv.conf
        DEBIAN_FRONTEND=noninteractive apt-get update -qq \
          && apt-get install -y -qq --no-install-recommends ca-certificates
        rc=\$?
        cat /tmp/resolv.keep > /etc/resolv.conf; rm -f /tmp/resolv.keep
        exit \$rc" >/dev/null 2>&1 &
    pids+=($!); pnames+=("$c")
done
apt_fail=0
for i in "${!pids[@]}"; do
    if wait "${pids[$i]}"; then echo "  ${pnames[$i]}: ca-certificates installed"
    else echo "  ${pnames[$i]}: ca-certificates INSTALL FAILED"; apt_fail=1; fi
done
[[ ${#pids[@]} -eq 0 ]] && echo "  all containers already have it"

echo "== phase 2: binary, anchor, enrollment, start =="
overall=0
for c in $(all_lab_containers); do
    ctr_up "$c" || { echo "== $c: NOT RUNNING — skipped"; overall=1; continue; }
    echo "== $c =="

    # 1. agent binary. Install only if absent: a present binary may already
    #    have SELF-UPDATED past the staged version, and re-copying would
    #    downgrade it just for the updater to bounce it back.
    if podman exec "$c" test -x /usr/local/bin/edy-agent 2>/dev/null; then
        echo "  agent binary present"
    else
        podman cp "$EDY_AGENT_BIN" "$c:/usr/local/bin/edy-agent"
        podman exec "$c" chmod 0755 /usr/local/bin/edy-agent
        echo "  agent binary installed"
    fi

    # 2. CA anchor. Membership test against the generated bundle, so a
    #    placed-but-never-compiled anchor still gets fixed.
    if podman exec "$c" grep -qsF "$CA_PROBE" /etc/ssl/certs/ca-certificates.crt 2>/dev/null; then
        echo "  CA already trusted"
    else
        podman cp "$CA_TMP" "$c:$EDY_CA_ANCHOR"
        if podman exec "$c" update-ca-certificates >/dev/null 2>&1; then
            echo "  CA anchored ($EDY_CA_ANCHOR)"
        else
            echo "  CA ANCHOR FAILED (is ca-certificates installed?)"; overall=1
        fi
    fi

    # 3. enroll -> client-auth certificate. state.json is written only on
    #    success, so its presence is the "already enrolled" marker.
    if podman exec "$c" test -s /etc/edy-agent/state.json 2>/dev/null; then
        echo "  already enrolled"
    else
        g=$(agent_guid "$c")
        tok=$(mint_token) || { echo "  TOKEN MINT FAILED"; overall=1; continue; }
        # Token via stdin -> container env; never on either side's argv.
        if out=$(printf '%s\n' "$tok" | podman exec -i "$c" bash -c '
                IFS= read -r EDY_AGENT_INVITATION_TOKEN
                export EDY_AGENT_INVITATION_TOKEN
                exec /usr/local/bin/edy-agent enroll \
                    --server "'"$EDY_SERVER_URL"'" \
                    --ca-fingerprint "'"$FP"'" \
                    --hostname "'"$c"'" \
                    --proposed-guid "'"$g"'" \
                    --domain "'"$DOMAIN_DNS"'"' 2>&1); then
            echo "  enrolled as $g (client cert in /etc/edy-agent/agent.crt)"
        else
            echo "  ENROLL FAILED:"; echo "$out" | sed 's/^/    /' | head -8; overall=1; continue
        fi
    fi

    # 4. run the agent. No systemd in these containers; a detached exec
    #    session is the supervisor-free shape, and restart-mode defaults to
    #    `exec` so self-update replaces the process in place.
    if podman exec "$c" pgrep -f '/usr/local/bin/edy-agent run' >/dev/null 2>&1; then
        echo "  agent already running"
    else
        # -d prints the exec-session id; silence it.
        podman exec -d "$c" bash -c \
            'exec /usr/local/bin/edy-agent run --manage-dns=false >>/var/log/edy-agent.log 2>&1' >/dev/null
        echo "  agent started (log: /var/log/edy-agent.log in-container)"
    fi
done

[[ $apt_fail -eq 0 && $overall -eq 0 ]] || { echo; echo "COMPLETED WITH FAILURES — re-run after fixing; every step is idempotent"; exit 1; }
echo; echo "all containers done. run ./45-agent-verify.sh"
