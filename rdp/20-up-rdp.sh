#!/usr/bin/env bash
# Bring up the RDP targets on static-edt at .30 and .31.
#
# Both get the local account. Only rdp1 is joined to the domain (25-join-rdp.sh);
# rdp2 stays standalone on purpose, so a failure in the sssd stack cannot be
# mistaken for a failure of xrdp itself.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./rdp.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

for i in $(seq 1 "$RDP_COUNT"); do
    n=$(rdp_name $i); ip=$(rdp_ip $i)
    echo "== $n at $ip =="
    podman rm -f "$n" >/dev/null 2>&1 || true
    # apparmor=unconfined is not decoration. Ubuntu 26.04 loads SVG icons
    # through glycin, which runs its loader inside `bwrap --unshare-all`.
    # Podman's default AppArmor profile denies the mount that bwrap needs, so
    # the loader dies, GTK turns the failed load of Adwaita's image-missing.svg
    # into a g_error, and the whole xfce4-session aborts ~6 s after login. The
    # only symptom xrdp reports is "Window manager exited with signal SIGABRT".
    #   evidence: bwrap: Failed to make / slave: Permission denied
    podman run -d --name "$n" --hostname "$n" \
        --network "$NET" --ip "$ip" \
        --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
        --security-opt apparmor=unconfined \
        --shm-size=256m \
        -v "$LOCAL_PASS_FILE:/run/localpass:ro" \
        -v "$ADMIN_PASS_FILE:/run/adminpass:ro" \
        -e LOCAL_USER="$LOCAL_USER" \
        "$IMG_RDP" >/dev/null

    # Wait for 3389 to actually accept a connection. `podman ps` says Up the
    # instant the process forks, which is several seconds before xrdp binds.
    ok=no
    for t in $(seq 1 60); do
        if timeout 2 bash -c "cat </dev/null >/dev/tcp/$ip/3389" 2>/dev/null; then ok=yes; break; fi
        sleep 1
    done
    if [[ $ok == yes ]]; then
        echo "  3389 accepting connections"
        podman exec "$n" bash -c 'pgrep -a xrdp; pgrep -a xrdp-sesman' | sed 's/^/    /'
    else
        echo "  FAILED to open 3389"; podman logs --tail 30 "$n"; exit 1
    fi
done
echo; echo "targets up. run ./25-join-rdp.sh"
