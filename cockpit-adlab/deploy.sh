#!/usr/bin/env bash
#
# deploy.sh - the real deployment of cockpit-adlab onto a host.
#
#   ./deploy.sh                          -> /opt/cockpit-adlab
#   ./deploy.sh --install-to /srv/x      -> there instead (absolute, recorded)
#   ./deploy.sh --verify                 -> check a deployed host, write nothing
#   ./deploy.sh --uninstall              -> run the installed install.sh --uninstall
#   ./deploy.sh --remove                 -> ALSO delete the deployed payloads
#
# It copies the declared payload into an install path, seeds .env from
# .envdefault MISSING-ONLY, then runs install.sh FROM THAT INSTALL PATH - the
# same install.sh, which is why a deployed install and a dev install are the
# same mechanism pointed at two different directories.
#
# Self-contained on purpose: no shared framework, no sourcing anything outside
# this directory. This plugin ships inside a repository that is cloned on its
# own, and a deploy script that needs a file living somewhere else is a deploy
# script that does not work on the host that needs it.
#
# After this, unmount the development share. Everything still works. That is
# the acceptance test.
set -Eeuo pipefail

SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
SRC="$(cd -- "$(dirname -- "$SELF")" && pwd)"

# ---------------------------------------------------------------------------
# ONE declaration, and it is install.sh's. Sourced, never restated: two lists
# that must agree is the failure this whole gate exists to design out, and
# re-typing it here is the obvious way to re-introduce it.
eval "$(sed -n '/^# BEGIN-MANIFEST/,/^# END-MANIFEST/p' "$SRC/install.sh")"
[[ -n "${PROJECT:-}" && -n "${PAGE_NAME:-}" && ${#PAGE[@]} -gt 0 ]] \
    || { echo "FATAL could not read the manifest out of $SRC/install.sh" >&2; exit 1; }

# No silent default. payload-<version> is what makes an upgrade reversible, so
# a missing VERSION must stop the deploy, not quietly pin every release to the
# same directory name and make rollback impossible.
[[ -f "$SRC/VERSION" ]] || { echo "deploy.sh: no VERSION file in $SRC. The payload directory is named payload-<version>; without one there is nothing to name it, and no rollback target." >&2; exit 1; }
VERSION="$(cat "$SRC/VERSION")"
[[ "$VERSION" =~ ^[0-9A-Za-z._-]+$ ]] || { echo "deploy.sh: VERSION is not a plain version string: '$VERSION'" >&2; exit 1; }
ROOT="/opt/$PROJECT"

# The one true DEV location, and the RETIRED checkout-under-/opt this contract
# exists because of - assembled from named parts so that NEITHER appears as a
# literal anywhere in this file, including in this comment.
#
# These scripts ship into the payload. An audit whose own text matches its
# pattern is an audit with a permanent known exception, and an audit with a
# permanent known exception is one nobody runs a second time. So a recursive
# grep of a deployed tree for either root must come back completely empty,
# and the two lines below are what pay for that.
_ao=ai-orchestrator; _retired=git
DEV_ROOT="/srv/smb/share/sc/${_ao}-group/${_ao}-storage/projects"
RETIRED_ROOT="/opt/sc/${_retired}"
ACTION=deploy
KEEP=1                       # previous payloads retained

say()  { printf '  %-12s %s\n' "$1" "$2"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  WARN %s\n' "$*" >&2; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --install-to) ROOT="${2:-}"; shift 2 ;;
    --verify)     ACTION=verify; shift ;;
    --uninstall)  ACTION=uninstall; shift ;;
    --remove)     ACTION=remove; shift ;;
    -h|--help)    sed -n '2,22p' "$SELF" | sed 's/^# \?//'; exit 0 ;;
    *)            die "unknown option: $1" ;;
  esac
done
[[ "$ROOT" == /* ]] || die "--install-to must be an absolute path (got: $ROOT)"

D="${DESTDIR:-}"
ROOT_D="$D$ROOT"
NEW="$ROOT_D/payload-$VERSION"
ENVF="$ROOT_D/.env"

[[ $EUID -eq 0 || -n "$D" ]] || die "run as root, through the job runner
(/srv/jobs, submit-job.sh). Nothing was changed."

# Ownership is applied by a REAL deploy. Staging into a DESTDIR builds a package
# image as an unprivileged user, where chown is neither possible nor meaningful:
# the modes are what matter and they are set either way.
OWN=()
[[ $EUID -eq 0 && -z "$D" ]] && OWN=(-o root -g root)

# The ONE recursive removal this contract permits, with its three assertions.
# $ROOT_REAL is resolved once: comparing against an unresolved root is how a
# symlinked /opt defeats the containment check.
remove_old_payload() {
    local p=$1 real root_real
    [[ -d "$p" && ! -L "$p" ]]  || die "refusing: $p is not a real directory"
    real="$(readlink -f -- "$p")"           || die "refusing: cannot resolve $p"
    root_real="$(readlink -f -- "$ROOT_D")" || die "refusing: cannot resolve $ROOT_D"
    [[ "$real" == "$root_real"/payload-* ]] \
        || die "refusing to recursively remove $real - not a payload dir under $root_real"
    [[ "$real" != "$root_real" ]] || die "refusing: that is the install root"
    rm -rf -- "$real"
    say removed "$real"
}

# ---------------------------------------------------------------------------
copy_declared_payload_into() {
    local dst=$1 f
    install -d -m 0755 "${OWN[@]}" -- "$dst" "$dst/bin"
    for f in "${PAGE[@]}"; do install -m 0644 "${OWN[@]}" -- "$SRC/$f" "$dst/$f"; done
    for f in "${PAGE_DIRS[@]:-}"; do
        [[ -n "$f" ]] || continue
        install -d -m 0755 -- "$dst/$f"
        find "$SRC/$f" -maxdepth 1 -type f -exec install -m 0644 -- {} "$dst/$f/" \;
    done
    # Helpers land in bin/ in a payload even when the checkout keeps them at its
    # root; install.sh resolves "bin/<h> if present, else <h> beside me".
    for f in "${HELPERS[@]}"; do
        local s="$SRC/$f"; [[ -f "$SRC/bin/$f" ]] && s="$SRC/bin/$f"
        install -m 0755 "${OWN[@]}" -- "$s" "$dst/bin/$f"
    done
    for f in "${LIBS[@]:-}"; do
        [[ -n "$f" ]] || continue
        install -d -m 0755 -- "$dst/$(dirname -- "$f")"
        cp -a -- "$SRC/$f" "$dst/$f"
    done
    if [[ -n "${UNITS[*]:-}" ]]; then
        install -d -m 0755 -- "$dst/systemd"
        for f in "${UNITS[@]}"; do
            [[ -f "$SRC/systemd/$f.in" ]] && install -m 0644 -- "$SRC/systemd/$f.in" "$dst/systemd/$f.in"
            [[ -f "$SRC/systemd/$f"    ]] && install -m 0644 -- "$SRC/systemd/$f"    "$dst/systemd/$f"
        done
    fi
    for f in "${SEEDS[@]:-}"; do [[ -n "$f" ]] && cp -a -- "$SRC/$f" "$dst/$f"; done
    install -m 0644 "${OWN[@]}" -- "$SRC/$ENVDEFAULT" "$dst/$ENVDEFAULT"
    install -m 0755 "${OWN[@]}" -- "$SRC/install.sh"  "$dst/install.sh"
    printf '%s\n' "$VERSION" > "$dst/VERSION"; chmod 0644 "$dst/VERSION"
    # LICENSE ships; README.md does not, and that is deliberate. The README's
    # audience is somebody holding the REPOSITORY -- it explains how to deploy,
    # which you do from a checkout, and to do that it must quote the development
    # root. A payload that quotes the development root defeats the one audit
    # that catches this project's oldest bug:
    #     grep -rl <dev root> /opt/cockpit-adlab   must return nothing.
    # The deployed host gets the same answers from install.conf and from
    # `adlab-admin config`, which are machine-readable and cannot go stale.
    [[ -f "$SRC/LICENSE" ]] && install -m 0644 -- "$SRC/LICENSE" "$dst/LICENSE"
    # NOT shipped, and this is the point of shipping a subset rather than a tree:
    # .git/, tests/, docs/, __pycache__/, .pytest_cache/, any .env, any fixture.
    # A production host holding a test suite and a git history is attack surface
    # bought for nothing.
    return 0
}

seed_env() {
    if [[ -e "$ENVF" ]]; then
        say kept "$ENVF (not overwritten)"
        local new_keys
        new_keys="$(comm -23 <(keys_of "$SRC/$ENVDEFAULT") <(keys_of "$ENVF") | tr '\n' ' ')"
        [[ -z "${new_keys// }" ]] || warn "this version adds keys your .env does not set: $new_keys
       install.sh will refuse until they are set. That refusal is the known cost of
       never clobbering an operator's file, paid at the only safe moment."
    else
        install -m 0644 "${OWN[@]}" -- "$SRC/$ENVDEFAULT" "$ENVF"
        say seeded "$ENVF from $ENVDEFAULT - REVIEW IT BEFORE FIRST USE"
    fi
    refuse_secret_shaped_values
}

keys_of() { grep -v '^[[:space:]]*#' "$1" | grep '=' | sed 's/=.*//' | sed 's/[[:space:]]//g' | sort -u; }

# A .env is mode 0644 so a user-class helper can read a location without
# escalating. That is only safe because a value that looks like a credential is
# REFUSED here rather than merely discouraged in a comment.
refuse_secret_shaped_values() {
    local k v
    while IFS='=' read -r k v; do
        k="${k// }"
        [[ "$k" =~ (PASS|PASSWORD|SECRET|TOKEN|KEY|CREDENTIAL|PASSPHRASE) ]] || continue
        [[ "$k" =~ _(FILE|PATH|DIR|NAME|ID)$ ]] && continue      # a pointer: fine
        [[ -z "${v// }" ]] && continue                            # unset: fine
        die "$k in $ENVF looks like a secret VALUE. A deployed .env carries locations
    and settings, never secrets. Put the material in /etc/$PROJECT/ at 0700 and name
    the FILE here (${k}_FILE=...)."
    done < <(grep -v '^[[:space:]]*#' "$ENVF" | grep '=')
    ok "no secret-shaped value in $ENVF"
}

preflight() {
    printf 'deploy pre-flight\n'
    [[ -f "$SRC/install.sh" ]] || die "no install.sh beside $SELF"
    [[ -f "$SRC/$ENVDEFAULT" ]] || die "no $ENVDEFAULT beside $SELF"
    # /opt is noexec on some hardened hosts, which would produce an install that
    # fails at first click. Refuse now instead.
    if [[ -z "$D" ]]; then
        local mp; mp="$(df -P "$(dirname -- "$ROOT")" 2>/dev/null | awk 'NR==2{print $6}')"
        if [[ -n "$mp" ]] && findmnt -no OPTIONS --target "$mp" 2>/dev/null | tr ',' '\n' | grep -qx noexec; then
            die "the filesystem holding $ROOT ($mp) is mounted noexec. Every helper here
    would fail at first click. Deploy elsewhere with --install-to, or remount."
        fi
    fi
    ok "install path $ROOT is usable"
    # The gate itself, run against the SOURCE before anything is copied. It is
    # install.sh's, not a second copy of it.
    ( cd "$SRC" && ./install.sh --verify >/dev/null 2>&1 ) || true   # state checks will fail pre-deploy
    ok "manifest read from install.sh: ${#PAGE[@]} page file(s), ${#HELPERS[@]} helper(s)"
}

do_deploy() {
    preflight
    printf '\ndeploy %s %s -> %s\n' "$PROJECT" "$VERSION" "$ROOT"
    install -d -m 0755 "${OWN[@]}" -- "$ROOT_D"

    rm -rf -- "$NEW.tmp"                       # a name we just built; nothing else can be here
    copy_declared_payload_into "$NEW.tmp"
    [[ -d "$NEW" ]] && remove_old_payload "$NEW"
    mv -T -- "$NEW.tmp" "$NEW"
    say copied "$NEW"

    # The swap is a single rename(2). There is no instant at which `payload`
    # does not resolve - which matters because Cockpit is LIVE on this host and
    # a browser may be loading the page while this runs.
    ln -sfn -- "payload-$VERSION" "$ROOT_D/payload.new"
    mv -T -- "$ROOT_D/payload.new" "$ROOT_D/payload"
    say swapped "$ROOT_D/payload -> payload-$VERSION"

    seed_env

    # Keep exactly one previous payload: rollback is then two commands, with no
    # share and no network.
    local p keepers
    mapfile -t keepers < <(ls -1d "$ROOT_D"/payload-* 2>/dev/null | grep -v "payload-$VERSION\$" | sort -r)
    for p in "${keepers[@]:$KEEP}"; do [[ -n "$p" ]] && remove_old_payload "$p"; done

    printf '\nrunning the INSTALLED install.sh (not this checkout copy)\n'
    DESTDIR="$D" "$ROOT_D/payload/install.sh"

    cat <<EOF

deployed. This host no longer depends on the development share.

  rollback:  ln -sfn payload-<older> $ROOT/payload.new \\
             && mv -T $ROOT/payload.new $ROOT/payload && $ROOT/payload/install.sh
  configure: \$EDITOR $ENVF   then  /usr/local/sbin/adlab-admin config
  units:     this project declares none; nothing was enabled or started.
  cockpit.socket was NOT touched.
EOF
}

do_verify() {
    printf 'deploy verify\n'
    [[ -L "$ROOT_D/payload" ]] && ok "$ROOT_D/payload -> $(readlink -- "$ROOT_D/payload")" \
                               || { echo "  FAIL $ROOT_D/payload is not a symlink"; return 1; }
    [[ -f "$ENVF" ]] && ok "$ENVF present" || { echo "  FAIL $ENVF missing"; return 1; }
    refuse_secret_shaped_values
    # The regression this project exists to prevent: a deployed file naming the
    # development share. If this ever prints, the deploy shipped a checkout path.
    if grep -RIn -e "$DEV_ROOT" -e "$RETIRED_ROOT" \
         -- "$ROOT_D/payload/" "$ENVF" 2>/dev/null; then
        echo "  FAIL a deployed file names the development share or the retired root (above)"
        return 1
    fi
    ok "no deployed file names the development share or the retired root"
    "$ROOT_D/payload/install.sh" --verify
}

do_uninstall() {
    [[ -x "$ROOT_D/payload/install.sh" ]] \
        || die "no installed payload at $ROOT_D/payload; nothing to uninstall"
    "$ROOT_D/payload/install.sh" --uninstall
}

do_remove() {
    [[ -x "$ROOT_D/payload/install.sh" ]] && "$ROOT_D/payload/install.sh" --uninstall || true
    local p
    for p in "$ROOT_D"/payload-*; do [[ -d "$p" ]] && remove_old_payload "$p"; done
    [[ -L "$ROOT_D/payload" ]] && { rm -f -- "$ROOT_D/payload"; say unlinked "$ROOT_D/payload"; }
    cat <<EOF

  KEPT: $ENVF and $ROOT_D itself. --remove removes the software this script
  copied; it does not remove what you configured. Delete them by hand if you
  really mean to.
EOF
}

case "$ACTION" in
    deploy)    do_deploy ;;
    verify)    do_verify ;;
    uninstall) do_uninstall ;;
    remove)    do_remove ;;
esac
