#!/bin/bash
# PID 1 for an RDP target container.
#
#   - creates the local unix account from a MOUNTED password file (never from
#     the environment: /proc/1/environ is readable by anything in the container)
#   - starts sssd if the host has been joined to a domain
#   - starts xrdp-sesman, then xrdp in the foreground
#
# Deliberately not systemd: the three daemons have no ordering requirement
# beyond sesman-before-xrdp, and a container init would add a seat/logind
# dependency that Xvnc does not need.
set -u

LOCAL_USER="${LOCAL_USER:-rdplocal}"
LOCAL_PASS_FILE="${LOCAL_PASS_FILE:-/run/localpass}"

log() { echo "[rdp-entrypoint] $*"; }

# ---------------------------------------------------------------- local account
if [ -r "$LOCAL_PASS_FILE" ]; then
    if ! id -u "$LOCAL_USER" >/dev/null 2>&1; then
        useradd -m -s /bin/bash -c "Local RDP test account" "$LOCAL_USER"
        log "created local account $LOCAL_USER"
    fi
    # chpasswd reads from stdin, so the cleartext never appears in argv.
    printf '%s:%s' "$LOCAL_USER" "$(tr -d '\n' < "$LOCAL_PASS_FILE")" | chpasswd
    log "local password set for $LOCAL_USER (not echoed)"
else
    log "no $LOCAL_PASS_FILE mounted — skipping local account"
fi

# ---------------------------------------------------------------- runtime dirs
# xrdp and sesman rendezvous over unix sockets in this directory. The systemd
# unit normally creates it with the sticky+world-writable mode; without it
# sesman starts, xrdp starts, and every login fails at "cannot connect to
# sesman" with no other symptom.
mkdir -p /run/xrdp/sockdir /run/dbus /var/log
chmod 3777 /run/xrdp/sockdir
# ICE (session management) refuses to use /tmp/.ICE-unix unless it is
# root-owned and sticky; xfce4-session logs "_IceTransmkdir: Owner ... should
# be set to root" and carries on without session management.
mkdir -p /tmp/.ICE-unix /tmp/.X11-unix
chown root:root /tmp/.ICE-unix /tmp/.X11-unix
chmod 1777 /tmp/.ICE-unix /tmp/.X11-unix
rm -f /run/dbus/pid /run/dbus/system_bus_socket
dbus-daemon --system --fork 2>/dev/null && log "system dbus started"

# ---------------------------------------------------------------- sssd
if [ -s /etc/sssd/sssd.conf ]; then
    chmod 600 /etc/sssd/sssd.conf
    rm -f /var/lib/sss/pipes/*.sock 2>/dev/null
    if sssd -D 2>/dev/null; then
        log "sssd started"
    else
        log "WARN sssd failed to start"
    fi
else
    log "not domain-joined (no /etc/sssd/sssd.conf) — local accounts only"
fi

# ---------------------------------------------------------------- edy-agent
# Restart an already-enrolled edy-agent across container restarts (the
# overlay keeps its binary and /etc/edy-agent state). First install and
# enrollment are 40-agent.sh's job.
if [ -x /usr/local/bin/edy-agent ] && [ -s /etc/edy-agent/state.json ]; then
    (setsid /usr/local/bin/edy-agent run --manage-dns=false >>/var/log/edy-agent.log 2>&1 &)
    log "edy-agent restarted"
fi

# ---------------------------------------------------------------- xrdp
/usr/sbin/xrdp-sesman
sleep 1
if pgrep -x xrdp-sesman >/dev/null; then log "xrdp-sesman up (pid $(pgrep -x xrdp-sesman | head -1))"
else log "FATAL xrdp-sesman did not start"; tail -20 /var/log/xrdp-sesman.log 2>/dev/null; exit 1; fi

log "starting xrdp in the foreground as pid 1"
exec /usr/sbin/xrdp --nodaemon
