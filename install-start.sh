#!/usr/bin/env bash
# Install (or remove) the systemd units that bring the lab back after reboot:
# samba-ad-lab.timer fires samba-ad-lab.service 45 s after boot, and a drop-in
# bounds the service's restarts. Run as root on the host.
#   ./install-start.sh [--uninstall]
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[[ $EUID -eq 0 ]] || { echo "FATAL must run as root" >&2; exit 1; }
HERE="$(pwd)"
UNIT=samba-ad-lab.service
TIMER=samba-ad-lab.timer
UNIT_DROPIN_DIR="/etc/systemd/system/$UNIT.d"
UNIT_DROPIN="$UNIT_DROPIN_DIR/10-bounded-restart.conf"
DROPIN_DIR=/etc/systemd/system/sysvol-replicate.service.d
DROPIN="$DROPIN_DIR/after-lab.conf"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '%s FATAL %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
    systemctl disable --now "$TIMER" 2>/dev/null || true
    systemctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "/etc/systemd/system/$TIMER" "/etc/systemd/system/$UNIT" "$UNIT_DROPIN" "$DROPIN"
    rmdir --ignore-fail-on-non-empty -- "$UNIT_DROPIN_DIR" "$DROPIN_DIR" 2>/dev/null || true
    systemctl daemon-reload
    log "removed $TIMER, $UNIT and their drop-ins (containers were not stopped)"
    exit 0
fi

# /etc/systemd/system wins over /usr/local/lib/systemd/system, where install.sh
# puts PACKAGED units. A development unit on top of a packaged one is /etc
# silently winning, so the next install.sh upgrade appears to do nothing.
PKG_UNITDIR=/usr/local/lib/systemd/system
if [[ -e "$PKG_UNITDIR/$UNIT" ]]; then
    die "this host already has the PACKAGED unit
    $PKG_UNITDIR/$UNIT. A development unit in /etc/systemd/system would silently
    win over it. Run './install.sh --uninstall' first if you really want to run
    the unit from this checkout."
fi

[[ -x "$HERE/21-start.sh" ]] || die "$HERE/21-start.sh is missing or not executable"
for f in "$TIMER" "$UNIT.d/10-bounded-restart.conf"; do
    [[ -s "$HERE/$f" ]] || die "$HERE/$f is missing; nothing installed"
done

tmp="$(mktemp)"
sed "s#@LAB_DIR@#$HERE#g" "$HERE/$UNIT" > "$tmp"
if grep -q '@[A-Z_]*@' "$tmp"; then
    grep -n '@[A-Z_]*@' "$tmp" >&2
    rm -f "$tmp"
    die "$UNIT still contains an unsubstituted placeholder (above); nothing installed"
fi
if grep -qE '/opt/sc/git' "$tmp"; then
    rm -f "$tmp"
    die "$UNIT names a retired development root; nothing installed"
fi
install -m 0644 -o root -g root "$tmp" "/etc/systemd/system/$UNIT"
rm -f "$tmp"

# Bounded restart. The unit's Restart=on-failure + RestartSec=15 outlasts the
# default 10 s start-limit window, so one persistent 21-start.sh failure
# restarted it 275 times on 2026-10-04. A drop-in keeps the unit itself as the
# documented recovery path and lets the limits be rolled back on their own.
install -d -m 0755 -o root -g root "$UNIT_DROPIN_DIR"
install -m 0644 -o root -g root "$HERE/$UNIT.d/10-bounded-restart.conf" "$UNIT_DROPIN"

# The timer starts the service, not multi-user.target. A unit WantedBy=
# multi-user.target is implicitly ordered before it, so the ~75 s lab start
# gated multi-user.target and everything After= it (on edt1 power-profiles-
# daemon, whose D-Bus activation then timed out in gnome-shell). The timer runs
# the same unit 45 s after boot, outside that transaction.
install -m 0644 -o root -g root "$HERE/$TIMER" "/etc/systemd/system/$TIMER"

# SYSVOL replication is pointless until the DCs are up. A drop-in keeps that
# ordering without rewriting the shipped sysvol-replicate.service.
install -d -m 0755 -o root -g root "$DROPIN_DIR"
cat > "$DROPIN" <<'EOF'
[Unit]
# Wait for samba-ad-lab.service while its start job is queued or running (the
# lab timer fires it 45 s after boot, sysvol-replicate.timer fires 3 min after
# boot). When the lab unit has no job queued this After= is a no-op.
After=samba-ad-lab.service
EOF
chmod 0644 "$DROPIN"

systemctl daemon-reload

# Migrate a host that still has the service enabled into multi-user.target.
if systemctl is-enabled --quiet "$UNIT" 2>/dev/null; then
    systemctl disable "$UNIT"
    log "disabled $UNIT (was WantedBy=multi-user.target; $TIMER starts it now)"
fi
# Enable only; never start or restart the service from here. It is a oneshot
# with RemainAfterExit — already active (exited) on a running lab — and on a
# new host the lab is built by 20-up.sh. The timer arms itself on the next boot.
systemctl enable "$TIMER"
if systemctl show multi-user.target -p After --value | grep -qF "$UNIT"; then
    log "WARN multi-user.target still waits for $UNIT; find the other enablement: systemctl show $UNIT -p WantedBy"
else
    log "multi-user.target no longer waits for $UNIT"
fi
log "installed $UNIT, $UNIT_DROPIN, $TIMER; $TIMER enabled (fires $(sed -n 's/^OnBootSec=//p' "$HERE/$TIMER") after boot)"
systemctl --no-pager --full status "$UNIT" || true
echo
echo "  systemctl list-timers $TIMER   # when it fires (next boot)"
echo "  journalctl -u $UNIT -b         # this boot"
echo "  systemctl start $UNIT          # run 21-start.sh now (idempotent)"
