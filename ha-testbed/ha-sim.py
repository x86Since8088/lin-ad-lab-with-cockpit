#!/usr/bin/env python3
"""ha-sim — the testbed's stand-in for edy's HA controller (design §5, §7.3 v1.1).

It drives the two testbed hosts through the real adlab-ha/1 contract (ssh eddie@<sh0>
sudo -n adlab-ha json) and implements the controller side: writer lease renewal, the
§5.4 state machine, per-failure-domain votes, the down/isolated/split/unknown
classifier, class-A failover, lease-only failover on split, and the 6-step failback.

Failure domains (votes): A, B and the WITNESS (this controller on edt1). Reports used to
classify (not votes): libvirt + guest agent = the lost host's own host; a LAN-path probe
(lab0) = its clients; the survivor's peer-reachability report. Management (leases, verbs)
runs over the shared subnet sh0, so cutting a host's sh0 link isolates it from the
controller and the peer while its clients may still reach it (split).

  ha-sim.py run [--timers stress|prod]   controller loop (events -> state/ha-sim/events.jsonl)
  ha-sim.py state                        one-screen state
  ha-sim.py attest HOST ACTOR REASON     operator attestation (upgrades unknown -> down)
"""
import json
import os
import subprocess
import sys
import time
import uuid

HERE = os.path.dirname(os.path.abspath(__file__))
STATE = os.environ.get("HA_SIM_STATE", os.path.expanduser("~/.local/state/adl-ha/ha-sim"))
HOSTS = {"adl-ha-a": {"sh0": "10.31.0.11", "lan": "192.168.2.41", "dcs": ["dc1", "dc2"], "pdc_home": "dc1"},
         "adl-ha-b": {"sh0": "10.31.0.12", "lan": "192.168.2.42", "dcs": ["dc3", "dc4"], "pdc_home": "dc3"}}
HOME, STANDBY = "adl-ha-a", "adl-ha-b"
TIMERS = {"prod": {"ttl_s": 60, "renew_s": 15, "grace_s": 300, "hold_s": 1800, "sysvol_s": 300, "collect_s": 15,
                   "attest_max_s": 3600},
          # same ratios, scaled so stress cycles take minutes (design §12)
          "stress": {"ttl_s": 20, "renew_s": 5, "grace_s": 30, "hold_s": 90, "sysvol_s": 60, "collect_s": 5,
                     "attest_max_s": 600}}


def now():
    return time.time()


def log(event, **kw):
    os.makedirs(STATE, exist_ok=True)
    rec = {"t": round(now(), 3), "ts": time.strftime("%H:%M:%S"), "event": event}
    rec.update(kw)
    with open(os.path.join(STATE, "events.jsonl"), "a") as f:
        f.write(json.dumps(rec, sort_keys=True) + "\n")
    print("%s %-22s %s" % (rec["ts"], event, json.dumps(kw, sort_keys=True)[:220]), flush=True)


def save(st):
    os.makedirs(STATE, exist_ok=True)
    p = os.path.join(STATE, "state.json")
    with open(p + ".tmp", "w") as f:
        json.dump(st, f, indent=1, sort_keys=True)
    os.replace(p + ".tmp", p)


def load():
    try:
        return json.load(open(os.path.join(STATE, "state.json")))
    except (OSError, ValueError):
        return None


# ---------------------------------------------------------------- channels
def call(host, verb, args=None, epoch=None, timeout=60):
    req = {"schema_version": "adlab-ha/1", "verb": verb, "args": args or {}, "op_id": "sim-" + uuid.uuid4().hex[:20]}
    if epoch is not None:
        req["epoch"] = epoch
    try:
        p = subprocess.run(["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "ServerAliveInterval=3",
                            "-o", "ServerAliveCountMax=2", "eddie@" + HOSTS[host]["sh0"],
                            "sudo", "-n", "/usr/local/sbin/adlab-ha", "json"],
                           input=json.dumps(req), capture_output=True, text=True, timeout=timeout)
        return json.loads(p.stdout) if p.stdout.strip() else {"ok": False, "error": {"code": "unreachable", "message": p.stderr.strip()[:200]}}
    except (subprocess.TimeoutExpired, ValueError) as ex:
        return {"ok": False, "error": {"code": "unreachable", "message": str(ex)[:200]}}


def tcp(ip, port=22, timeout=2):
    import socket
    try:
        with socket.create_connection((ip, port), timeout=timeout):
            return True
    except OSError:
        return False


def virsh(*a, timeout=15):
    p = subprocess.run(["virsh", "-q", "-c", "qemu:///system"] + list(a), capture_output=True, text=True, timeout=timeout)
    return p.returncode, p.stdout.strip()


def own_host_report(host):
    """The lost host's OWN host: libvirt state + guest agent (no network needed)."""
    rc, st = virsh("domstate", host)
    if st != "running":
        return {"running": False, "agent": False}
    rc2, out = virsh("qemu-agent-command", host, '{"execute":"guest-ping"}', timeout=10)
    return {"running": True, "agent": rc2 == 0}


# ---------------------------------------------------------------- controller
class Sim:
    def __init__(self, timers):
        self.T = timers
        st = load()
        if st and st.get("timers") == timers:
            self.st = st
        else:
            self.st = {"epoch": 0, "holder": HOME, "mode": "init", "placement": None, "seen": {}, "timers": timers,
                       "lost_since": None, "healthy_since": None, "attest": {}, "lease_expires": 0,
                       "lease_epoch": 0, "history": []}

    # -- placement
    def placement(self, holder, writer_dc, rebuild=None):
        return {"forest": "HA.TEST.LAB", "timers": self.T,
                "hosts": {h: {"site": "Default-First-Site-Name" if h == HOME else "adl-ha-b",
                              "priority": 100 if h == HOME else 10, "dcs": v["dcs"]} for h, v in HOSTS.items()},
                "fsmo_home": {"pdc": "dc1", "rid": "dc1", "schema": "dc1", "naming": "dc1",
                              "infrastructure": "dc1", "domaindns": "dc1", "forestdns": "dc1"},
                "fsmo_standby": "dc3",
                "sysvol_writer": {"dc": writer_dc, "host": [h for h, v in HOSTS.items() if writer_dc in v["dcs"]][0]},
                "rebuild": rebuild or {}}

    def lease(self, holder):
        exp = now() + self.T["ttl_s"]
        self.st["lease_expires"] = exp
        return {"host": holder, "epoch": self.st["epoch"], "expires_at": exp, "ttl_s": self.T["ttl_s"]}

    def apply_placement(self, holder, writer_dc, hosts=None, rebuild=None):
        self.st["epoch"] += 1
        self.st["holder"] = holder
        doc = self.placement(holder, writer_dc, rebuild)
        self.st["placement"] = doc
        L = self.lease(holder)
        res = {}
        self.st["placement_hosts"] = {}
        for h in hosts or HOSTS:
            r = call(h, "ha-placement-apply", {"placement": doc, "lease": L}, epoch=self.st["epoch"])
            res[h] = r.get("ok"), (r.get("error") or {}).get("message")
            if r.get("ok"):
                self.st["placement_hosts"][h] = self.st["epoch"]
        log("placement_apply", epoch=self.st["epoch"], holder=holder, writer=writer_dc, results=res)
        save(self.st)
        return res

    def renew(self, reachable):
        L = self.lease(self.st["holder"])
        for h in reachable:
            r = call(h, "ha-lease-renew", {"lease": L}, timeout=15)
            if not r.get("ok"):
                log("renew_refused", host=h, err=r.get("error"))
            # a host that comes back behind gets the current placement (same epoch, identical doc)
            ph = ((self.st.get("placement_hosts") or {}).get(h))
            if self.st.get("placement") and ph != self.st["epoch"]:
                r2 = call(h, "ha-placement-apply", {"placement": self.st["placement"], "lease": L}, epoch=self.st["epoch"])
                if r2.get("ok"):
                    self.st.setdefault("placement_hosts", {})[h] = self.st["epoch"]
                log("placement_resend", host=h, epoch=self.st["epoch"], ok=r2.get("ok"), err=r2.get("error"))
        save(self.st)

    # -- observation
    def poll(self):
        out = {}
        for h in HOSTS:
            r = call(h, "ha-status", timeout=15)
            out[h] = r.get("result") if r.get("ok") else None
            if out[h]:
                self.st["seen"][h] = now()
        return out

    def classify(self, lost, survivor_status):
        own = own_host_report(lost)
        lan = tcp(HOSTS[lost]["lan"], 22)
        ctrl = tcp(HOSTS[lost]["sh0"], 22)
        surv = ((survivor_status or {}).get("peer_reach") or {}).get(lost, {})
        surv_reach = bool(surv.get("sh0_tcp_8444") or surv.get("dc_ldap"))
        ev = {"own_host": own, "lan_reports_alive": lan, "witness_reaches": ctrl, "survivor_reaches": surv_reach}
        if not own["running"]:
            cls = "down"
        elif not (lan or ctrl or surv_reach) and own["agent"]:
            cls = "isolated"
        elif lan and not ctrl and not surv_reach:
            cls = "split"
        elif not own["agent"] and not (lan or ctrl or surv_reach):
            cls = "unknown"
        else:
            cls = "unknown"
        return cls, ev

    def quorum_for(self, survivor, statuses):
        """Votes per failure domain: the survivor itself, the witness (us, if we reach the
        survivor), the lost host (it votes for itself only if we can hear it: we cannot)."""
        votes = 1 + (1 if statuses.get(survivor) else 0)
        return votes >= 2, votes

    # -- actions
    def failover(self, lost, survivor, cls, ev, attestation=None):
        old = {"host": lost, "epoch": self.st["lease_epoch"] or self.st["epoch"],
               "expires_at": self.st["lease_expires"]}
        new_epoch = self.st["epoch"] + 1
        if cls == "split":
            log("failover_lease_only", lost=lost, to=survivor, classification=cls, evidence=ev)
            self.st["epoch"] = new_epoch - 1
            self.apply_placement(survivor, self.st["placement"]["sysvol_writer"]["dc"], hosts=[survivor])
            self.st["mode"] = "degraded-split"
            self.st["failed_from"] = lost
            return
        to = HOSTS[survivor]["pdc_home"]
        proof = {"lease": old, "takeover": "attestation" if attestation else "quorum",
                 "classification": cls if not attestation else ("down" if cls == "unknown" else cls),
                 "evidence": ev}
        if attestation:
            proof["attestation_id"] = attestation
        t0 = now()
        r = call(survivor, "ha-fsmo-seize", {"role": "class-a", "to": to, "lease_proof": proof,
                                             "actor": "ha-sim", "reason": "failover %s" % cls}, epoch=new_epoch, timeout=600)
        log("seize", to=to, ok=r.get("ok"), err=r.get("error"), took_s=round(now() - t0, 1),
            seized=(r.get("result") or {}).get("seized"))
        if not r.get("ok"):
            return False
        self.st["epoch"] = new_epoch - 1
        self.apply_placement(survivor, to, hosts=[survivor])
        self.st["mode"] = "degraded"
        self.st["failed_from"] = lost
        return True

    def failback(self, home, away):
        """design §7.3 v1.1 #9: prepare -> fence away -> transfer -> commit -> placement -> unfence."""
        e = self.st["epoch"]
        home_dc = HOSTS[home]["pdc_home"]
        steps = [("prepare", home, "ha-sysvol-writer", {"dc": home_dc, "phase": "prepare"}),
                 ("fence", away, "ha-fence", {"reason": "failback"}),
                 ("transfer", home, "ha-fsmo-transfer", {"role": "class-a", "to": home_dc}),
                 ("commit", home, "ha-sysvol-writer", {"dc": home_dc, "phase": "commit"})]
        if self.st["mode"] == "degraded-split":
            steps = [s for s in steps if s[0] not in ("transfer",)]
        old_writer = (self.st.get("placement") or {}).get("sysvol_writer", {})
        for name, h, verb, args in steps:
            t0 = now()
            r = call(h, verb, args, epoch=e, timeout=600)
            res = r.get("result") or {}
            log("failback_" + name, host=h, ok=r.get("ok"), err=r.get("error"), took_s=round(now() - t0, 1),
                pulled_from=res.get("pulled_from"), hash=(res.get("hash") or "")[:12])
            if r.get("ok") and name in ("prepare", "commit") and old_writer.get("dc") != home_dc:
                if res.get("already_writer") or not res.get("pulled_from"):
                    log("failback_refused", step=name, why="no pull from the outage writer %s" % old_writer)
                    return False
            if r.get("ok") and name == "commit" and old_writer.get("dc") != home_dc:
                ws = call(old_writer["host"], "ha-status", timeout=15).get("result") or {}
                wh = [d["sysvol_hash"] for d in ws.get("dcs", []) if d["name"] == old_writer["dc"]]
                if not wh or wh[0] != res.get("hash"):
                    log("failback_refused", step="commit", why="SYSVOL of %s != outage writer %s" % (home_dc, old_writer["dc"]),
                        new=(res.get("hash") or "")[:12], old=(wh[0] if wh else "?")[:12])
                    return False
            if not r.get("ok"):
                if name in ("prepare", "fence"):
                    return False          # repeatable: retry next tick
                log("failback_stalled", step=name)   # after transfer: roll forward only
                return False
        self.apply_placement(home, home_dc)
        r = call(away, "ha-unfence", {}, epoch=self.st["epoch"])
        log("failback_unfence", host=away, ok=r.get("ok"))
        self.st["mode"] = "healthy"
        self.st.pop("failed_from", None)
        return True

    # -- loop
    def tick(self):
        T = self.T
        statuses = self.poll()
        reach = [h for h, s in statuses.items() if s]
        mode = self.st["mode"]
        holder = self.st["holder"]
        if mode == "init":
            if len(reach) == len(HOSTS):
                self.st["epoch"] = max([s.get("epoch", 0) for s in statuses.values()] + [self.st["epoch"]])
                self.apply_placement(HOME, HOSTS[HOME]["pdc_home"])
                self.st["mode"] = "healthy"
            return
        if holder in reach:
            self.st["lost_since"] = None
            self.renew(reach)
        else:
            # holder lost: keep renewing to the others with the OLD holder (they learn nothing new)
            if not self.st["lost_since"]:
                self.st["lost_since"] = now()
                self.st["lease_epoch"] = self.st["epoch"]
                log("holder_lost", holder=holder)
            survivor = [h for h in HOSTS if h != holder][0]
            expired_for = now() - self.st["lease_expires"]
            fresh = (statuses.get(survivor) or {}).get("collected_at", 0) > self.st["lost_since"]
            if expired_for > T["grace_s"] and survivor in reach and mode in ("healthy",) and fresh:
                cls, ev = self.classify(holder, statuses.get(survivor))
                ok, votes = self.quorum_for(survivor, statuses)
                att = None
                for aid, a in self.st.get("attest", {}).items():
                    if a["host"] == holder and not a.get("used") and now() < a["expires"]:
                        att = aid
                if cls == "unknown" and att:
                    for h in [survivor]:
                        call(h, "ha-attest-host-dead", {"host": holder, "host_name": holder, "actor": self.st["attest"][att]["actor"],
                                                        "reason": self.st["attest"][att]["reason"], "attestation_id": att},
                             epoch=self.st["epoch"])
                log("classify", lost=holder, classification=cls, quorum=ok, votes=votes, evidence=ev)
                if cls in ("down", "isolated", "split") and ok:
                    self.failover(holder, survivor, cls, ev)
                elif cls == "unknown" and att:
                    if self.failover(holder, survivor, cls, ev, attestation=att):
                        self.st["attest"][att]["used"] = True
            # NO renewals while the holder is lost: the survivors' own lease record must lapse
        # failback with hysteresis
        if self.st["mode"] in ("degraded", "degraded-split"):
            home = self.st["failed_from"]
            s = statuses.get(home)
            away = statuses.get(self.st["holder"]) or {}
            away_pdc = [d["name"] for d in away.get("dcs", []) if "pdc" in d["roles"]]
            home_view_pdc = [d["name"] for d in (s or {}).get("dcs", []) if "pdc" in d["roles"]]
            converged = self.st["mode"] == "degraded-split" or (away_pdc and not home_view_pdc)
            healthy = bool(s) and converged and all(
                d["state"] == "running" and sum(r["failures"] for r in d["replication"]) == 0 for d in s["dcs"])
            if healthy:
                self.st["healthy_since"] = self.st.get("healthy_since") or now()
                if now() - self.st["healthy_since"] >= T["hold_s"]:
                    log("failback_start", home=home)
                    if self.failback(home, self.st["holder"]):
                        self.st["healthy_since"] = None
            else:
                self.st["healthy_since"] = None
        save(self.st)

    def run(self):
        log("controller_start", timers=self.T, mode=self.st["mode"], epoch=self.st["epoch"])
        while True:
            t0 = now()
            try:
                self.tick()
            except Exception as ex:
                log("tick_error", err=str(ex)[:300])
            time.sleep(max(0.5, self.T["renew_s"] - (now() - t0)))


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    if cmd == "run":
        prof = "stress"
        if "--timers" in sys.argv:
            prof = sys.argv[sys.argv.index("--timers") + 1]
        Sim(TIMERS[prof]).run()
    elif cmd == "state":
        print(json.dumps(load(), indent=1, sort_keys=True))
    elif cmd == "attest":
        host, actor, reason = sys.argv[2], sys.argv[3], " ".join(sys.argv[4:])
        st = load()
        aid = "att-" + uuid.uuid4().hex[:12]
        st.setdefault("attest", {})[aid] = {"host": host, "actor": actor, "reason": reason,
                                            "expires": now() + st["timers"]["attest_max_s"]}
        save(st)
        log("attestation_recorded", id=aid, host=host, actor=actor)
        print(aid)
    else:
        print(__doc__)
        return 2


if __name__ == "__main__":
    sys.exit(main())
