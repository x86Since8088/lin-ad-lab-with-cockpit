#!/usr/bin/env bash
# ONE-TIME migration: move the CURRENT running lab's state onto the persistent
# host storage ($STATE_ROOT), in place, WITHOUT losing the forest.
#
# Why in-place tar and not a fresh re-join: a DC's SYSVOL and its EDY-issued
# LDAPS certs are per-DC and NOT replicated by DRS, so re-joining onto empty
# storage would resurrect the empty-SYSVOL incident and drop the certs. Tar
# preserves them — including the security.NTACL xattrs that ARE the sysvol
# ACLs (hence --xattrs --xattrs-include='*.*' --acls; a plain copy silently
# drops them and sysvolcheck fails even though file contents match).
#
# Safety model: done one container at a time, each verified against a baseline
# captured up front (domain SID, user count, per-DC sysvol hash) before the
# next is touched. If a DC fails verification the script ABORTS with its state
# left on disk for inspection; the other DCs still hold the forest, so the
# worst-case recovery is to wipe that one DC's state dir and let 20-up.sh
# re-join it from a peer.
#
# Idempotent: a container already bind-mounting $STATE_ROOT is skipped.
set -uo pipefail
cd "$(dirname "$(readlink -f "$0")")"
. ./lab.env
[[ $EUID -eq 0 ]] || { echo "run as root"; exit 1; }

TARFLAGS="--xattrs --xattrs-include=*.* --acls --numeric-owner"
PASS_MOUNT="$ADMIN_PASS_FILE:/run/adminpass:ro"

log()  { printf '%s %s\n' "$(date +%H:%M:%S)" "$*"; }
die()  { printf 'FATAL %s\n' "$*" >&2; exit 1; }

already_persistent() {   # $1 = container — true if it already mounts STATE_ROOT
    podman inspect "$1" --format '{{range .Mounts}}{{.Source}}
{{end}}' 2>/dev/null | grep -q "^$STATE_ROOT/"
}

wait_dc() {   # $1 = ip, $2 = name
    local t
    for t in $(seq 1 90); do
        podman exec "$2" samba-tool domain info "$1" >/dev/null 2>&1 \
          && podman exec "$2" timeout 3 bash -c "cat </dev/null >/dev/tcp/$1/389" 2>/dev/null \
          && return 0
        sleep 2
    done
    return 1
}

# ---- baseline (the invariants every DC must still satisfy afterward) --------
log "capturing forest baseline"
BASE_SID=$(podman exec dc1 bash -c "samba-tool group show 'Domain Admins' 2>/dev/null | grep -oE 'S-1-5-21-[0-9-]+' | head -1" | sed 's/-512$//')
BASE_USERS=$(podman exec dc1 samba-tool user list 2>/dev/null | wc -l)
declare -A BASE_SYSVOL
sysvol_hash() { podman exec "$1" bash -c 'find /var/lib/samba/sysvol -type f -exec sha256sum {} \; 2>/dev/null | sed "s| .*/sysvol/| |" | sort | sha256sum | cut -c1-16'; }
for i in $(seq 1 "$DC_COUNT"); do BASE_SYSVOL[$(dc_name $i)]=$(sysvol_hash "$(dc_name $i)"); done
[[ -n "$BASE_SID" && "$BASE_USERS" -gt 0 ]] || die "could not capture baseline (SID=$BASE_SID users=$BASE_USERS)"
log "baseline: SID=$BASE_SID users=$BASE_USERS sysvol(dc1)=${BASE_SYSVOL[dc1]}"

copy_out() {   # $1 = mounted rootfs, $2 = in-container path, $3 = host dest dir
    local src="$1$2"
    [ -d "$src" ] || { log "  (no $2 in container; skipping)"; return 0; }
    rm -rf "${3:?}/"* 2>/dev/null || true
    install -d -m 0755 "$3"
    tar $TARFLAGS -C "$src" -cpf - . | tar $TARFLAGS -C "$3" -xpf - \
      || die "tar $2 -> $3 failed"
}

# ---- DCs -------------------------------------------------------------------
for i in $(seq 1 "$DC_COUNT"); do
    n=$(dc_name "$i"); ip=$(dc_ip "$i"); d="$STATE_ROOT/$n"
    echo "==================== $n ($ip) ===================="
    if already_persistent "$n"; then log "$n already persistent — skipping"; continue; fi

    log "$n: stopping (flushes tdb/ldb cleanly before copy)"
    podman stop "$n" >/dev/null || die "$n stop failed"
    root=$(podman mount "$n") || die "$n mount failed"
    log "$n: copying state from $root"
    install -d -m 0755 "$d/var-lib-samba" "$d/etc-samba" "$d/edy-agent"
    copy_out "$root" /var/lib/samba "$d/var-lib-samba"
    copy_out "$root" /etc/samba     "$d/etc-samba"
    copy_out "$root" /etc/edy-agent "$d/edy-agent"
    podman unmount "$n" >/dev/null || true
    [ -f "$d/var-lib-samba/private/sam.ldb" ] || die "$n: sam.ldb not copied — aborting BEFORE rm"

    log "$n: recreating with persistent mounts"
    podman rm "$n" >/dev/null || die "$n rm failed"
    podman run -d --name "$n" --hostname "$n" \
        --network "$NET" --ip "$ip" \
        --cap-add SYS_ADMIN,NET_ADMIN,SYS_TIME --security-opt seccomp=unconfined \
        -v "$PASS_MOUNT" $(dc_state_args "$i") \
        -e ROLE=run -e REALM="$REALM" -e DOMAIN_NB="$DOMAIN_NB" \
        -e DC_IP="$ip" -e FORWARDER="$FORWARDER" -e ADMIN_PASS_FILE=/run/adminpass \
        "$IMG_DC" >/dev/null || die "$n run failed"
    wait_dc "$ip" "$n" || die "$n did not serve LDAP after recreate"

    # verify against baseline
    u=$(podman exec "$n" samba-tool user list 2>/dev/null | wc -l)
    sid=$(podman exec "$n" bash -c "samba-tool group show 'Domain Admins' 2>/dev/null | grep -oE 'S-1-5-21-[0-9-]+' | head -1" | sed 's/-512$//')
    sv=$(sysvol_hash "$n")
    ntacl=$(podman exec "$n" samba-tool ntacl sysvolcheck >/dev/null 2>&1 && echo clean || echo BAD)
    # read the cert from the HOST bind mount (deterministic; no race with samba start)
    iss=$(openssl x509 -in "$d/var-lib-samba/private/tls/cert.pem" -noout -issuer 2>/dev/null)
    log "$n: users=$u sid=$sid sysvol=$sv ntacl=$ntacl"
    [[ "$u" == "$BASE_USERS" ]]        || die "$n user count $u != baseline $BASE_USERS"
    [[ "$sid" == "$BASE_SID" ]]        || die "$n domain SID changed ($sid) — RE-PROVISION detected, forest at risk"
    [[ "$sv" == "${BASE_SYSVOL[$n]}" ]] || die "$n sysvol hash $sv != baseline ${BASE_SYSVOL[$n]}"
    [[ "$ntacl" == "clean" ]]          || die "$n sysvolcheck FAILED — NTACL xattrs lost in copy"
    case "$iss" in *"EDY Proxy Root CA"*) log "$n: EDY LDAPS cert preserved" ;;
                   *) log "  WARN $n LDAPS issuer is not the EDY root ($iss) — re-run 42-tls-from-edy-ca.sh" ;; esac
    log "$n MIGRATED OK"
done

# ---- clients ---------------------------------------------------------------
for i in $(seq 1 "$CLIENT_COUNT"); do
    n=$(client_name "$i"); ip=$(client_ip "$i"); d="$STATE_ROOT/$n"
    echo "==================== $n ($ip) ===================="
    if already_persistent "$n"; then log "$n already persistent — skipping"; continue; fi

    log "$n: stopping"
    podman stop "$n" >/dev/null 2>&1 || true
    root=$(podman mount "$n") || die "$n mount failed"
    install -d -m 0755 "$d/etc-sssd" "$d/var-lib-sss" "$d/edy-agent"
    copy_out "$root" /etc/sssd    "$d/etc-sssd"
    copy_out "$root" /var/lib/sss "$d/var-lib-sss"
    copy_out "$root" /etc/edy-agent "$d/edy-agent"
    if [ -f "$root/etc/krb5.keytab" ]; then
        cp -a "$root/etc/krb5.keytab" "$d/krb5.keytab"
    else
        : > "$d/krb5.keytab"; log "  (no keytab in container)"
    fi
    podman unmount "$n" >/dev/null || true

    log "$n: recreating with persistent mounts"
    podman rm "$n" >/dev/null || die "$n rm failed"
    podman run -d --name "$n" --hostname "$n" \
        --network "$NET" --ip "$ip" \
        --cap-add SYS_ADMIN --security-opt seccomp=unconfined \
        -v "$PASS_MOUNT" $(client_state_args "$i") \
        "$IMG_CLIENT" >/dev/null || die "$n run failed"
    # podman reset resolv.conf to aardvark; point it back at a DC before testing
    fix_ad_resolv "$n" "$(dc_ip $(( (i % DC_COUNT) + 1 )))"
    # Verify with the machine KEYTAB (kinit -k), not `net ads testjoin -P`:
    # adcli-joined clients have no secrets.tdb, so testjoin always fails while
    # the persisted keytab is the real credential.
    kt=$(podman exec "$n" bash -c "klist -k /etc/krb5.keytab 2>/dev/null | awk 'NR>3 && \$2 ~ /@/ {print \$2; exit}'")
    if [ -n "$kt" ] && podman exec "$n" kinit -k "$kt" >/dev/null 2>&1; then
        podman exec "$n" kdestroy >/dev/null 2>&1 || true
        log "$n MIGRATED OK (persisted machine keytab authenticates: $kt)"
    else
        # not fatal — the computer account persists on the DCs, so 20-up.sh can
        # always re-join; report and continue.
        log "  WARN $n machine keytab did not authenticate post-migrate (present=$( [ -s "$d/krb5.keytab" ] && echo yes || echo no ))"
    fi
done

echo "==================== agents ===================="
# Recreates reset the container overlay, so the edy-agent binary is gone but
# /etc/edy-agent (enrollment) is now persistent; 40-agent.sh reinstalls the
# binary and restarts each agent under its SAME pinned identity.
./40-agent.sh >/dev/null 2>&1 && echo "  40-agent.sh re-applied" || echo "  WARN 40-agent.sh reported issues"

echo
echo "migration complete. every DC/client now bind-mounts state from $STATE_ROOT."
echo "run ./22-persist.sh again (idempotent no-op) or ./30-verify.sh to re-check."
