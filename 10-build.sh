#!/usr/bin/env bash
# Build both lab images and generate the one lab secret.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./lab.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

# This script does NOT create the secrets directory, deliberately.
#
# It used to run `install -d -m 0700 "$SECRET_DIR"`. That is the mechanism that
# turned a stale SECRET_DIR into a silent outage: the variable pointed at a path
# nothing had used in months, the build manufactured an empty 0700 directory
# there, saw no administrator.pass inside it, and minted a BRAND NEW passphrase
# for a forest that already had one — with no record anywhere of the old one.
# Repointing the variable would have fixed that day's symptom and left the
# mechanism intact, so the mechanism is what is removed: a missing secrets
# directory is now a refusal, and creating it is a deliberate operator act.
if [[ ! -d "$SECRET_DIR" ]]; then
    cat >&2 <<EOF
FATAL SECRET_DIR=$SECRET_DIR does not exist.

  This script will not create it. An empty secrets directory created wherever a
  stale variable happens to point is how this lab generates credentials nobody
  has a record of.

  If this lab has never been provisioned, create it once, as root:
      install -d -m 0700 $SECRET_DIR

  If it HAS been provisioned, the credentials are somewhere else and
  \$SECRET_DIR is wrong. Find them before you run anything that writes:
      lab.env derives SECRET_DIR from its own location (<project>/.secrets).
      An installed /etc/samba-ad-lab/lab.env uses /etc/samba-ad-lab/.secrets.
EOF
    exit 1
fi
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
