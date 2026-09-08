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

# /etc/systemd/system wins over /usr/local/lib/systemd/system, where ../install.sh
# puts the PACKAGED units. Installing a development unit on top of a packaged one
# is not a duplicate; it is /etc silently winning, so the next `../install.sh`
# upgrade appears to do nothing. Refuse rather than shadow.
PKG_UNITDIR=/usr/local/lib/systemd/system
for u in sysvol-replicate.service sysvol-replicate.timer; do
    [[ -e "$PKG_UNITDIR/$u" ]] && die "this host already has the PACKAGED unit
    $PKG_UNITDIR/$u. A development unit in /etc/systemd/system would silently win
    over it. Run '../install.sh --uninstall' first if you really want to run the
    units from this checkout."
done

# @SYSVOL_DIR@ -> this checkout. A placeholder, never a literal old path:
# substituting one absolute path for another no-ops silently the moment the
# committed unit is edited, and leaves a working-looking unit that names a
# directory nothing has used in months. An unsubstituted placeholder, by
# contrast, cannot be missed -- the guard below refuses it.
for u in sysvol-replicate.service sysvol-replicate.timer; do
    sed "s#@SYSVOL_DIR@#$HERE#g" "$HERE/$u" > "/etc/systemd/system/$u.new"
    if grep -q '@[A-Z_]*@' "/etc/systemd/system/$u.new"; then
        grep -n '@[A-Z_]*@' "/etc/systemd/system/$u.new" >&2
        rm -f "/etc/systemd/system/$u.new"
        die "$u still contains an unsubstituted placeholder (above); nothing installed"
    fi
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
