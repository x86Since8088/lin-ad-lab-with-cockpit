#!/usr/bin/env bash
# Install (or remove) the systemd unit that brings the lab back after reboot.
# Run as root on the host.   ./install-start.sh [--uninstall]
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
[[ $EUID -eq 0 ]] || { echo "FATAL must run as root" >&2; exit 1; }
HERE="$(pwd)"
UNIT=samba-ad-lab.service
DROPIN_DIR=/etc/systemd/system/sysvol-replicate.service.d
DROPIN="$DROPIN_DIR/after-lab.conf"

log() { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die() { printf '%s FATAL %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
    systemctl disable --now "$UNIT" 2>/dev/null || true
    rm -f "/etc/systemd/system/$UNIT"
    rm -f "$DROPIN"
    rmdir --ignore-fail-on-non-empty -- "$DROPIN_DIR" 2>/dev/null || true
    systemctl daemon-reload
    log "removed $UNIT (containers were not stopped)"
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

# SYSVOL replication is pointless until the DCs are up. A drop-in keeps that
# ordering without rewriting the shipped sysvol-replicate.service.
install -d -m 0755 -o root -g root "$DROPIN_DIR"
cat > "$DROPIN" <<'EOF'
[Unit]
# Wait for samba-ad-lab.service when it is in the transaction (boot). If the
# lab unit is not enabled, this After= is a no-op.
After=samba-ad-lab.service
EOF
chmod 0644 "$DROPIN"

systemctl daemon-reload
systemctl enable --now "$UNIT"
log "installed and started $UNIT"
systemctl --no-pager --full status "$UNIT" || true
echo
echo "  journalctl -u $UNIT -b    # this boot"
echo "  systemctl restart $UNIT   # re-run 21-start.sh (idempotent)"
