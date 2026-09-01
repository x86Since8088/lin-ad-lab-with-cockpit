#!/usr/bin/env bash
# Install the AD Lab Cockpit plugin + its root verb helper.
#
#   sudo ./install.sh                # /usr/share/cockpit/adlab + /usr/local/sbin/adlab-admin
#   sudo ./install.sh --uninstall    # remove both
#
# Pre-flights the payload (JSON validity, python syntax, unit tests) before
# touching the system. Cockpit picks the package up on the next page load —
# a hard reload (Ctrl-Shift-R) clears the cached manifest list; restarting
# cockpit.service is not required.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
NAME=adlab
TARGET="${DESTDIR:-}/usr/share/cockpit/$NAME"
HELPER_DST="${DESTDIR:-}/usr/local/sbin/adlab-admin"
PAYLOAD=(manifest.json index.html adlab.js adlab.css)

[[ $EUID -eq 0 ]] || { echo "run as root (via the job runner)"; exit 1; }

if [[ "${1:-}" == "--uninstall" ]]; then
    rm -rf "$TARGET"
    rm -f "$HELPER_DST"
    echo "removed $TARGET and $HELPER_DST"
    exit 0
fi

# pre-flight
python3 -c 'import json,sys; json.load(open("manifest.json"))' \
    || { echo "manifest.json is not valid JSON"; exit 1; }
python3 -m py_compile adlab-admin || { echo "adlab-admin does not compile"; exit 1; }
python3 -m unittest discover -s tests -q 2>&1 | tail -2 \
    || { echo "unit tests failed — refusing to install"; exit 1; }

install -d -m 0755 "$TARGET"
for f in "${PAYLOAD[@]}"; do
    install -m 0644 "$f" "$TARGET/$f"
done
install -m 0755 -o root -g root adlab-admin "$HELPER_DST"
touch /var/log/adlab-admin.log && chmod 0600 /var/log/adlab-admin.log

echo "installed: $TARGET (plugin), $HELPER_DST (helper)"
echo "Cockpit picks it up on the next page load (Ctrl-Shift-R for the menu)."
