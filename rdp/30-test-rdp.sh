#!/usr/bin/env bash
# Drive real RDP sessions from edt1 to the lab targets and collect evidence.
#
# The client runs against a private Xvfb rather than the host's XWayland
# session, for three reasons: it is reproducible from a root job (which has no
# seat), the screenshot is then a capture of exactly the client window with no
# desktop furniture around it, and driving xdotool against the user's live
# GNOME session would be both intrusive and unreliable.
#
# Input is delivered CLIENT-SIDE: xdotool types into the xfreerdp3 window, so
# every keystroke is encoded as an RDP Input PDU, crosses the wire, and is
# replayed by xrdp into the Xvnc session. Verification is then done
# SERVER-SIDE, by reading back inside the container what those keystrokes
# produced. A screenshot alone would not distinguish a real session from a
# repainted stale framebuffer.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./rdp.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }
# FreeRDP resolves a config directory at startup; a job has no HOME and it
# aborts before it prints anything useful.
export HOME=/root

XD="${XD:-:99}"
export DISPLAY="$XD"   # xfreerdp3 is an X11 client; it reads DISPLAY, not an argument
W=1280; H=800
mkdir -p "$EVIDENCE_DIR"
# A private scratch directory, NOT fixed paths in /tmp. This host runs
# fs.protected_regular=2, under which even root cannot O_CREAT-open an existing
# file it does not own inside a sticky world-writable directory — so a stale
# /tmp/shot.xwd left by another uid silently breaks every screenshot.
WORK=$(mktemp -d /var/tmp/rdp-test.XXXXXX)
PASS=0; FAIL=0
ok(){ echo "  PASS  $1"; PASS=$((PASS+1)); }
no(){ echo "  FAIL  $1 ($2)"; FAIL=$((FAIL+1)); }

xd()       { DISPLAY="$XD" xdotool "$@"; }
type_rdp() { DISPLAY="$XD" xdotool type --delay 45 -- "$1"; }
key_rdp()  { DISPLAY="$XD" xdotool key --delay 120 "$@"; }
shot() {
    local out="$EVIDENCE_DIR/$1"
    xwd -display "$XD" -root -silent > "$WORK/shot.xwd" 2>"$WORK/shot.err" \
      || { echo "    shot FAILED for $1 (xwd): $(tr '\n' ' ' <"$WORK/shot.err")"; return 1; }
    magick "xwd:$WORK/shot.xwd" "$out" 2>"$WORK/shot.err" \
      || { echo "    shot FAILED for $1 (magick): $(tr '\n' ' ' <"$WORK/shot.err")"; return 1; }
    chmod 664 "$out" 2>/dev/null
    echo "    shot  evidence/$1  $(stat -c %s "$out") bytes"
}

start_xvfb() {
    pkill -f "Xvfb $XD" 2>/dev/null; sleep 1
    Xvfb "$XD" -screen 0 "${W}x${H}x24" -nolisten tcp >"$WORK/xvfb.log" 2>&1 &
    for i in $(seq 1 20); do
        DISPLAY="$XD" xdpyinfo >/dev/null 2>&1 && return 0; sleep 0.5
    done
    echo "Xvfb $XD never came up"; cat "$WORK/xvfb.log"; exit 1
}
stop_xvfb() { pkill -f "Xvfb $XD" 2>/dev/null; }

# ---------------------------------------------------------------- connect
RDP_PID=""
connect() {   # label host user domain passfile [extra freerdp args...]
    local label=$1 host=$2 user=$3 dom=$4 pf=$5; shift 5
    local log="$EVIDENCE_DIR/${label}.freerdp.log"
    local -a args=( "/v:$host" "/u:$user" "/size:${W}x${H}" "/cert:ignore"
                    "/bpp:24" "-grab-keyboard" "/log-level:INFO"
                    "/log-filters:com.freerdp.core.nego:DEBUG,com.freerdp.crypto:INFO" "$@" )
    [[ -n "$dom" ]] && args+=( "/d:$dom" )
    # /args-from:fd: reads the argument list off a pipe. The password therefore
    # never appears in argv (world-readable via /proc/<pid>/cmdline for the
    # life of the process) and never touches a filesystem. FreeRDP's own
    # /from-stdin is unusable here: it calls tcgetattr on stdin and fails with
    # ENOTTY under a job runner.
    # stdbuf -oL: WLog's default appender writes to STDOUT, which glibc makes
    # fully buffered once it is a file. Without this the negotiation lines sit
    # in a 4 KiB buffer until the client exits, so anything that reads the log
    # while the session is still up sees an empty file.
    stdbuf -oL -eL xfreerdp3 /args-from:fd:3 \
        3< <( printf '%s\n' "${args[@]}"; printf '/p:%s\n' "$(tr -d '\n' < "$pf")" ) \
        >"$log" 2>&1 &
    RDP_PID=$!
    echo "    xfreerdp3 pid $RDP_PID -> evidence/${label}.freerdp.log"
}

wait_for_window() {   # seconds
    local win=""
    for i in $(seq 1 "$1"); do
        win=$(xd search --onlyvisible --name '.' 2>/dev/null | tail -1)
        [[ -n "$win" ]] && { echo "$win"; return 0; }
        kill -0 "$RDP_PID" 2>/dev/null || return 1
        sleep 1
    done
    return 1
}

focus_client() {   # keep the pointer inside the client window: a bare Xvfb has
                   # no window manager, so X focus is PointerRoot and the window
                   # under the pointer is the one that receives key events.
    xd mousemove "$1" "$2"
    sleep 0.3
}

disconnect() { [[ -n "$RDP_PID" ]] && kill "$RDP_PID" 2>/dev/null; sleep 2; RDP_PID=""; }

negotiated() {   # $1 = label -> what the security negotiation actually settled on
    grep -oE 'Negotiated \[[A-Z_|]+\]\[0x[0-9a-f]+\] security' "$EVIDENCE_DIR/$1.freerdp.log" | tail -1
}

# ---------------------------------------------------------------- server side
uid_of() { podman exec "$1" getent passwd "$2" 2>/dev/null | cut -d: -f3; }
home_of(){ podman exec "$1" getent passwd "$2" 2>/dev/null | cut -d: -f6; }

sess_display() {   # container user -> the Xvnc display owned by THAT user
    # Not "the first Xvnc in the container": xrdp keeps a disconnected session
    # alive for reconnection, so after the first case there is always a stale
    # :10 belonging to somebody else, and every later lookup aims at it.
    local uid; uid=$(uid_of "$1" "$2"); [[ -z "$uid" ]] && return 1
    podman exec "$1" bash -c "pgrep -u $uid -a -x Xvnc | awk '{print \$3; exit}'"
}
in_sess() {   # container user display -- cmd...
    # `podman exec -u <name>` resolves the name against the container's
    # /etc/passwd only. A domain user exists solely in NSS via sssd, so the
    # name is unknown to podman and the exec fails; resolve to a numeric uid
    # (and the real home, which is where Xvnc put the .Xauthority) first.
    local c=$1 u=$2 d=$3; shift 3
    local uid home; uid=$(uid_of "$c" "$u"); home=$(home_of "$c" "$u")
    [[ -z "$uid" ]] && return 1
    podman exec -u "$uid" -e DISPLAY="$d" -e HOME="$home" \
        -e XAUTHORITY="$home/.Xauthority" "$c" "$@"
}
end_session() {   # container user — leave no session behind for the next case
    local uid; uid=$(uid_of "$1" "$2"); [[ -z "$uid" ]] && return 0
    podman exec "$1" bash -c "pkill -u $uid -x xfce4-session" >/dev/null 2>&1
    sleep 4
}

# ================================================================== the test
run_case() {   # label host container loginuser sessuser domain passfile drive
    local label=$1 host=$2 c=$3 user=$4 sessuser=$5 dom=$6 pf=$7 drive=$8; shift 8
    echo
    echo "=============================================================="
    echo "CASE $label — /u:$user ${dom:+/d:$dom} @ $host ($c)"
    echo "=============================================================="
    local mark; mark=$(podman exec "$c" bash -c 'wc -l < /var/log/xrdp-sesman.log' 2>/dev/null || echo 0)
    connect "$label" "$host" "$user" "$dom" "$pf" "$@"

    local win; win=$(wait_for_window 30)
    if [[ -z "$win" ]]; then
        no "$label connect" "no client window; see evidence/$label.freerdp.log"
        grep -viE 'load_map_from_xkbfile|DANGER' "$EVIDENCE_DIR/$label.freerdp.log" | tail -12 | sed 's/^/      /'
        disconnect; return 1
    fi
    ok "$label RDP window mapped (X window $win)"
    echo "    security: $(negotiated "$label")"

    # The desktop needs Xvnc + xfce4-session + panel + the autostart terminal.
    sleep 18

    echo "    --- xrdp-sesman, only the lines this case produced ---"
    podman exec "$c" bash -c "tail -n +$((mark+1)) /var/log/xrdp-sesman.log" \
        | grep -E 'login request|Access|create a session|Starting X server|reconnect|window manager' \
        | sed 's/^/      /'

    local d; d=$(sess_display "$c" "$sessuser")
    if [[ -z "$d" ]]; then
        no "$label session" "no Xvnc owned by $sessuser in $c"
        podman exec "$c" tail -12 /var/log/xrdp-sesman.log | sed 's/^/      /'
        disconnect; return 1
    fi
    ok "$label session running in $c as $sessuser on display $d"
    shot "${label}-01-desktop.png"
    echo "    processes owned by $sessuser inside $c:"
    podman exec "$c" bash -c "pgrep -u $(uid_of "$c" "$sessuser") -a . | grep -E 'Xvnc|xfce4-session|xfce4-terminal|xfwm4|xfdesktop'" \
        | sed 's/^/      /'

    # Kerberos: sssd's krb5 auth provider writes a ccache for the user it just
    # authenticated. Its presence is the difference between "PAM said yes" and
    # "a KDC issued a ticket".
    if [[ -n "$dom" || "$sessuser" == "$DOMAIN_USER" ]]; then
        echo "    --- Kerberos ccache for $sessuser inside $c ---"
        podman exec "$c" bash -c "ls -l /tmp/krb5cc_$(uid_of "$c" "$sessuser")* 2>/dev/null" | sed 's/^/      /'
        podman exec -u "$(uid_of "$c" "$sessuser")" "$c" bash -c \
            "KRB5CCNAME=\$(ls /tmp/krb5cc_$(uid_of "$c" "$sessuser")* 2>/dev/null | head -1) klist 2>&1" | sed 's/^/      /'
    fi

    [[ "$drive" != yes ]] && { disconnect; end_session "$c" "$sessuser"; return 0; }

    # ---- keystrokes, client side, over the wire -------------------------
    local proof="/tmp/rdp-proof-${label}.txt"
    local note="/tmp/rdp-note-${label}.txt"
    focus_client 300 300
    xd click 1; sleep 1
    type_rdp "id; hostname; echo TYPED-OVER-RDP-${label} > ${proof}; date -Is >> ${proof}; id -un >> ${proof}; hostname >> ${proof}"
    key_rdp Return
    sleep 3
    shot "${label}-02-terminal.png"

    if podman exec "$c" test -f "$proof"; then
        ok "$label keystrokes reached the session (server-side $proof exists)"
        echo "    --- $proof as read inside $c ---"
        podman exec "$c" cat "$proof" | sed 's/^/      /'
    else
        no "$label keystroke delivery" "$proof was never created"
    fi

    # ---- launch a GUI application BY TYPING over RDP --------------------
    type_rdp "mousepad ${note} &"
    key_rdp Return
    sleep 7
    if podman exec "$c" bash -c 'pgrep -x mousepad >/dev/null'; then
        ok "$label launched mousepad from the typed command line"
    else
        no "$label app launch" "mousepad is not running in $c"
    fi

    # Ask the session where the window landed, then aim the CLIENT mouse there.
    # The RDP session and the client window are both ${W}x${H} and the client
    # window sits at 0,0 on a WM-less Xvfb, so session coordinates and client
    # coordinates are the same numbers.
    local geo wx wy ww wh mw
    mw=$(in_sess "$c" "$sessuser" "$d" xdotool search --onlyvisible --class mousepad 2>/dev/null | tail -1)
    if [[ -n "$mw" ]]; then
        geo=$(in_sess "$c" "$sessuser" "$d" xdotool getwindowgeometry --shell "$mw" 2>/dev/null)
        wx=$(sed -n 's/^X=//p' <<<"$geo"); wy=$(sed -n 's/^Y=//p' <<<"$geo")
        ww=$(sed -n 's/^WIDTH=//p' <<<"$geo"); wh=$(sed -n 's/^HEIGHT=//p' <<<"$geo")
        echo "    mousepad window (server side): x=$wx y=$wy ${ww}x${wh}"

        # click into its text area, then type
        focus_client $((wx + ww/2)) $((wy + wh/2))
        xd click 1; sleep 1
        type_rdp "Typed into mousepad over RDP from edt1."
        key_rdp Return
        type_rdp "case=${label} user=${user} domain=${dom:-none} target=${host}"
        key_rdp ctrl+s
        sleep 3

        # ---- mouse: move the window ---------------------------------------
        # Alt+drag, not a title-bar drag: xfwm4's easy_click modifier is <Alt>
        # by default and grabs anywhere in the frame, so this does not depend
        # on guessing the decoration height from the client-window origin.
        local cx=$((wx + ww/2)) cy=$((wy + wh/2))
        echo "    Alt+dragging mousepad from ($cx,$cy) by (-260,-160)"
        xd mousemove "$cx" "$cy"; sleep 0.3
        xd keydown alt; sleep 0.2
        xd mousedown 1; sleep 0.4
        xd mousemove $((cx - 130)) $((cy - 80)); sleep 0.4
        xd mousemove $((cx - 260)) $((cy - 160)); sleep 0.6
        xd mouseup 1; sleep 0.3
        xd keyup alt; sleep 2

        local geo2 nx ny
        geo2=$(in_sess "$c" "$sessuser" "$d" xdotool getwindowgeometry --shell "$mw" 2>/dev/null)
        nx=$(sed -n 's/^X=//p' <<<"$geo2"); ny=$(sed -n 's/^Y=//p' <<<"$geo2")
        echo "    mousepad window after drag (server side): x=$nx y=$ny"
        if [[ "$nx" != "$wx" || "$ny" != "$wy" ]]; then
            ok "$label mouse drag over RDP moved the window ($wx,$wy) -> ($nx,$ny)"
        else
            no "$label mouse drag" "window did not move from ($wx,$wy)"
        fi
    else
        no "$label mousepad window" "not found on $c display $d"
    fi
    shot "${label}-03-mousepad.png"

    if podman exec "$c" test -s "$note"; then
        ok "$label mousepad saved the typed text"
        echo "    --- $note as read inside $c ---"
        podman exec "$c" cat "$note" | sed 's/^/      /'
    else
        no "$label mousepad save" "$note is empty or missing"
    fi

    # ---- an independent capture taken INSIDE the session ----------------
    if in_sess "$c" "$sessuser" "$d" xwd -root -silent > "$WORK/${label}-server.xwd" 2>/dev/null \
       && [[ -s "$WORK/${label}-server.xwd" ]]; then
        magick "xwd:$WORK/${label}-server.xwd" "$EVIDENCE_DIR/${label}-04-server-side.png" 2>/dev/null \
          && { chmod 664 "$EVIDENCE_DIR/${label}-04-server-side.png"
               ok "$label server-side screenshot of $d captured"; } \
          || no "$label server-side screenshot" "magick could not convert the xwd"
    else
        no "$label server-side screenshot" "xwd inside the container failed"
    fi

    disconnect
    end_session "$c" "$sessuser"
}

# ================================================================== main
start_xvfb
trap 'disconnect; stop_xvfb; rm -rf "$WORK"' EXIT

RDP1=$(rdp_ip 1); RDP2=$(rdp_ip 2)

# 1. local unix account on the STANDALONE target: proves xrdp+xfce alone.
run_case local-rdp2  "$RDP2" rdp2 "$LOCAL_USER" "$LOCAL_USER" ""  "$LOCAL_PASS_FILE"  yes

# 2. local unix account on the DOMAIN-JOINED target: proves the sssd stack did
#    not break local /etc/shadow authentication.
run_case local-rdp1  "$RDP1" rdp1 "$LOCAL_USER" "$LOCAL_USER" ""  "$LOCAL_PASS_FILE"  no

# 3. the interesting one: AD account, RDP -> PAM -> sssd -> Kerberos -> DC.
run_case domain-rdp1 "$RDP1" rdp1 "$DOMAIN_USER" "$DOMAIN_USER" "$DOMAIN_NB" "$DOMAIN_PASS_FILE" yes

# 4. the same account expressed as EDT1LAB\user in a single field, which is how
#    mstsc sends it. The session still runs as the plain unix name.
run_case domain-backslash "$RDP1" rdp1 "${DOMAIN_NB}\\${DOMAIN_USER}" "$DOMAIN_USER" "" "$DOMAIN_PASS_FILE" no

echo
echo "=== security layer, as negotiated on the wire ==="
for f in "$EVIDENCE_DIR"/*.freerdp.log; do
    printf '  %-20s %s\n' "$(basename "$f" .freerdp.log)" \
        "$(grep -oE 'RequestedProtocols: \[[A-Z|]+\]\[0x[0-9a-f]+\]|selected_protocol: \[[A-Z|]+\]\[0x[0-9a-f]+\]' "$f" | tr '\n' ' ')"
done

echo
echo "==================== $PASS passed, $FAIL failed ===================="
[[ $FAIL -eq 0 ]]
