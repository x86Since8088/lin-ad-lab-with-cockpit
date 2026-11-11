#!/usr/bin/env bash
# tb-plugins.sh VM [plugin ...] — install the cockpit plugins edt1 RUNS (its deployed
# /opt/cockpit-*/payload-<ver>, exactly those versions) into a testbed VM.
#   default plugin set: every /opt/cockpit-* on edt1 (adlab, guac-rdp, headscale, secrets,
#   tuner, wireguard). Payloads only: each plugin's .env (secrets, host config) stays on
#   edt1; the VM gets a fresh .env seeded from the payload's .envdefault (missing-only).
#   Same layout as a deploy.sh install: /opt/cockpit-X/payload-<ver>, payload -> it, then the
#   payload's own install.sh. install.sh never enables or starts a unit, so no plugin
#   service runs in the VM until someone starts it deliberately.
# Host side via rj (root on edt1), VM side via rj -M VM (the VM's root runner).
set -Eeuo pipefail
HERE=$(cd "$(dirname "$(readlink -f "$0")")" && pwd)
. "$HERE/testbed.env"
RJ=/home/eddie/.claude/skills/root-job-runner/scripts/rj
VMQ=${1:?usage: tb-plugins.sh VM [plugin ...]}; shift
tb_vm "$VMQ" || { echo "unknown testbed VM $VMQ" >&2; exit 2; }
WANT="${*:-}"
STAGE=/srv/jobs/byMachine/$VM/app/plugins

echo "== stage edt1's deployed payloads -> $STAGE"
"$RJ" -t 600 "adlha-plugins-stage-$VM" <<EOF
set -Eeuo pipefail
install -d -m 2770 -o libvirt-qemu -g users "$STAGE"
rm -f "$STAGE"/*.tgz
for d in /opt/cockpit-*; do
  n=\$(basename "\$d"); [ -L "\$d/payload" ] || continue
  if [ -n "$WANT" ]; then case " $WANT " in *" \${n#cockpit-} "*|*" \$n "*) ;; *) continue;; esac; fi
  p=\$(readlink -f "\$d/payload"); v=\$(basename "\$p")
  tar -C "\$(dirname "\$p")" -czf "$STAGE/\$n--\$v.tgz" "\$v"
  echo "staged \$n \$v (\$(du -h "$STAGE/\$n--\$v.tgz" | cut -f1))"
done
chown -R libvirt-qemu:users "$STAGE"
EOF

echo "== install in $VM"
"$RJ" -t 900 -M "$VM" "adlha-plugins-install" <<'EOF'
set -Euo pipefail
S=/srv/jobs/app/plugins
rc_all=0
# guac-rdp's install.sh refuses without its relay account (its deploy.sh --with-users creates it);
# in a throwaway testbed VM creating the system account is harmless and starts nothing
if ls "$S"/cockpit-guac-rdp--*.tgz >/dev/null 2>&1; then
  getent group cockpit-guac-rdp >/dev/null || groupadd --system cockpit-guac-rdp
  id edy-relay >/dev/null 2>&1 || useradd --system --no-create-home --shell /usr/sbin/nologin -g cockpit-guac-rdp edy-relay
fi
for t in "$S"/*.tgz; do
  b=$(basename "$t" .tgz); n=${b%%--*}; v=${b#*--}
  base=/opt/$n
  install -d -m 0755 "$base"
  rm -rf "$base/$v.new"; mkdir "$base/$v.new"
  tar -C "$base/$v.new" -xzf "$t" && rm -rf "$base/$v" && mv "$base/$v.new/$v" "$base/$v" && rmdir "$base/$v.new"
  ln -sfn "$v" "$base/payload.new" && mv -T "$base/payload.new" "$base/payload"
  [ -f "$base/.env" ] || { [ -f "$base/payload/.envdefault" ] && install -m 0600 "$base/payload/.envdefault" "$base/.env"; }
  if out=$("$base/payload/install.sh" 2>&1); then echo "ok   $n $v"
  else rc_all=1; echo "FAIL $n $v:"; printf '%s\n' "$out" | tail -6 | sed 's/^/       /'; fi
done
systemctl is-active cockpit.socket >/dev/null && echo "cockpit.socket active"
ls /usr/share/cockpit | tr '\n' ' '; echo
exit $rc_all
EOF
