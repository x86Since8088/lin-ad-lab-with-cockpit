#!/usr/bin/env bash
# Build both lab images and generate the one lab secret.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./lab.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

install -d -m 0700 "$SECRET_DIR"
if [[ ! -s "$ADMIN_PASS_FILE" ]]; then
    # Lab credential for a throwaway domain. Generated locally, never echoed,
    # never passed on a command line. AD needs upper/lower/digit/symbol.
    # No pipeline: `tr | head` makes head close the pipe, tr takes SIGPIPE, and
    # `set -o pipefail` turns that into a build failure. secrets is CSPRNG-backed.
    python3 -c "import secrets,string; a=string.ascii_letters+string.digits; \
print(''.join(secrets.choice(a) for _ in range(24)) + '!aA1', end='')" > "$ADMIN_PASS_FILE"
    chmod 600 "$ADMIN_PASS_FILE"
    echo "  generated admin password -> $ADMIN_PASS_FILE (mode 600, not printed)"
else
    echo "  admin password already exists, reusing"
fi

echo "== building DC image =="
podman build -f Containerfile.dc -t "$IMG_DC" . >/dev/null && echo "  $IMG_DC"
echo "== building client image =="
podman build -f Containerfile.client -t "$IMG_CLIENT" . >/dev/null && echo "  $IMG_CLIENT"
podman images --format '  {{.Repository}}:{{.Tag}} {{.Size}}' | grep -E 'samba-ad-dc|ad-client'
