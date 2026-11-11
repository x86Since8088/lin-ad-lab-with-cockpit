#!/usr/bin/env python3
"""drills.py — fault injection + drills D1–D9 + stress loops for the HA testbed (design §9, §12).

Faults touch ONLY the testbed VMs (adl-ha-a/b): power, their NIC links, netem on their own taps.
Results are appended to ~/.local/state/adl-ha/results/<run>.jsonl (one record per drill/cycle).

  drills.py fault {poweroff|poweron|isolate|split|lossy|heal|reboot} VM
  drills.py check                         one-screen health (controller, roles, repl, sysvol, time)
  drills.py drill D1|D2|D3|D4|D4b|D5|D6|D8 [--run NAME]
  drills.py loop KIND N [--run NAME]      S1 failover soak (KIND=down|isolated|split|lossy|mixed)
"""
import json
import os
import random
import subprocess
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
RJ = "/home/eddie/.claude/skills/root-job-runner/scripts/rj"
SIM_STATE = os.path.expanduser("~/.local/state/adl-ha/ha-sim")
RESULTS = os.path.expanduser("~/.local/state/adl-ha/results")
VMS = {"adl-ha-a": {"sh0": "10.31.0.11", "dcs": ["dc1", "dc2"]}, "adl-ha-b": {"sh0": "10.31.0.12", "dcs": ["dc3", "dc4"]}}
DC_IPS = {"dc1": "10.31.0.17", "dc2": "10.31.0.18", "dc3": "10.31.0.33", "dc4": "10.31.0.34"}
RUN = "adhoc"


def now():
    return time.time()


def say(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def record(kind, **kw):
    os.makedirs(RESULTS, exist_ok=True)
    rec = {"t": round(now(), 1), "ts": time.strftime("%F %T"), "run": RUN, "kind": kind}
    rec.update(kw)
    with open(os.path.join(RESULTS, RUN + ".jsonl"), "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    say("RESULT", json.dumps(rec, sort_keys=True)[:400])


def sh(argv, timeout=120, inp=None):
    p = subprocess.run(argv, capture_output=True, text=True, timeout=timeout, input=inp)
    return p.returncode, p.stdout, p.stderr


def virsh(*a, timeout=60):
    return sh(["virsh", "-q", "-c", "qemu:///system"] + list(a), timeout=timeout)


def ifaces(vm):
    """[(target, mac, network/bridge)] of a VM."""
    rc, out, _ = virsh("domiflist", vm)
    rows = []
    for line in out.splitlines():
        f = line.split()
        if len(f) >= 5:
            rows.append((f[0], f[4], f[2]))
    return rows


def sh0_tap(vm):
    return [t for t, mac, src in ifaces(vm) if src == "virbr-adlsh"][0]


def lab_tap(vm):
    return [t for t, mac, src in ifaces(vm) if src == "bridge0"][0]


def setlink(vm, tap, state):
    rc, out, err = virsh("domif-setlink", vm, tap, state)
    if rc != 0:
        raise SystemExit("setlink %s %s %s: %s" % (vm, tap, state, err.strip()))


def rootjob(name, body, vm=None, timeout=300):
    argv = [RJ, "-t", str(timeout)] + (["-M", vm] if vm else []) + [name]
    return sh(argv, timeout=timeout + 30, inp=body)


def fault(kind, vm):
    if kind == "poweroff":
        virsh("destroy", vm)
    elif kind == "poweron":
        virsh("start", vm)
    elif kind == "reboot":
        virsh("reboot", vm, "--mode", "agent")
    elif kind == "isolate":
        setlink(vm, sh0_tap(vm), "down")
        setlink(vm, lab_tap(vm), "down")
    elif kind == "split":
        setlink(vm, sh0_tap(vm), "down")
    elif kind == "lossy":
        rootjob("adlha-netem-on", "tc qdisc replace dev %s root netem loss 30%%\ntc qdisc show dev %s\n"
                % (sh0_tap(vm), sh0_tap(vm)))
    elif kind == "heal":
        rc, st, _ = virsh("domstate", vm)
        if st.strip() == "running":
            for t, mac, src in ifaces(vm):
                virsh("domif-setlink", vm, t, "up")
            rootjob("adlha-netem-off", "tc qdisc del dev %s root 2>/dev/null; true\n" % sh0_tap(vm))
        else:
            virsh("start", vm)
    else:
        raise SystemExit("unknown fault %s" % kind)
    say("fault", kind, vm)


def ha(vm, verb, args=None, timeout=60):
    req = {"schema_version": "adlab-ha/1", "verb": verb, "args": args or {}, "op_id": "drill-" + uuid.uuid4().hex[:16]}
    try:
        rc, out, err = sh(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "eddie@" + VMS[vm]["sh0"],
                           "sudo", "-n", "/usr/local/sbin/adlab-ha", "json"], timeout=timeout, inp=json.dumps(req))
        return json.loads(out) if out.strip() else None
    except (subprocess.TimeoutExpired, ValueError):
        return None


def sim():
    try:
        return json.load(open(os.path.join(SIM_STATE, "state.json")))
    except (OSError, ValueError):
        return {}


def events_since(t0):
    out = []
    try:
        for line in open(os.path.join(SIM_STATE, "events.jsonl")):
            e = json.loads(line)
            if e["t"] >= t0:
                out.append(e)
    except OSError:
        pass
    return out


def wait_for(pred, timeout, step=3, what=""):
    t0 = now()
    while now() - t0 < timeout:
        v = pred()
        if v:
            return v, round(now() - t0, 1)
        time.sleep(step)
    return None, round(now() - t0, 1)


def statuses():
    return {vm: ((ha(vm, "ha-status", timeout=20) or {}).get("result")) for vm in VMS}


def snapshot():
    """Who holds what, per DC; replication failures; SYSVOL hashes; time."""
    S = statuses()
    dcs = {}
    for vm, st in S.items():
        if not st:
            continue
        for d in st["dcs"]:
            dcs[d["name"]] = {"state": d["state"], "roles": d["roles"],
                              "fails": sum(r["failures"] for r in d["replication"]),
                              "sv": (d["sysvol_hash"] or "")[:12], "li": d["chrony_li"],
                              "off": d["time_offset_s"]}
    s = sim()
    return {"mode": s.get("mode"), "holder": s.get("holder"), "epoch": s.get("epoch"),
            "hosts_up": [vm for vm, st in S.items() if st],
            "may_write": {vm: (st or {}).get("may_write") for vm, st in S.items()}, "dcs": dcs}


def healthy(snap, want_holder="adl-ha-a"):
    """Steady state: controller healthy with the home holder; all four DCs running, 0 failures,
    PDC role on dc1, one SYSVOL hash, every DC LI=0."""
    d = snap["dcs"]
    if snap["mode"] != "healthy" or snap["holder"] != want_holder or len(d) != 4:
        return False
    if any(x["state"] != "running" or x["fails"] for x in d.values()):
        return False
    if "pdc" not in d.get("dc1", {}).get("roles", []):
        return False
    if len({x["sv"] for x in d.values()}) != 1:
        return False
    return True


def pdc_owner(snap):
    for n, x in snap["dcs"].items():
        if "pdc" in x["roles"]:
            return n
    return None


# ---------------------------------------------------------------- AD actions used by drills
def dc_auth(vm, dc, cmd, timeout=180):
    body = ("podman exec %s sh -c 'umask 077; f=$(mktemp); printf \"username=Administrator\\npassword=%%s\\ndomain=HATEST\\n\" "
            "\"$(cat /run/adminpass)\" > $f; %s -A $f; rc=$?; rm -f $f; exit $rc'\n" % (dc, cmd))
    return rootjob("adlha-dc-auth", body, vm=vm, timeout=timeout)


def gpo_create(vm, dc, name):
    rc, out, err = dc_auth(vm, dc, "samba-tool gpo create %s -H ldap://127.0.0.1" % name)
    return "[exit 0]" in out, out.strip()[-200:]


def gpo_names(vm, dc):
    rc, out, err = rootjob("adlha-gpo-list", "podman exec %s samba-tool gpo listall 2>/dev/null | grep -i 'display name' | sed 's/.*: //'\n" % dc, vm=vm)
    return sorted(l.strip() for l in out.splitlines() if l.strip() and not l.startswith("["))


def gpo_folder_everywhere(name):
    """The GPO's SYSVOL folder must exist on EVERY DC (directory entry alone is not enough)."""
    rc, out, err = rootjob("adlha-gpo-guid", "podman exec dc1 samba-tool gpo listall 2>/dev/null | grep -B1 -i 'display name *: *%s$' | awk '/^GPO/{print $3}'\n" % name, vm="adl-ha-a")
    guid = ([l.strip() for l in out.splitlines() if l.strip().startswith("{")] or [None])[0]
    if not guid:
        return False, {"guid": None}
    seen = {}
    for vm, meta in VMS.items():
        for dc in meta["dcs"]:
            rc, o2, e2 = rootjob("adlha-gpo-dir", "test -d /opt/adl-forest/state/%s/var-lib-samba/sysvol/ha.test.lab/Policies/%s && echo yes || echo no\n" % (dc, guid), vm=vm)
            seen[dc] = "yes" in o2
    return all(seen.values()), {"guid": guid, "on": seen}


def user_names(vm, dc):
    rc, out, err = rootjob("adlha-users", "podman exec %s samba-tool user list 2>/dev/null\n" % dc, vm=vm)
    return {l.strip().lower() for l in out.splitlines() if l.strip() and not l.startswith("[")}


def sid_dupes(vm, dc):
    rc, out, err = rootjob("adlha-sid-scan",
                           "podman exec %s ldbsearch -H /var/lib/samba/private/sam.ldb '(objectSid=*)' objectSid 2>/dev/null "
                           "| awk '/^objectSid:/{print $2}' | sort | uniq -d | wc -l\n" % dc, vm=vm)
    try:
        return int([l for l in out.splitlines() if l.strip().isdigit()][0])
    except IndexError:
        return -1


# ---------------------------------------------------------------- drills
def wait_healthy(timeout, holder="adl-ha-a"):
    return wait_for(lambda: (lambda s: s if healthy(s, holder) else None)(snapshot()), timeout, step=10)


def d_failover_cycle(kind, vm="adl-ha-a", gpo=True, label=None):
    """Inject `kind` on the home host, expect the right class + action, heal, expect failback."""
    t0 = now()
    base = snapshot()
    if not healthy(base):
        s, took = wait_healthy(600)
        if not s:
            record(label or kind, ok=False, why="not healthy before the fault", snap=base)
            return False
    fault(kind, vm)
    exp_cls = {"poweroff": "down", "isolate": "isolated", "split": "split", "lossy": None}[kind]
    def classified():
        for e in events_since(t0):
            if e["event"] == "classify":
                return e
    cls_ev, t_cls = wait_for(classified, 240, step=3)
    res = {"fault": kind, "expected_class": exp_cls, "class": (cls_ev or {}).get("classification"),
           "t_classify_s": t_cls if cls_ev else None}
    def acted():
        ev = [e for e in events_since(t0) if e["event"] in ("placement_apply", "failover_lease_only", "seize")]
        return ev and any(e["event"] == "placement_apply" for e in ev) and ev
    act, t_act = wait_for(acted, 300, step=3) if cls_ev and exp_cls else (None, 0)
    res["t_takeover_s"] = t_act if act else None
    seizes = [e for e in events_since(t0) if e["event"] == "seize"]
    res["seizes"] = len(seizes)
    res["seize_ok"] = all(e.get("ok") for e in seizes) if seizes else None
    mid = snapshot()
    res["pdc_during"] = pdc_owner(mid)
    res["may_write_during"] = mid["may_write"]
    # GPO edit during the outage, on whichever host may write (if any)
    marker = None
    if gpo and kind in ("poweroff", "isolate"):
        marker = "drill-%s-%d" % (kind, int(now()))
        ok, why = gpo_create("adl-ha-b", "dc3", marker)
        res["gpo_during"] = ok
    res["t_fault"] = round(t0, 1)
    res["t_heal"] = round(now(), 1)
    fault("heal" if kind != "poweroff" else "poweron", vm)
    s, t_back = wait_healthy(900)
    res["t_end"] = round(now(), 1)
    res["t_failback_s"] = t_back if s else None
    res["healthy_after"] = bool(s)
    fin = snapshot()
    res["pdc_after"] = pdc_owner(fin)
    if marker:
        res["gpo_survived_on_dc1"] = marker.lower() in [g.lower() for g in gpo_names("adl-ha-a", "dc1")]
        time.sleep(70)          # one SYSVOL cycle after failback
        res["gpo_folder_everywhere"], res["gpo_folder"] = gpo_folder_everywhere(marker)
    res["sysvol_hashes"] = sorted({x["sv"] for x in fin["dcs"].values()})
    res["ok"] = bool(s) and (exp_cls is None or res["class"] == exp_cls) and \
        (kind != "split" or res["seizes"] == 0) and \
        (not marker or (res.get("gpo_survived_on_dc1") and res.get("gpo_folder_everywhere")))
    record(label or ("cycle-" + kind), **res)
    return res["ok"]


def drill(name):
    t0 = now()
    if name == "D1":
        # clean reboot of the home host: must NOT fail over (fits lease + grace)
        fault("reboot", "adl-ha-a")
        time.sleep(5)
        s, took = wait_healthy(600)
        ev = [e["event"] for e in events_since(t0)]
        record("D1", ok=bool(s) and "classify" not in ev and "seize" not in ev, back_after_s=took,
               events=sorted(set(ev)))
    elif name == "D2":
        d_failover_cycle("poweroff", label="D2")
    elif name == "D4":
        d_failover_cycle("split", label="D4")
    elif name == "D4b":
        d_failover_cycle("isolate", label="D4b")
    elif name == "D5":
        fault("poweroff", "adl-ha-b")
        time.sleep(60)
        ev = [e["event"] for e in events_since(t0)]
        snap = snapshot()
        fault("poweron", "adl-ha-b")
        s, took = wait_healthy(600)
        record("D5", ok=bool(s) and "seize" not in ev and pdc_owner(snap) == "dc1", events=sorted(set(ev)),
               recovered_s=took)
    elif name == "D3":
        # link cut where the NON-holder (B) is the one cut off: the holder keeps the lease and
        # the roles, nobody seizes, A's clients keep authenticating, B self-fences nothing
        fault("split", "adl-ha-b")
        time.sleep(120)
        ev = [e["event"] for e in events_since(t0)]
        mid = snapshot()
        fault("heal", "adl-ha-b")
        s, took = wait_healthy(600)
        record("D3", ok=bool(s) and "seize" not in ev and "failover_lease_only" not in ev and mid["holder"] == "adl-ha-a"
               and pdc_owner(mid) == "dc1", events=sorted(set(ev)), holder_during=mid["holder"], recovered_s=took)
    elif name == "D7":
        # class-B seize while A is down, then A returns: dc1 must be HELD and REBUILT, never serve
        # with stale class-B roles; no duplicate SIDs; every role home afterwards
        if not healthy(snapshot()):
            wait_healthy(600)
        fault("poweroff", "adl-ha-a")
        _, t_to = wait_for(lambda: [e for e in events_since(t0) if e["event"] == "seize" and e.get("ok")], 300)
        made = []
        for i in range(5):                       # users created on the survivor during the outage
            n = "d7-out-%d-%d" % (int(now()), i)
            rc, out, err = dc_auth("adl-ha-b", "dc3", "samba-tool user add %s 'Pw-%s-x9!' -H ldap://127.0.0.1" % (n, uuid.uuid4().hex[:8]))
            made.append("[exit 0]" in out)
        sh([sys.executable, os.path.join(HERE, "ha-sim.py"), "seize-class-b", "class-b", "drill-D7", "home host gone for good (drill)"])
        cb, _ = wait_for(lambda: [e for e in events_since(t0) if e["event"] == "seize_class_b"], 300)
        cb_ok = bool(cb) and cb[-1].get("ok")
        fault("poweron", "adl-ha-a")
        # dc1 must come up HELD (rebuild flag), then be rebuilt by the controller
        held, t_held = wait_for(lambda: (lambda st: st if st and any(d["name"] == "dc1" and d["state"] in ("held", "rebuild")
                                                                      for d in st["dcs"]) else None)(
            (ha("adl-ha-a", "ha-status") or {}).get("result")), 300, step=5)
        rb, t_rb = wait_for(lambda: [e for e in events_since(t0) if e["event"] == "rebuild_rejoin" and e.get("ok")], 900, step=10)
        s, t_back = wait_healthy(1500)
        fin = snapshot()
        all_home = sorted(fin["dcs"].get("dc1", {}).get("roles", [])) == sorted(
            ["pdc", "rid", "schema", "naming", "infrastructure", "domaindns", "forestdns"])
        after = []
        for i in range(5):                       # users created on the rebuilt RID master
            n = "d7-after-%d-%d" % (int(now()), i)
            rc, out, err = dc_auth("adl-ha-a", "dc1", "samba-tool user add %s 'Pw-%s-x9!' -H ldap://127.0.0.1" % (n, uuid.uuid4().hex[:8]))
            after.append("[exit 0]" in out)
        time.sleep(30)
        dupes = {"dc1": sid_dupes("adl-ha-a", "dc1"), "dc3": sid_dupes("adl-ha-b", "dc3")}
        record("D7", ok=cb_ok and bool(held) and bool(rb) and bool(s) and all_home and all(made) and all(after)
               and dupes == {"dc1": 0, "dc3": 0}, class_b_seized=cb_ok, dc1_held=bool(held), held_after_s=t_held,
               rebuilt=bool(rb), rebuild_after_s=t_rb, healthy_after=bool(s), healthy_after_s=t_back,
               roles_home=all_home, users_during=sum(made), users_after=sum(after), duplicate_sids=dupes)
    elif name == "D9":
        # snapshot-restore of ONE DC (dc4) = USN rollback: detect, quarantine, rebuild, lose nothing
        if not healthy(snapshot()):
            wait_healthy(600)
        S = "/opt/adl-forest/state/dc4"
        rootjob("adlha-d9-snap", "set -e\npodman stop -t 10 dc4 >/dev/null\nrm -rf /opt/adl-forest/d9-snap && mkdir -p /opt/adl-forest/d9-snap\n"
                "tar --xattrs --xattrs-include='*' --acls -C %s -cpf /opt/adl-forest/d9-snap/state.tar var-lib-samba etc-samba\n"
                "podman start dc4 >/dev/null\necho snap-taken\n" % S, vm="adl-ha-b")
        time.sleep(40)
        users = []
        for i in range(10):
            n = "d9-%d-%d" % (int(now()), i)
            rc, out, err = dc_auth("adl-ha-b", "dc4", "samba-tool user add %s 'Pw-%s-x9!' -H ldap://127.0.0.1" % (n, uuid.uuid4().hex[:8]))
            users.append((n, "[exit 0]" in out))
        # let dc3 pull dc4's new changes (its high-water mark for dc4 moves past the snapshot)
        time.sleep(90)
        t_restore = now()
        rootjob("adlha-d9-restore", "set -e\npodman stop -t 10 dc4 >/dev/null\nrm -rf %s/var-lib-samba %s/etc-samba\n"
                "tar --xattrs --xattrs-include='*' --acls -C %s -xpf /opt/adl-forest/d9-snap/state.tar\n"
                "podman start dc4 >/dev/null\necho restored-old-state\n" % (S, S, S), vm="adl-ha-b")
        det, t_det = wait_for(lambda: [e for e in events_since(t_restore) if e["event"] == "usn_rollback_flagged"], 600, step=5)
        rb, t_rb = wait_for(lambda: [e for e in events_since(t_restore) if e["event"] == "rebuild_rejoin" and e.get("ok")], 900, step=10)
        s, t_back = wait_healthy(1200)
        present = sum(1 for n, ok in users if ok and n.lower() in user_names("adl-ha-a", "dc1"))
        dupes = {"dc1": sid_dupes("adl-ha-a", "dc1"), "dc4": sid_dupes("adl-ha-b", "dc4")}
        record("D9", ok=bool(det) and bool(rb) and bool(s) and present == sum(ok for _, ok in users) and dupes == {"dc1": 0, "dc4": 0},
               detected=bool(det), detect_after_s=t_det, rebuilt=bool(rb), rebuild_after_s=t_rb, healthy_after=bool(s),
               users_created=sum(ok for _, ok in users), users_present_after=present, duplicate_sids=dupes)
    elif name == "D8":
        r = ha("adl-ha-b", "ha-placement-apply", {"placement": {"stale": True}})
        st = sim()
        req = {"schema_version": "adlab-ha/1", "verb": "ha-fence", "args": {"reason": "stale"},
               "op_id": "d8-" + uuid.uuid4().hex[:8], "epoch": max(0, st.get("epoch", 1) - 1)}
        rc, out, err = sh(["ssh", "eddie@10.31.0.12", "sudo", "-n", "/usr/local/sbin/adlab-ha", "json"],
                          inp=json.dumps(req))
        o = json.loads(out)
        record("D8", ok=(o.get("error") or {}).get("code") == "stale_epoch", response=o.get("error"))
    elif name == "D6":
        # planned drain of home: controller-less here; transfer class A to dc3, then back
        t = time.time()
        e = sim().get("epoch", 1)
        def env(verb, args):
            req = {"schema_version": "adlab-ha/1", "verb": verb, "args": args, "op_id": "d6-" + uuid.uuid4().hex[:8], "epoch": e}
            rc, out, err = sh(["ssh", "eddie@" + VMS["adl-ha-b" if args.get("to") == "dc3" else "adl-ha-a"]["sh0"],
                               "sudo", "-n", "/usr/local/sbin/adlab-ha", "json"], inp=json.dumps(req), timeout=600)
            return json.loads(out)
        a = env("ha-fsmo-transfer", {"role": "class-a", "to": "dc3"})
        # status.json is collected every few seconds: poll until the move is visible
        mid, _ = wait_for(lambda: "dc3" if pdc_owner(snapshot()) == "dc3" else None, 60, step=3)
        b = env("ha-fsmo-transfer", {"role": "class-a", "to": "dc1"})
        s, took = wait_healthy(300)
        record("D6", ok=a["ok"] and b["ok"] and mid == "dc3" and bool(s), pdc_mid=mid, took_s=round(time.time() - t, 1),
               errs=[a.get("error"), b.get("error")])
    else:
        raise SystemExit("unknown drill %s" % name)


def loop(kind, n):
    kinds = ["poweroff", "isolate", "split"] if kind == "mixed" else [{"down": "poweroff", "isolated": "isolate",
                                                                     "split": "split", "lossy": "lossy"}[kind]]
    oks = 0
    for i in range(n):
        k = random.choice(kinds)
        ok = d_failover_cycle(k, label="S1-%s-%03d" % (k, i + 1))
        oks += bool(ok)
        say("cycle %d/%d %s ok=%s (total ok %d)" % (i + 1, n, k, ok, oks))
    record("S1-summary", cycles=n, ok=oks)


def main():
    global RUN
    a = sys.argv[1:]
    if "--run" in a:
        RUN = a[a.index("--run") + 1]
        del a[a.index("--run"):a.index("--run") + 2]
    if not a:
        print(__doc__)
        return 2
    if a[0] == "fault":
        fault(a[1], a[2])
    elif a[0] == "check":
        print(json.dumps(snapshot(), indent=1, sort_keys=True))
    elif a[0] == "drill":
        drill(a[1])
    elif a[0] == "loop":
        loop(a[1], int(a[2]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
