#!/usr/bin/env bash
#
# install.sh - in-place install of the AD Lab Cockpit plugin, BY SYMLINK.
#
#   ./install.sh                install / re-install from wherever this file is
#   ./install.sh --uninstall    remove the links, keep every byte of data
#   ./install.sh --verify       report this host's state, write nothing
#
# This script does not copy the payload. It links the files beside it into the
# places Cockpit and the shell look, so:
#
#   run it from a DEV CHECKOUT   -> the page Cockpit serves IS the checkout;
#                                   edit adlab.js, reload the browser, done
#   run it from an INSTALL PATH  -> a production install with no relationship
#                                   to any share
#
# It is the SAME script in both roles. Nothing below branches on which one it is
# to decide WHAT to link - only to record which it did, in install.conf. The
# moment dev and prod grow different link logic, the thing you tested stops
# being the thing you shipped.
#
# deploy.sh is what copies, seeds .env, and enables units. See
# cockpit-secrets/source/docs/DEPLOY-CONTRACT.md.
set -Eeuo pipefail

# ---------------------------------------------------------------------------
# BEGIN-MANIFEST
# The ONE declaration. deploy.sh sources these very lines out of this file, so
# there is no second list to disagree with this one. Everything below - the link
# list, the completeness gate, the stale sweep and the uninstall - reads it.
PROJECT=cockpit-adlab
PAGE_NAME=adlab                                          # /usr/share/cockpit/<this>
PAGE=(manifest.json index.html adlab.js adlab.css)       # -> the Cockpit page dir
PAGE_DIRS=()                                             # asset dirs, linked whole
HELPERS=(adlab-admin)                                    # -> /usr/local/sbin/
LIBS=()                                                  # -> /usr/local/lib/<project>/
UNITS=()                                                 # -> $UNITDIR, rendered from .in
SEEDS=()                                                 # -> /etc/<project>/, missing-only
ENVDEFAULT=.envdefault
REQUIRED_ENV=(ADLAB_ROOT ADLAB_LAB_ENV ADLAB_RDP_ENV ADLAB_SYSVOL_REPLICATE
              ADLAB_SECRET_DIR ADLAB_GPO_TEMPLATE_DIR)
UNITDIR=/etc/systemd/system                              # recorded in install.conf
# END-MANIFEST
# ---------------------------------------------------------------------------

# readlink -f FIRST, then dirname. Resolving with dirname alone means an
# install.sh invoked through a symlink computes its payload relative to the
# LINK's directory, and links whatever happens to be there.
SELF="$(readlink -f -- "${BASH_SOURCE[0]}")"
SRC="$(cd -- "$(dirname -- "$SELF")" && pwd)"

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

# WHICH KIND OF INSTALL IS THIS? Decided by LAYOUT, never by a path prefix.
# DEV_ROOT above is now ONLY an audit pattern for check 9; nothing branches on
# it any more.
#
# deploy.sh writes <install path>/payload-<version>/ and points a sibling
# `payload` symlink at it; swapping that symlink IS an upgrade or rollback, so
# this is a DEPLOYED payload exactly when our own directory is what that
# symlink resolves to. A checkout has no such symlink.
#
# The old `$SRC == $DEV_ROOT/*` test got a checkout ANYWHERE ELSE wrong: it
# called itself `deployed`, so it skipped the group-writable warning, recorded
# INSTALL_KIND=deployed for a host that was not self-sustaining, and dropped
# "THE CHECKOUT IS NOT TOUCHED" from an uninstall. Layout cannot drift when a
# tree moves. Computed from $SRC, never $ROOT, which may be derived from KIND.
# Two ways to be a deployed payload. The first is the normal one: the `payload`
# alias points at us. The second covers a PREVIOUS payload being run directly -
# a rollback done without swapping the alias first - which is still a deployed
# tree, not a checkout, and must not be told to go and create a test .env.
if [[ "$(readlink -f -- "$SRC/../payload" 2>/dev/null)" == "$SRC" ]] \
   || { [[ "${SRC##*/}" == payload-* ]] && [[ -L "$SRC/../payload" ]]; }
then KIND=deployed
else KIND=dev
fi

D="${DESTDIR:-}"
CPKGDIR="$D/usr/share/cockpit/$PAGE_NAME"
SBINDIR="$D/usr/local/sbin"
LIBDIR="$D/usr/local/lib/$PROJECT"
ETCDIR="$D/etc/$PROJECT"
INSTALL_CONF="$ETCDIR/install.conf"
UNITDIR_D="$D$UNITDIR"

# The install root is the payload's PARENT when deployed ([install path]/payload),
# and the checkout itself when this is a dev install. Resolved once: comparing
# against an unresolved root is how a symlinked /opt defeats a containment check.
if [[ "$KIND" == deployed && "$(basename -- "$SRC")" == payload* ]]; then
    ROOT="$(dirname -- "$SRC")"
else
    ROOT="$SRC"
fi
ROOT_REAL="$(readlink -f -- "$ROOT")"
ENV_FILE="$ROOT/.env"
VERSION="$( [[ -f "$SRC/VERSION" ]] && cat "$SRC/VERSION" || echo "1.0.0" )"

WITH_UNITS=0
ACTION=install
RC=0
say()  { printf '  %-12s %s\n' "$1" "$2"; }
ok()   { printf '  ok   %s\n' "$*"; }
warn() { printf '  WARN %s\n' "$*" >&2; }
fail() { printf '  FAIL %s\n' "$*"; RC=1; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

while (($#)); do
  case "$1" in
    --uninstall)  ACTION=uninstall; shift ;;
    --verify)     ACTION=verify; shift ;;
    --with-units) WITH_UNITS=1; shift ;;
    -h|--help)    sed -n '2,22p' "$SELF" | sed 's/^# \?//'; exit 0 ;;
    *)            die "unknown option: $1" ;;
  esac
done

# ---------------------------------------------------------------------------
# the three removal primitives (DEPLOY-CONTRACT section 2.4)
#
# The danger this guards, stated plainly: `rm -rf /usr/share/cockpit/adlab`
# where that path is a symlink to the dev checkout deletes the dev checkout.
# GNU rm removes the link and not the target - but WITH A TRAILING SLASH it
# follows, and so does "$DIR"/* , and so does find -delete. One trailing slash
# between a routine uninstall and losing the tree. So: no rm -r, no find
# -delete, no rsync --delete anywhere under /usr/share/cockpit, /usr/local/sbin,
# /etc, /var or the install path. Removal is per declared entry.
# ---------------------------------------------------------------------------
remove_link() {
    local p=$1
    if [[ -L "$p" ]]; then
        rm -f -- "$p"; say unlinked "$p"          # removes the LINK; target untouched
    elif [[ -e "$p" ]]; then
        warn "$p is not a symlink - left in place, remove it by hand if you meant to"
    fi
}

remove_file() {                                   # for things we COPY (units, conf)
    local p=$1
    [[ -e "$p" || -L "$p" ]] || return 0
    [[ -d "$p" && ! -L "$p" ]] && { warn "$p is a directory - left in place"; return 0; }
    rm -f -- "$p"; say removed "$p"
}

remove_dir_if_empty() {
    local p=$1
    [[ -d "$p" && ! -L "$p" ]] || return 0
    rmdir -- "$p" 2>/dev/null && say removed "empty $p" \
        || say kept "$p (not empty - something else lives there)"
}

# ---------------------------------------------------------------------------
# link helpers
# ---------------------------------------------------------------------------

# 0 = ours to create or replace; nonzero = refuse and say why. Two projects
# fighting over one /usr/local/sbin name must surface here, at install time, and
# not as an intermittent wrong-verb error six months later.
owned_by_us() {
    local link=$1 cur
    [[ -e "$link" || -L "$link" ]] || return 0
    [[ -L "$link" ]] || { warn "$link exists and is NOT a symlink"; return 1; }
    cur="$(readlink -f -- "$link")" || return 1
    [[ "$cur" == "$ROOT_REAL"/* || "$cur" == "$SRC"/* ]] \
        || { warn "$link -> $cur, which is not under $ROOT_REAL"; return 1; }
    return 0
}

link_one() {                                      # link_one <target> <linkpath>
    local target=$1 link=$2
    owned_by_us "$link" || die "refusing to take over $link (see the warning above).
    Whatever owns it must be uninstalled first, or this project must stop
    claiming that name."
    ln -sfn -- "$target" "$link"
    say linked "$link -> $target"
}

# A helper may live at the repo root in a checkout and in bin/ in a payload.
# This is the ONLY place the two layouts are allowed to differ.
helper_src() {
    [[ -f "$SRC/bin/$1" ]] && { printf '%s\n' "$SRC/bin/$1"; return; }
    printf '%s\n' "$SRC/$1"
}

# ---------------------------------------------------------------------------
# the completeness gate (DEPLOY-CONTRACT section 7.2)
# Every check REFUSES, and nothing is written until all of them pass.
# ---------------------------------------------------------------------------
preflight() {
    printf 'pre-flight (%s payload at %s)\n' "$KIND" "$SRC"
    local f miss=()

    # 1. payload present
    for f in "${PAGE[@]}";    do [[ -f "$SRC/$f" ]] || miss+=("$f"); done
    for f in "${PAGE_DIRS[@]:-}"; do [[ -n "$f" && ! -d "$SRC/$f" ]] && miss+=("$f/"); done
    for f in "${HELPERS[@]}"; do [[ -f "$(helper_src "$f")" ]] || miss+=("$f"); done
    for f in "${LIBS[@]:-}";  do [[ -n "$f" && ! -e "$SRC/$f" ]] && miss+=("$f"); done
    for f in "${UNITS[@]:-}"; do
        [[ -n "$f" && ! -f "$SRC/systemd/$f.in" && ! -f "$SRC/systemd/$f" ]] && miss+=("systemd/$f")
    done
    [[ -f "$SRC/$ENVDEFAULT" ]] || miss+=("$ENVDEFAULT")
    ((${#miss[@]}==0)) || die "declared but missing from $SRC: ${miss[*]}
    Nothing was changed."
    ok "1. every declared file is present"

    # 2. the page asks only for what is shipped. Parsed, not grepped.
    local refs
    refs="$(python3 - "$SRC/index.html" <<'PY'
import html.parser, sys
class P(html.parser.HTMLParser):
    def __init__(self): super().__init__(); self.refs=[]
    def handle_starttag(self, tag, attrs):
        for k, v in attrs:
            if k in ("src", "href", "data") and v:
                self.refs.append(v)
p = P(); p.feed(open(sys.argv[1], encoding="utf-8").read())
for r in p.refs:
    r = r.split("?")[0].split("#")[0]
    if not r or "://" in r or r.startswith(("/", "../", "data:", "mailto:")):
        continue                       # ../base1/cockpit.js is Cockpit's own file
    print(r)
PY
)" || die "could not parse index.html"
    local r bad=()
    while read -r r; do
        [[ -z "$r" ]] && continue
        printf '%s\n' "${PAGE[@]}" "${PAGE_DIRS[@]:-}" | grep -qxF -- "$r" && continue
        printf '%s\n' "${PAGE_DIRS[@]:-}" | grep -q . && [[ "$r" == */* ]] \
            && printf '%s\n' "${PAGE_DIRS[@]:-}" | grep -qxF -- "${r%%/*}" && continue
        bad+=("$r")
    done <<<"$refs"
    ((${#bad[@]}==0)) || die "index.html references files PAGE does not ship: ${bad[*]}
    Add them to PAGE, or stop the page referencing them. An unenumerated page file
    is swept off the host on the next install run and the page silently loses it."
    ok "2. index.html references only files PAGE ships"

    # 3. every helper the page NAMES is shipped and will be linked. This is the
    #    check that catches a UI whose backend nobody installed. Comments count:
    #    a false positive costs one word in an array, a false negative costs a
    #    page with no backend. Bias to declaring.
    local named h
    named="$(grep -oh '/usr/local/sbin/[A-Za-z0-9_.-]\+' "${PAGE[@]/#/$SRC/}" 2>/dev/null \
             | sed 's#.*/##' | sort -u || true)"
    for h in $named; do
        printf '%s\n' "${HELPERS[@]}" | grep -qxF -- "$h" \
          || die "a shipped page file calls /usr/local/sbin/$h, which HELPERS does not
    install. Add it to HELPERS, or stop the page calling it. (A fresh clone that
    installs a UI whose helper is absent is the exact defect this check exists for.)"
    done
    [[ -n "$named" ]] && ok "3. every helper the page names is declared: $(tr '\n' ' ' <<<"$named")" \
                      || ok "3. the page names no /usr/local/sbin helper"

    # 5. units render clean
    local u out
    for u in "${UNITS[@]:-}"; do
        [[ -n "$u" ]] || continue
        out="$(render_unit_to_stdout "$u")" || exit 1
        grep -q '@[A-Z_]\+@' <<<"$out" && die "unrendered placeholder in $u: $(grep -o '@[A-Z_]*@' <<<"$out" | sort -u | tr '\n' ' ')"
    done
    ok "5. every declared unit renders with no placeholder left"

    # 6. .envdefault parses, and defines every REQUIRED_ENV key
    python3 - "$SRC/$ENVDEFAULT" "${REQUIRED_ENV[@]}" <<'PY' || exit 1
import re, sys
path, required = sys.argv[1], sys.argv[2:]
seen = {}
for n, raw in enumerate(open(path, encoding="utf-8"), 1):
    line = raw.strip()
    if not line or line.startswith("#"):
        continue
    if "=" not in line:
        sys.exit("FATAL %s:%d: not KEY=VALUE" % (path, n))
    k, v = (x.strip() for x in line.split("=", 1))
    if not re.match(r"^[A-Z][A-Z0-9_]*$", k):
        sys.exit("FATAL %s:%d: bad key %r" % (path, n, k))
    if len(v) >= 2 and v[0] == v[-1] == '"':
        v = v[1:-1]
    if "$" in v or "`" in v:
        sys.exit("FATAL %s:%d: %s contains $ or ` - this grammar has no "
                 "interpolation (DEPLOY-CONTRACT 4.1)" % (path, n, k))
    seen[k] = v
missing = [k for k in required if k not in seen]
if missing:
    sys.exit("FATAL %s does not define: %s" % (path, " ".join(missing)))
PY
    ok "6. $ENVDEFAULT parses and defines every REQUIRED_ENV key"

    # 7. on install, .env exists and defines every REQUIRED_ENV key non-empty.
    #    This is where "missing-only seeding cannot add a NEW key" is caught, at
    #    the only moment it can be caught safely.
    if [[ "$ACTION" == install ]]; then
        [[ -f "$ENV_FILE" ]] || die "$ENV_FILE does not exist.
    Run deploy.sh first, or create it from $SRC/$ENVDEFAULT. install.sh never
    writes .env: seeding is deploy.sh's job, missing-only, and an installer that
    also seeded would eventually overwrite an operator's edit."
        local k v missing_k=()
        for k in "${REQUIRED_ENV[@]}"; do
            v="$(sed -n "s/^${k}=//p" "$ENV_FILE" | tail -1 | sed 's/^"//; s/"$//')"
            [[ -n "$v" ]] || missing_k+=("$k")
        done
        ((${#missing_k[@]}==0)) || die "$ENV_FILE does not set: ${missing_k[*]}
    This version needs keys your .env does not have. Copy them from
    $SRC/$ENVDEFAULT and set them; deploy.sh seeds missing-only and cannot add
    a key to a file you already own."
        ok "7. $ENV_FILE sets every REQUIRED_ENV key"
    fi

    # 8. nothing declared collides with another project
    local dst
    for h in "${HELPERS[@]}"; do
        dst="$SBINDIR/$h"
        owned_by_us "$dst" && continue
        # A plain FILE here is almost always this project's own pre-contract
        # install, which COPIED the helper. Say so, rather than leaving the
        # operator to guess which of six projects put it there.
        local hint="Two projects sharing one helper name is a bug that must surface now."
        [[ -f "$dst" && ! -L "$dst" ]] && hint="This is most likely this project's own
    PRE-CONTRACT install, which copied the helper instead of linking it. Remove the
    copy deliberately -- 'rm -f $dst' -- then re-run. It is not removed for you:
    an installer that silently deletes a regular file it did not create is how an
    unrelated project loses its helper."
        if [[ "$ACTION" == verify ]]; then fail "8. $dst is not ours. $hint"
        else die "$dst already exists and is not ours.
    $hint"; fi
    done
    for u in "${UNITS[@]:-}"; do
        [[ -n "$u" && -e "$UNITDIR_D/$u" && ! -f "$UNITDIR_D/$u" ]] && die "$UNITDIR_D/$u is not a regular file"
    done
    ok "8. nothing declared collides with something we do not own"

    # 9. no retired path, and no dev root, in anything being shipped.
    local shipped=("${PAGE[@]/#/$SRC/}" "$SRC/$ENVDEFAULT" "$SELF")
    for h in "${HELPERS[@]}"; do shipped+=("$(helper_src "$h")"); done
    [[ -d "$SRC/systemd" ]] && shipped+=("$SRC"/systemd/*)
    if grep -RIn -e "$RETIRED_ROOT" -e "$DEV_ROOT" -- "${shipped[@]}" 2>/dev/null; then
        die "a shipped file hardcodes a retired or development path (above).
    It belongs in .env: a location is configuration, and configuration that is
    compiled into a shipped file cannot be corrected on the host that is wrong."
    fi
    ok "9. no shipped file names the retired root or the dev root"
}

render_unit_to_stdout() {
    # Two statements, not one. `local n=$1 tpl="$SRC/systemd/$n.in"` expands
    # BOTH assignment words before either binds, so $n is still unset when tpl
    # is built - under `set -u` that aborts, and without it you would silently
    # render the wrong file. ('tpl' rather than 'in' for the second name, too:
    # `in` is a bash reserved word.)
    local n=$1 tpl
    tpl="$SRC/systemd/$n.in"
    [[ -f "$tpl" ]] || tpl="$SRC/systemd/$n"
    [[ -f "$tpl" ]] || { echo "FATAL missing unit template for $n" >&2; return 1; }
    sed -e "s|@PAYLOAD@|$SRC|g" -e "s|@INSTALL_PATH@|$ROOT|g" \
        -e "s|@ENV_FILE@|$ENV_FILE|g" -e "s|@SBIN@|/usr/local/sbin|g" "$tpl"
}

# ---------------------------------------------------------------------------
# verify / uninstall / install
# ---------------------------------------------------------------------------
dev_install_notice() {
    # Ask the LINK TARGET's layout, not this script's: an operator may be
    # running the deployed installer to tear down links a dev install made.
    local t
    t="$(readlink -f -- "$CPKGDIR/index.html" 2>/dev/null || true)"
    [[ -n "$t" ]] \
      && [[ "$(readlink -f -- "${t%/*}/../payload" 2>/dev/null)" != "${t%/*}" ]] && cat <<EOF

  NOTE: this is a DEV install. $CPKGDIR/index.html resolves into a checkout at
        ${t%/*}
        Only symlinks are removed; THE CHECKOUT IS NOT TOUCHED.

EOF
    return 0
}

do_verify() {
    printf 'verify (writes nothing)\n'
    preflight
    printf 'installed state\n'
    local f t
    for f in "${PAGE[@]}"; do
        if   [[ ! -L "$CPKGDIR/$f" ]]; then fail "$CPKGDIR/$f is not a symlink"
        elif ! t="$(readlink -f -- "$CPKGDIR/$f")" || [[ ! -e "$t" ]]; then
             fail "$CPKGDIR/$f is a DANGLING symlink"
        else ok "$CPKGDIR/$f -> $t"; fi
    done
    for f in "${HELPERS[@]}"; do
        if   [[ ! -L "$SBINDIR/$f" ]]; then fail "$SBINDIR/$f is not a symlink"
        elif t="$(readlink -f -- "$SBINDIR/$f")" && [[ -x "$t" ]]; then ok "$SBINDIR/$f -> $t"
        else fail "$SBINDIR/$f does not resolve to an executable"; fi
    done
    [[ -f "$INSTALL_CONF" ]] && ok "$INSTALL_CONF present" || fail "$INSTALL_CONF is missing"
    [[ -f "$ENV_FILE" ]] && ok "$ENV_FILE present" || fail "$ENV_FILE is missing"
    dev_install_notice
    [[ $RC -eq 0 ]] && printf 'verify: PASS\n' || printf 'verify: FAIL\n'
    return $RC
}

do_uninstall() {
    dev_install_notice
    local u f
    for u in "${UNITS[@]:-}"; do
        [[ -n "$u" ]] || continue
        if [[ -z "$D" ]]; then
            systemctl stop "$u" 2>/dev/null || true
            systemctl disable "$u" 2>/dev/null || true
        fi
        remove_file "$UNITDIR_D/$u"
    done
    [[ -n "${UNITS[*]:-}" && -z "$D" ]] && { systemctl daemon-reload || true
                                             systemctl reset-failed 2>/dev/null || true; }
    for f in "${HELPERS[@]}"; do remove_link "$SBINDIR/$f"; done
    for f in "${PAGE[@]}" "${PAGE_DIRS[@]:-}"; do [[ -n "$f" ]] && remove_link "$CPKGDIR/$f"; done
    remove_dir_if_empty "$CPKGDIR"
    remove_file "$INSTALL_CONF"
    remove_dir_if_empty "$ETCDIR"
    cat <<EOF

  KEPT, deliberately - uninstall removes software, never data:
    $ENV_FILE            (your configuration)
    /var/log/adlab-admin.log            (the audit trail)
    the payload at $SRC
  cockpit.socket was NOT touched. Reload the browser; a changed menu needs a
  Cockpit logout/login.
EOF
}

do_install() {
    preflight
    printf '\ninstall (%s)\n' "$KIND"

    install -d -m 0755 -- "$CPKGDIR"
    [[ -L "$CPKGDIR" ]] && die "$CPKGDIR is a symlink. /usr/share/cockpit/<name> is a
    WEB ROOT and must be a real directory of per-file links: pointing it at a
    payload - or worse, at a checkout - serves .git/, tests/ and docs/ over HTTPS
    to every authenticated Cockpit session."

    local f
    for f in "${PAGE[@]}";      do link_one "$SRC/$f" "$CPKGDIR/$f"; done
    for f in "${PAGE_DIRS[@]:-}"; do [[ -n "$f" ]] && link_one "$SRC/$f" "$CPKGDIR/$f"; done

    # stale sweep: the package dir contains EXACTLY what PAGE declares. This is
    # what makes the array the description of the installed state rather than a
    # hopeful comment. Only symlinks are removed; anything else is named, not deleted.
    local base keep
    while IFS= read -r -d '' stale; do
        base="$(basename -- "$stale")"; keep=0
        for f in "${PAGE[@]}" "${PAGE_DIRS[@]:-}"; do [[ "$base" == "$f" ]] && { keep=1; break; }; done
        ((keep)) || { say sweeping "$base (not in PAGE)"; remove_link "$stale"; }
    done < <(find "$CPKGDIR" -mindepth 1 -maxdepth 1 -print0)

    install -d -m 0755 -- "$SBINDIR"
    for f in "${HELPERS[@]}"; do
        local hs; hs="$(helper_src "$f")"
        [[ -x "$hs" ]] || { chmod 0755 -- "$hs" 2>/dev/null || true; }
        [[ -x "$hs" ]] || die "$hs is not executable and its mode could not be fixed.
    Modes belong on the TARGET, in the payload - chmod through a symlink is a no-op."
        link_one "$hs" "$SBINDIR/$f"
    done

    if [[ -n "${LIBS[*]:-}" ]]; then
        install -d -m 0755 -- "$LIBDIR"
        for f in "${LIBS[@]}"; do [[ -n "$f" ]] && link_one "$SRC/$f" "$LIBDIR/$(basename -- "$f")"; done
    fi

    # units: rendered and PLACED. Never enabled, never started, never stopped -
    # that is deploy.sh's job, behind an explicit flag. And refused outright in a
    # dev install without --with-units: a developer running this from the share
    # while a deployed install runs on the same host would otherwise get two
    # daemons reconciling the same state from two different config files.
    if [[ -n "${UNITS[*]:-}" ]]; then
        if [[ "$KIND" == dev && $WITH_UNITS -eq 0 ]]; then
            say skipped "units (dev install; pass --with-units to place them anyway)"
        else
            install -d -m 0755 -- "$UNITDIR_D"
            for f in "${UNITS[@]}"; do
                render_unit_to_stdout "$f" > "$UNITDIR_D/$f.new"
                grep -q '@[A-Z_]\+@' "$UNITDIR_D/$f.new" && { rm -f "$UNITDIR_D/$f.new"
                    die "unrendered placeholder in $f"; }
                chmod 0644 "$UNITDIR_D/$f.new"; chown root:root "$UNITDIR_D/$f.new" 2>/dev/null || true
                mv -f -- "$UNITDIR_D/$f.new" "$UNITDIR_D/$f"; say rendered "$UNITDIR_D/$f"
            done
            [[ -z "$D" ]] && systemctl daemon-reload
        fi
    fi

    # the audit log: created, mode-locked, never truncated.
    if [[ -z "$D" ]]; then
        touch /var/log/adlab-admin.log && chmod 0600 /var/log/adlab-admin.log
        say ensured "/var/log/adlab-admin.log (0600)"
    fi

    # install.conf: the machine's file. .env is the operator's. Nothing good
    # comes of one file being both.
    install -d -m 0755 -- "$ETCDIR"
    cat > "$INSTALL_CONF.new" <<EOF
# Written by install.sh. Do not edit; re-run install.sh instead.
INSTALL_KIND=$KIND
INSTALL_PATH=$ROOT
PAYLOAD=$SRC
ENV_FILE=$ENV_FILE
UNITDIR=$UNITDIR
VERSION=$VERSION
INSTALLED_AT=$(date -u +%Y-%m-%dT%H:%M:%SZ)
INSTALLED_BY=install.sh
EOF
    chmod 0644 "$INSTALL_CONF.new"
    mv -f -- "$INSTALL_CONF.new" "$INSTALL_CONF"
    say wrote "$INSTALL_CONF ($KIND)"

    # post-install assertion: report what we PRODUCED, not what we intended.
    printf '\npost-install assertion\n'
    local t n=0
    for f in "${PAGE[@]}"; do
        [[ -L "$CPKGDIR/$f" ]] || die "post-install: $CPKGDIR/$f is not a symlink"
        t="$(readlink -f -- "$CPKGDIR/$f")"
        [[ -e "$t" ]] || die "post-install: $CPKGDIR/$f dangles"
        [[ "$t" == "$SRC"/* ]] || die "post-install: $CPKGDIR/$f -> $t, outside $SRC"
        n=$((n+1))
    done
    ok "$n page links resolve inside $SRC"
    for f in "${HELPERS[@]}"; do
        t="$(readlink -f -- "$SBINDIR/$f")"
        [[ -x "$t" ]] || die "post-install: $SBINDIR/$f -> $t is not executable"
    done
    ok "every helper resolves to an executable"
    [[ "$(sed -n 's/^PAYLOAD=//p' "$INSTALL_CONF")" == "$SRC" ]] \
        || die "post-install: install.conf PAYLOAD does not match $SRC"
    ok "install.conf PAYLOAD resolves to the payload we linked"

    cat <<EOF

installed ($KIND) - $CPKGDIR is a real directory of per-file symlinks into
  $SRC

  which install is this?   readlink -f $CPKGDIR/index.html
  is it configured?        /usr/local/sbin/adlab-admin config
  cockpit.socket was NOT touched. Reload the browser (Ctrl-Shift-R for the menu).
EOF
    [[ "$KIND" == dev ]] && cat <<EOF
  This is a DEV install: Cockpit is serving the checkout. Unmount the share and
  the page stops working - that is the point. Use deploy.sh for a real host.
EOF
    return 0
}

# Root is needed to write into the live system. Staging into a DESTDIR writes
# only inside the stage, so it is deliberately allowed unprivileged: that is how
# a deploy is rehearsed without touching a host that is serving Cockpit right now.
[[ "$ACTION" == verify || -n "$D" || $EUID -eq 0 ]] || die "run as root, through the
job runner (/srv/jobs, submit-job.sh), or stage with DESTDIR=. Nothing was changed."

case "$ACTION" in
    verify)    do_verify ;;
    uninstall) do_uninstall ;;
    install)   do_install ;;
esac
