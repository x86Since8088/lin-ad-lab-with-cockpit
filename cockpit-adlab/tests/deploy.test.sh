#!/usr/bin/env bash
#
# deploy.test.sh - regression tests for deploy.sh / install.sh, for the
# 1.11.2 outage: a lexicographic payload sort removed the IN-USE payload, and
# install.sh then refused to relink the dangling symlinks that left behind.
#
# Root-free and hermetic. Every run is staged into a throwaway DESTDIR: deploy.sh
# and install.sh explicitly allow an unprivileged, un-chowned install when
# DESTDIR is set (that is how a deploy is rehearsed without touching a live host),
# so these tests exercise the REAL scripts end to end with no network, no share,
# no Cockpit and no privilege.
#
#   ./tests/deploy.test.sh          run the suite
#
# Exit 0 = all pass, nonzero = at least one failure.
set -Eeuo pipefail

HERE="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd -- "$HERE/.." && pwd)"                 # the cockpit-adlab payload source
[[ -f "$REPO/deploy.sh" && -f "$REPO/install.sh" ]] \
    || { echo "cannot find deploy.sh/install.sh beside $REPO" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf -- "$WORK"' EXIT

# A private, writable copy of the payload source, so a test can set VERSION per
# deploy without touching the checkout. Only the files deploy.sh actually reads
# are needed, but copying the tree is simpler and just as hermetic.
SRC="$WORK/src"
cp -a -- "$REPO" "$SRC"
rm -rf -- "$SRC/tests" "$SRC/__pycache__" "$SRC/.pytest_cache"   # not shipped anyway

PASS=0 FAIL=0
ok()   { printf '  ok   %s\n' "$*"; PASS=$((PASS+1)); }
bad()  { printf '  FAIL %s\n' "$*" >&2; FAIL=$((FAIL+1)); }

# deploy <destdir> <version> [--expect-fail]
# Runs the REAL deploy.sh with VERSION pinned, staged into <destdir>. Returns the
# deploy's own exit status; captures its output in $LAST_OUT for assertions.
LAST_OUT=""
deploy() {
    local dest=$1 ver=$2 rc=0
    printf '%s\n' "$ver" > "$SRC/VERSION"
    LAST_OUT="$(DESTDIR="$dest" "$SRC/deploy.sh" --install-to /opt/cockpit-adlab 2>&1)" || rc=$?
    return $rc
}

payloads() {   # basenames of the real payload-* dirs under a sandbox, sorted
    local dest=$1 root p
    root="$dest/opt/cockpit-adlab"
    for p in "$root"/payload-*; do [[ -d "$p" && ! -L "$p" ]] && basename -- "$p"; done | sort
}

resolves_into() {   # a link resolves (target exists) into the given payload dir
    local link=$1 want=$2 t
    t="$(readlink -f -- "$link" 2>/dev/null)" || return 1
    [[ -e "$t" && "$t" == *"/$want/"* ]]
}

# ---------------------------------------------------------------------------
echo "CASE 1: payload retention keeps the NEWEST previous payload (sort -Vr)"
# 1.10.0 in use with 1.9.0 also present, then deploy 1.10.1. Lexicographically
# 1.9.0 sorts after 1.10.x, so the buggy sort -r kept 1.9.0 and deleted 1.10.0.
D1="$WORK/dest1"
deploy "$D1" 1.9.0  >/dev/null || bad "1.1 deploy 1.9.0 failed"
deploy "$D1" 1.10.0 >/dev/null || bad "1.2 deploy 1.10.0 failed"
# precondition: both previous payloads are present before the decisive deploy
got="$(payloads "$D1" | tr '\n' ' ')"
[[ "$got" == "payload-1.10.0 payload-1.9.0 " ]] \
    && ok "1.3 precondition: 1.9.0 and 1.10.0 both present ($got)" \
    || bad "1.3 precondition wrong: got [$got]"

if deploy "$D1" 1.10.1 >/dev/null; then ok "1.4 deploy 1.10.1 succeeded"
else bad "1.4 deploy 1.10.1 failed:
$LAST_OUT"; fi

got="$(payloads "$D1" | tr '\n' ' ')"
[[ "$got" == "payload-1.10.0 payload-1.10.1 " ]] \
    && ok "1.5 kept newest previous (1.10.0), removed 1.9.0 ($got)" \
    || bad "1.5 wrong retention (this is the outage if 1.10.0 is missing): got [$got]"

resolves_into "$D1/usr/local/sbin/adlab-admin" payload-1.10.1 \
    && ok "1.6 adlab-admin link resolves into the new payload" \
    || bad "1.6 adlab-admin link does not resolve into payload-1.10.1"
resolves_into "$D1/usr/share/cockpit/adlab/index.html" payload-1.10.1 \
    && ok "1.7 cockpit page link resolves into the new payload" \
    || bad "1.7 cockpit page link does not resolve into payload-1.10.1"

# ---------------------------------------------------------------------------
echo "CASE 2: a host already broken by the sort bug self-heals on redeploy"
# Reproduce the damaged state directly: the in-use payload has been removed out
# from under the live symlinks, so they DANGLE into a payload dir that no longer
# exists. install.sh's owned_by_us must still recognise those as ours (readlink
# -m) and relink them, instead of aborting with "already exists and is not ours".
D2="$WORK/dest2"
deploy "$D2" 1.10.0 >/dev/null || bad "2.1 deploy 1.10.0 failed"
rm -rf -- "$D2/opt/cockpit-adlab/payload-1.10.0"        # what the bug did
resolves_into "$D2/usr/local/sbin/adlab-admin" payload-1.10.0 \
    && bad "2.2 setup: link still resolves - the payload was not really removed" \
    || ok "2.2 setup: /usr symlinks now dangle (payload-1.10.0 gone)"

if deploy "$D2" 1.10.1 >/dev/null; then ok "2.3 redeploy over dangling links succeeded"
else bad "2.3 redeploy over dangling links FAILED (the pre-fix FATAL):
$LAST_OUT"; fi

resolves_into "$D2/usr/local/sbin/adlab-admin" payload-1.10.1 \
    && ok "2.4 adlab-admin relinked into the new payload" \
    || bad "2.4 adlab-admin not relinked into payload-1.10.1"
resolves_into "$D2/usr/share/cockpit/adlab/index.html" payload-1.10.1 \
    && ok "2.5 cockpit page relinked into the new payload" \
    || bad "2.5 cockpit page not relinked into payload-1.10.1"

# ---------------------------------------------------------------------------
printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]]
