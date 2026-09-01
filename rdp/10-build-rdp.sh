#!/usr/bin/env bash
# Build the RDP target image and generate the two lab credentials it needs.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./rdp.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

echo "== credentials =="
gen_pass "$LOCAL_PASS_FILE"  || true
gen_pass "$DOMAIN_PASS_FILE" || true
ls -l "$LOCAL_PASS_FILE" "$DOMAIN_PASS_FILE" | sed 's/^/  /'

echo "== building $IMG_RDP =="
# Build context is source/ so the Containerfile can COPY edy-domain-install.sh,
# exactly as Containerfile.client does.
podman build -f "$RDP_DIR/Containerfile.rdp" -t "$IMG_RDP" "$RDP_DIR/.."
podman images --format '  {{.Repository}}:{{.Tag}} {{.Size}}' | grep ad-rdp
