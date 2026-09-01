#!/usr/bin/env bash
# Shared helpers for the SYSVOL scripts. Sourced, never executed.
# Runs on the HOST as root; reaches the DCs with `podman exec`.

_here="$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
# shellcheck source=../lab.env
. "$_here/../lab.env"
# shellcheck source=./sysvol.env
. "$_here/sysvol.env"

SYSVOL_DIR="${REALM,,}"                 # ad.edt1.lab
SYSVOL_DOMAIN_PATH="$SYSVOL_PATH/$SYSVOL_DIR"

log()  { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
warn() { printf '%s WARN  %s\n' "$(date +%H:%M:%S)" "$*" >&2; }
die()  { printf '%s FATAL %s\n' "$(date +%H:%M:%S)" "$*" >&2; exit 1; }

# All DC container names, in index order.
all_dcs() { local i; for i in $(seq 1 "$DC_COUNT"); do dc_name "$i"; done; }

# IP of a DC given its container name (dc3 -> 172.15.4.12).
dc_ip_of() { local n="${1#dc}"; dc_ip "$n"; }

# Container must be running.
dc_up() { podman inspect -f '{{.State.Running}}' "$1" 2>/dev/null | grep -qx true; }

# Ask the directory which DC holds the PDC emulator FSMO role, and translate
# it to a container name. This is queried, never hardcoded: if the role is
# transferred or seized, replication follows it automatically.
#
#   PdcEmulationMasterRole owner: CN=NTDS Settings,CN=DC1,CN=Servers,...
#                                              ^^^^
pdc_emulator() {
    local d out
    for d in $(all_dcs); do
        dc_up "$d" || continue
        out=$(podman exec "$d" samba-tool fsmo show 2>/dev/null \
              | sed -n 's/^PdcEmulationMasterRole owner: CN=NTDS Settings,CN=\([^,]*\),.*/\1/p')
        [[ -n "$out" ]] && { echo "${out,,}"; return 0; }
    done
    return 1
}

# --- ephemeral rsync daemon on the source DC --------------------------------
# read only = yes  -> a replica can never push its divergent copy back.
# hosts allow      -> only the lab subnet.
# use chroot = yes -> daemon chroots into the module path.
rsyncd_start() {
    local src="$1" ip i err
    ip="$(dc_ip_of "$src")"

    # Write the config from the host. Do NOT nest a heredoc inside a heredoc
    # fed to `bash -s`: the inner one competes with the outer for stdin and the
    # file silently never appears.
    podman exec -i "$src" tee "$RSYNC_CONF" >/dev/null <<CONF
uid = 0
gid = 0
use chroot = yes
max connections = 16
pid file = $RSYNC_PIDFILE
log file = /var/log/rsyncd-sysvol.log
[$RSYNC_MODULE]
    path = $SYSVOL_PATH
    comment = SYSVOL, authoritative copy (PDC emulator)
    read only = yes
    hosts allow = $RSYNC_HOSTS_ALLOW
CONF
    podman exec "$src" rm -f "$RSYNC_PIDFILE"

    err=$(podman exec "$src" rsync --daemon \
              --config="$RSYNC_CONF" --port="$RSYNC_PORT" --address="$ip" 2>&1) \
        || { warn "$src: rsync --daemon failed: $err"; return 1; }

    for i in $(seq 1 30); do
        podman exec "$src" test -s "$RSYNC_PIDFILE" 2>/dev/null && return 0
        sleep 0.2
    done
    warn "$src: rsyncd never wrote $RSYNC_PIDFILE"
    return 1
}

rsyncd_stop() {
    local src="$1"
    podman exec "$src" bash -c \
        "[ -s '$RSYNC_PIDFILE' ] && kill \"\$(cat '$RSYNC_PIDFILE')\" 2>/dev/null;
         rm -f '$RSYNC_PIDFILE' '$RSYNC_CONF'; exit 0" >/dev/null 2>&1
    return 0
}

# Every DC must have rsync/getfacl/getfattr. The stock Containerfile.dc does
# not install them; install on demand so this works against the running lab.
# The DCs' own DNS has no forwarder, so point at the forwarder for the fetch
# and restore resolv.conf afterwards (it is a bind mount -- write in place,
# `mv` fails with EBUSY).
ensure_tools() {
    local d rc=0
    for d in $(all_dcs); do
        dc_up "$d" || { warn "$d is not running; skipping"; continue; }
        podman exec "$d" bash -c 'command -v rsync getfacl getfattr >/dev/null 2>&1' && continue
        log "$d: installing rsync/acl/attr"
        podman exec "$d" bash -c "
            cp /etc/resolv.conf /tmp/resolv.keep
            printf 'nameserver %s\n' '$FORWARDER' > /etc/resolv.conf
            DEBIAN_FRONTEND=noninteractive apt-get update -qq \
              && apt-get install -y -qq --no-install-recommends rsync acl attr
            rc=\$?
            cat /tmp/resolv.keep > /etc/resolv.conf; rm -f /tmp/resolv.keep
            exit \$rc" >/dev/null 2>&1 || { warn "$d: tool install failed"; rc=1; }
    done
    return $rc
}
