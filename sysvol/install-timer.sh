#!/usr/bin/env bash
# Install (or remove) the systemd timer that keeps SYSVOL replicated.
# Run as root on the host.   ./install-timer.sh [--uninstall]
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./sysvol-lib.sh
[[ $EUID -eq 0 ]] || die "must run as root"
HERE="$(pwd)"

if [[ "${1:-}" == "--uninstall" ]]; then
    systemctl disable --now sysvol-replicate.timer 2>/dev/null
    rm -f /etc/systemd/system/sysvol-replicate.{service,timer}
    systemctl daemon-reload
    log "removed"; exit 0
fi

for u in sysvol-replicate.service sysvol-replicate.timer; do
    sed "s#/opt/sc/git/samba-ad-lab/source/sysvol#$HERE#g" "$HERE/$u" \
        > "/etc/systemd/system/$u.new"
    mv -f "/etc/systemd/system/$u.new" "/etc/systemd/system/$u"
    chmod 0644 "/etc/systemd/system/$u"
done
systemctl daemon-reload
systemctl enable --now sysvol-replicate.timer
log "installed and started"
systemctl list-timers sysvol-replicate.timer --no-pager
echo
echo "  journalctl -u sysvol-replicate.service -f    # watch it run"
echo "  systemctl start sysvol-replicate.service     # force a pass now"
