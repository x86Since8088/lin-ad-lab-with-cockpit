#!/usr/bin/env python3
"""stress.py — the HA stress program (design §12) on the isolated testbed.

  stress.py S1 N          failover soak: N cycles (mixed down/isolated/split) under auth load
  stress.py S2 SECONDS    partition flapping (A's sh0 link, random 5 s–10 min), with witness,
                          then the same without the witness (controller stopped)
  stress.py S3            lease edge cases: heal just before / just after expiry+grace,
                          clock skew ±2 s on A, agent killed on the holder during a partition
  stress.py S4 USERS      cross-host write load (USERS users + USERS/5 groups + USERS/20
                          computers created on BOTH hosts in parallel), convergence time
  stress.py S5 N          SYSVOL churn: N GPO create/delete on the writer, failover in the middle
  stress.py S6 N          boot storms: N rounds of both VMs rebooting together (alternating order)
  stress.py S7            resource pressure on B (stress-ng 80 % CPU+mem) + a failover onto B
  stress.py S9 N          controller killed N times during a failover
  stress.py S10 N         classification accuracy: N randomized faults incl. 30 % lossy link
  stress.py report RUN    summary of a run's results + auth-load impact per cycle
Every row appends records to ~/.local/state/adl-ha/results/<run>.jsonl (drills.record).
"""
import json
import os
import random
import signal
import subprocess
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import importlib.util  # noqa: E402
_s = importlib.util.spec_from_file_location("drills", os.path.join(HERE, "drills.py"))
D = importlib.util.module_from_spec(_s)
_s.loader.exec_module(D)

SIM_CMD = [sys.executable, "-u", os.path.join(HERE, "ha-sim.py"), "run", "--timers", "stress"]


def now():
    return time.time()


def controller_pids():
    rc, out, err = D.sh(["pgrep", "-f", "python3 -u .*ha-sim.py run"])
    return [int(p) for p in out.split()]


def controller_stop():
    for p in controller_pids():
        os.kill(p, signal.SIGTERM)
    D.wait_for(lambda: not controller_pids() or None, 30, step=1)


def controller_start():
    if controller_pids():
        return
    log = open(os.path.expanduser("~/.local/state/adl-ha/ha-sim/controller.log"), "a")
    subprocess.Popen(SIM_CMD, stdout=log, stderr=log, cwd=HERE, start_new_session=True)
    D.wait_for(lambda: controller_pids() or None, 30, step=1)


def audit_events(vm, since, kinds):
    body = ("python3 - <<'P'\nimport json\nfor l in open('/var/lib/adlab/ha/audit.log'):\n"
            "    try: e=json.loads(l)\n    except ValueError: continue\n"
            "    if e['t']>=%f and e['event'] in %r: print(json.dumps(e))\nP\n" % (since, list(kinds)))
    rc, out, err = D.rootjob("adlha-audit-q", body, vm=vm)
    return [json.loads(l) for l in out.splitlines() if l.startswith("{")]


def two_writers(since):
    """Were two hosts ever serving SYSVOL at the same time? (serve/stop intervals per host)"""
    iv = {}
    for vm in D.VMS:
        cur = None
        spans = []
        for e in audit_events(vm, since, ("sysvol_serve", "sysvol_serve_stop", "agent_start")):
            if e["event"] == "sysvol_serve" and cur is None:
                cur = e["t"]
            elif e["event"] in ("sysvol_serve_stop", "agent_start") and cur is not None:
                spans.append((cur, e["t"]))
                cur = None
        if cur is not None:
            spans.append((cur, now()))
        iv[vm] = spans
    overlaps = [(a, b) for a in iv["adl-ha-a"] for b in iv["adl-ha-b"] if a[0] < b[1] and b[0] < a[1]]
    return overlaps, iv


def dbcheck(vm, dc):
    rc, out, err = D.rootjob("adlha-dbcheck", "podman exec %s samba-tool dbcheck --cross-ncs 2>&1 | tail -2\n" % dc, vm=vm, timeout=900)
    return "0 errors" in out or "Checked" in out and "error" not in out.lower().split("checked")[-1], out.strip()[-160:]


# ------------------------------------------------------------------ rows
def S1(n):
    D.loop("mixed", n)


def S2(seconds):
    for witness in (True, False):
        if not witness:
            controller_stop()
        t0 = now()
        cuts = 0
        writes = 0
        while now() - t0 < seconds:
            D.fault("split", "adl-ha-a")
            cuts += 1
            dwell = random.choice([5, 15, 30, 60, 120, 300, 600])
            end = now() + dwell
            while now() < end:
                # directory writes on BOTH sides during the partition
                for vm, dc in (("adl-ha-a", "dc2"), ("adl-ha-b", "dc4")):
                    nme = "s2-%d-%s" % (int(now() * 1000) % 10 ** 9, dc)
                    rc, out, err = D.dc_auth(vm, dc, "samba-tool user add %s 'Pw-%s-x9!' -H ldap://127.0.0.1" % (nme, uuid.uuid4().hex[:8]))
                    writes += "[exit 0]" in out
                time.sleep(min(10, max(0, end - now())))
            D.fault("heal", "adl-ha-a")
            time.sleep(random.choice([5, 30, 60, 180]))
        if not witness:
            controller_start()
        s, took = D.wait_healthy(1800)
        ov, spans = two_writers(t0)
        seizes = [e for e in D.events_since(t0) if e["event"] == "seize"]
        chk = {vm: dbcheck(vm, dc) for vm, dc in (("adl-ha-a", "dc1"), ("adl-ha-b", "dc3"))}
        D.record("S2-%s" % ("witness" if witness else "no-witness"), ok=bool(s) and not ov and not seizes and
                 all(v[0] for v in chk.values()), seconds=seconds, cuts=cuts, writes=writes, converged_after_s=took,
                 two_sysvol_writers=len(ov), seizes=len(seizes), dbcheck=chk)


def S3():
    T = D.sim().get("timers", {})
    ttl, grace = T.get("ttl_s", 20), T.get("grace_s", 30)
    # (a) heal 2 s BEFORE expiry+grace: no takeover;  (b) heal 5 s AFTER: exactly one takeover
    for label, dwell in (("before", ttl + grace - 8), ("after", ttl + grace + 25)):
        D.wait_healthy(900)
        t0 = now()
        D.fault("poweroff", "adl-ha-a")
        time.sleep(max(0, dwell))
        D.fault("poweron", "adl-ha-a")
        s, took = D.wait_healthy(1500)
        ev = D.events_since(t0)
        seizes = [e for e in ev if e["event"] == "seize"]
        expect = 0 if label == "before" else 1
        # "before": the controller cannot see A until it boots, so takeover may still start
        # once expiry+grace passes; what must never happen is a seize while A is reachable
        D.record("S3-heal-%s" % label, ok=bool(s) and (len(seizes) <= expect if label == "before" else len(seizes) == 1),
                 dwell_s=dwell, seizes=len(seizes), healthy_after_s=took)
    # (c) clock skew ±2 s on A (chrony stopped, clock stepped), during a split: self-fence still first
    for skew in (2, -2):
        D.wait_healthy(900)
        D.rootjob("adlha-skew", "systemctl stop chrony; date -s @$(( $(date +%%s) + %d )) >/dev/null; echo skewed\n" % skew, vm="adl-ha-a")
        t0 = now()
        D.fault("split", "adl-ha-a")
        D.wait_for(lambda: [e for e in D.events_since(t0) if e["event"] in ("failover_lease_only", "seize")], 300)
        a_fence = audit_events("adl-ha-a", t0 - 5, ("self_fence",))
        b_take = audit_events("adl-ha-b", t0 - 5, ("lease_change", "fsmo_seize", "placement_apply"))
        fence_t = min([e["t"] for e in a_fence] or [1e18])
        take_t = min([e["t"] for e in b_take if e["event"] != "lease_change" or e.get("host") == "adl-ha-b"] or [1e18])
        D.fault("heal", "adl-ha-a")
        D.rootjob("adlha-unskew", "systemctl start chrony; chronyc -a makestep >/dev/null; echo ok\n", vm="adl-ha-a")
        s, took = D.wait_healthy(1500)
        D.record("S3-skew%+d" % skew, ok=bool(s) and fence_t < take_t, fence_before_takeover_s=round(take_t - fence_t, 1),
                 healthy_after_s=took)
    # (d) agent killed on the holder during a split: B must still never pull from A's stale writer
    D.wait_healthy(900)
    t0 = now()
    D.rootjob("adlha-killagent", "systemctl kill -s KILL adlab-ha-agent; systemctl stop adlab-ha-agent; echo killed\n", vm="adl-ha-a")
    D.fault("split", "adl-ha-a")
    time.sleep(150)
    pulls_from_a = [e for e in audit_events("adl-ha-b", t0, ("sysvol_writer_prepare", "sysvol_writer_commit"))]
    st = (D.ha("adl-ha-b", "ha-status") or {}).get("result") or {}
    froze = (st.get("sysvol_last") or {}).get("action") == "freeze" or (st.get("sysvol_last") or {}).get("writer", {}).get("host") != "adl-ha-a"
    D.fault("heal", "adl-ha-a")
    D.rootjob("adlha-startagent", "systemctl start adlab-ha-agent; echo started\n", vm="adl-ha-a")
    s, took = D.wait_healthy(1500)
    D.record("S3-agent-killed", ok=bool(s) and froze and not pulls_from_a, b_froze_or_moved=froze, healthy_after_s=took)


def S4(users):
    groups, comps = users // 5, users // 20
    t0 = now()
    procs = []
    for vm, dc, tag in (("adl-ha-a", "dc2", "a"), ("adl-ha-b", "dc4", "b")):
        body = ("cat > /tmp/s4-%s.ldif <<'L'\n" % tag)
        lines = []
        for i in range(users):
            lines.append("dn: CN=s4%s-u%05d,CN=Users,DC=ha,DC=test,DC=lab\nobjectClass: user\nsAMAccountName: s4%su%05d\n" % (tag, i, tag, i))
        for i in range(groups):
            lines.append("dn: CN=s4%s-g%05d,CN=Users,DC=ha,DC=test,DC=lab\nobjectClass: group\nsAMAccountName: s4%sg%05d\n" % (tag, i, tag, i))
        for i in range(comps):
            lines.append("dn: CN=S4%sC%04d,CN=Computers,DC=ha,DC=test,DC=lab\nobjectClass: computer\nsAMAccountName: S4%sC%04d$\nuserAccountControl: 4096\n" % (tag.upper(), i, tag.upper(), i))
        body += "\n".join(lines) + "L\n"
        body += ("t=$(date +%%s); podman cp /tmp/s4-%s.ldif %s:/tmp/s4.ldif && podman exec %s ldbadd -H /var/lib/samba/private/sam.ldb /tmp/s4.ldif 2>&1 | tail -1; "
                 "echo took $(( $(date +%%s)-t ))s\n" % (tag, dc, dc))
        procs.append(subprocess.Popen([D.RJ, "-t", "7200", "-M", vm, "adlha-s4-" + tag], stdin=subprocess.PIPE,
                                      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True))
        procs[-1].stdin.write(body)
        procs[-1].stdin.close()
    outs = [p.communicate(timeout=7300)[0] for p in procs]
    t_written = now()
    want = 2 * (users + groups + comps)

    def counted():
        rc, out, err = D.rootjob("adlha-s4-count", "podman exec dc1 ldbsearch -H /var/lib/samba/private/sam.ldb "
                                 "'(|(sAMAccountName=s4a*)(sAMAccountName=s4b*)(sAMAccountName=S4A*)(sAMAccountName=S4B*))' dn 2>/dev/null | grep -c '^dn:'\n", vm="adl-ha-a")
        try:
            return int([l for l in out.splitlines() if l.strip().isdigit()][0])
        except IndexError:
            return 0
    got, t_conv = D.wait_for(lambda: (lambda c: c if c >= want else None)(counted()), 7200, step=30)
    s = D.snapshot()
    fails = sum(x["fails"] for x in s["dcs"].values())
    D.record("S4", ok=bool(got) and fails == 0, users=users, groups=groups, computers=comps, objects_expected=want,
             objects_on_dc1=got or counted(), write_s=round(t_written - t0, 1), converged_after_write_s=t_conv,
             repl_failures=fails, writer_out=[o.strip()[-120:] for o in outs])


def S5(n):
    D.wait_healthy(900)
    t0 = now()
    made, deleted = 0, 0
    half = n // 2
    for i in range(n):
        if i == half:
            # failover in the middle: power A off; the writer moves to dc3; churn continues there
            D.fault("poweroff", "adl-ha-a")
            D.wait_for(lambda: [e for e in D.events_since(t0) if e["event"] == "placement_apply" and e.get("holder") == "adl-ha-b"], 600)
        vm, dc = ("adl-ha-a", "dc1") if i < half else ("adl-ha-b", "dc3")
        nm = "s5-%03d" % i
        ok, out = D.gpo_create(vm, dc, nm)
        made += ok
        if ok and i % 2 == 0:
            rc, o2, e2 = D.rootjob("adlha-s5-del", "g=$(podman exec %s samba-tool gpo listall 2>/dev/null | grep -B1 'display name *: *%s$' | awk '/^GPO/{print $3}'); "
                                   "podman exec %s sh -c \"umask 077; f=\\$(mktemp); printf 'username=Administrator\\npassword=%%s\\ndomain=HATEST\\n' \\\"\\$(cat /run/adminpass)\\\" > \\$f; samba-tool gpo del $g -H ldap://127.0.0.1 -A \\$f >/dev/null 2>&1; echo rc=\\$?; rm -f \\$f\"\n" % (dc, nm, dc), vm=vm)
            deleted += "rc=0" in o2
    D.fault("poweron", "adl-ha-a")
    s, took = D.wait_healthy(1800)
    time.sleep(130)       # two SYSVOL cycles
    fin = D.snapshot()
    hashes = sorted({x["sv"] for x in fin["dcs"].values()})
    rc, out, err = D.rootjob("adlha-s5-check", "podman exec dc1 samba-tool ntacl sysvolcheck >/dev/null 2>&1 && echo sysvolcheck-ok; "
                             "a=$(podman exec dc1 samba-tool gpo listall 2>/dev/null | grep -c '^GPO'); "
                             "b=$(ls /opt/adl-forest/state/dc1/var-lib-samba/sysvol/ha.test.lab/Policies | grep -c '{'); echo gpos=$a dirs=$b\n", vm="adl-ha-a")
    import re
    m = re.search(r"gpos=(\d+) dirs=(\d+)", out)
    D.record("S5", ok=bool(s) and len(hashes) == 1 and "sysvolcheck-ok" in out and bool(m) and m.group(1) == m.group(2),
             created=made, deleted=deleted, sysvol_hashes=hashes, sysvolcheck="sysvolcheck-ok" in out,
             gpos_vs_dirs=(m.groups() if m else None), healthy_after_s=took)


def S6(n):
    for i in range(n):
        D.wait_healthy(1200)
        t0 = now()
        first, second = (("adl-ha-a", "adl-ha-b") if i % 2 == 0 else ("adl-ha-b", "adl-ha-a"))
        D.fault("reboot", first)
        time.sleep(random.choice([0, 3, 10]))
        D.fault("reboot", second)
        time.sleep(20)
        s, took = D.wait_healthy(1800)
        ev = D.events_since(t0)
        bad = [e for e in ev if e["event"] in ("seize", "seize_class_b")]
        held = audit_events("adl-ha-a", t0, ("dc_held",))
        D.record("S6-%02d" % (i + 1), ok=bool(s) and not bad, first=first, healthy_after_s=took, seizes=len(bad),
                 dc1_held_at_boot=bool(held))


def S7():
    D.wait_healthy(900)
    D.rootjob("adlha-s7-on", "command -v stress-ng >/dev/null || DEBIAN_FRONTEND=noninteractive apt-get install -y -q stress-ng >/dev/null; "
              "systemd-run --unit adl-s7-stress --collect stress-ng --cpu 4 --cpu-load 80 --vm 2 --vm-bytes 40%% --timeout 1800s >/dev/null; echo on\n", vm="adl-ha-b")
    t0 = now()
    ok = D.d_failover_cycle("poweroff", label="S7-cycle")
    D.rootjob("adlha-s7-off", "systemctl stop adl-s7-stress 2>/dev/null; dmesg | grep -ci 'out of memory' ; echo off\n", vm="adl-ha-b")
    rc, out, err = D.sh([os.path.join(HERE, "tb-load.sh"), "report", str(int(t0)), str(int(now()))])
    import re
    p99 = [int(x) for x in re.findall(r"dc3 \w+ p50=\d+ms p99=(\d+)ms", out)]
    D.record("S7", ok=ok and p99 and max(p99) < 500, failover_ok=ok, dc3_p99_ms=p99, load_report=out.strip()[-600:])


def S9(n):
    for i in range(n):
        D.wait_healthy(1200)
        t0 = now()
        D.fault("poweroff", "adl-ha-a")
        # kill the controller right as it starts acting (classify), restart it 5–20 s later
        D.wait_for(lambda: [e for e in D.events_since(t0) if e["event"] in ("classify", "seize")], 400, step=1)
        controller_stop()
        time.sleep(random.randint(5, 20))
        controller_start()
        D.wait_for(lambda: [e for e in D.events_since(t0) if e["event"] == "placement_apply" and e.get("holder") == "adl-ha-b"], 600)
        D.fault("poweron", "adl-ha-a")
        s, took = D.wait_healthy(1800)
        seizes = [e for e in D.events_since(t0) if e["event"] == "seize" and e.get("ok")]
        D.record("S9-%02d" % (i + 1), ok=bool(s) and len(seizes) <= 1, seizes_ok=len(seizes), healthy_after_s=took)


def S10(n):
    kinds = ["poweroff", "isolate", "split", "lossy"]
    right = 0
    for i in range(n):
        k = random.choice(kinds)
        ok = D.d_failover_cycle(k, gpo=False, label="S10-%s-%03d" % (k, i + 1))
        right += ok
    D.record("S10-summary", runs=n, ok=right == n, correct=right)


def report(run):
    rows = [json.loads(l) for l in open(os.path.join(D.RESULTS, run + ".jsonl"))]
    for r in rows:
        print(r["ts"], r["kind"], "ok=%s" % r.get("ok"))
    print("total %d, ok %d" % (len(rows), sum(1 for r in rows if r.get("ok"))))


def main():
    a = sys.argv[1:]
    if "--run" in a:
        D.RUN = a[a.index("--run") + 1]
        del a[a.index("--run"):a.index("--run") + 2]
    fn = {"S1": lambda: S1(int(a[1])), "S2": lambda: S2(int(a[1])), "S3": S3, "S4": lambda: S4(int(a[1])),
          "S5": lambda: S5(int(a[1])), "S6": lambda: S6(int(a[1])), "S7": S7, "S9": lambda: S9(int(a[1])),
          "S10": lambda: S10(int(a[1])), "report": lambda: report(a[1])}
    fn[a[0]]()


if __name__ == "__main__":
    main()
