#!/usr/bin/env python3
"""Unit tests for adlab-ha's safety rules (design §5, §7.3 v1.1). No podman, no root:
DC access is faked, state lives in a temp dir. The drills on the testbed exercise the
same code against real DCs; these pin the rules so a refactor cannot loosen them."""
import importlib.machinery
import importlib.util
import json
import os
import tempfile
import time
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
_tmp = tempfile.mkdtemp(prefix="adlab-ha-test-")
os.environ["ADLAB_HA_STATE"] = os.path.join(_tmp, "state")
os.environ["ADLAB_HA_CONF"] = os.path.join(_tmp, "host.json")
with open(os.environ["ADLAB_HA_CONF"], "w") as f:
    json.dump({"host_id": "adl-ha-b", "host_name": "adl-ha-b", "sh0_ip": "10.31.0.12", "realm": "HA.TEST.LAB",
               "domain_nb": "HATEST", "dcs": {"dc3": {"ip": "10.31.0.33", "state_dir": _tmp + "/dc3"}},
               "all_dcs": {"dc1": "10.31.0.17", "dc3": "10.31.0.33"}, "dc_host": {"dc1": "adl-ha-a", "dc3": "adl-ha-b"},
               "peer_hosts": {"adl-ha-a": "10.31.0.11"}}, f)
loader = importlib.machinery.SourceFileLoader("adlab_ha", os.path.join(HERE, "..", "adlab-ha"))
spec = importlib.util.spec_from_loader("adlab_ha", loader)
ha = importlib.util.module_from_spec(spec)
loader.exec_module(ha)


_REAL_GETEUID = os.geteuid


class Base(unittest.TestCase):
    def tearDown(self):
        os.geteuid = _REAL_GETEUID      # never leak a fake euid into other test modules

    def setUp(self):
        import shutil
        shutil.rmtree(ha.STATE, ignore_errors=True)
        os.makedirs(ha.STATE)
        self.calls = []
        self.alive = False
        self.owners = {"pdc": "dc1", "infrastructure": "dc1", "domaindns": "dc1", "forestdns": "dc1",
                       "rid": "dc1", "schema": "dc1", "naming": "dc1"}
        ha.container_state = lambda dc: "running"
        ha.fsmo_owners = lambda dc: dict(self.owners)
        ha.ldap_alive = lambda frm, ip, timeout=5: self.alive

        def fake_auth(dc, cmd, timeout=120):
            self.calls.append(cmd)
            return 0, "", ""
        ha.dc_auth_exec = fake_auth
        os.geteuid = lambda: 0

    def env(self, verb, args=None, epoch=None, op_id=None):
        r = {"schema_version": "adlab-ha/1", "verb": verb, "args": args or {}}
        if epoch is not None:
            r["epoch"] = epoch
        r["op_id"] = op_id or ("t-%d" % (time.time_ns() % 10 ** 12))
        return ha.handle(r)

    def place(self, e, writer="dc1", holder="adl-ha-a", expires=None):
        L = {"host": holder, "epoch": e, "expires_at": expires if expires is not None else time.time() + 60, "ttl_s": 60}
        return self.env("ha-placement-apply", {"placement": {"sysvol_writer": {"dc": writer, "host": holder}},
                                                "lease": L}, epoch=e)


class TestEpochs(Base):
    def test_renew_never_moves_epoch(self):
        self.assertTrue(self.place(3)["ok"])
        r = self.env("ha-lease-renew", {"lease": {"host": "adl-ha-b", "epoch": 4, "expires_at": time.time() + 60}})
        self.assertTrue(r["ok"])
        self.assertEqual(ha.epoch(), 3)                     # the D2 bug: a renew raised it
        self.assertTrue(self.place(4, writer="dc3", holder="adl-ha-b")["ok"])   # so epoch 4's placement still lands

    def test_equal_epoch_needs_identical_document(self):
        self.assertTrue(self.place(5)["ok"])
        self.assertTrue(self.place(5)["ok"])                 # identical doc: accepted (re-send)
        r = self.place(5, writer="dc3")
        self.assertEqual(r["error"]["code"], "stale_epoch")  # same epoch, different doc: two controllers

    def test_lower_epoch_refused(self):
        self.place(6)
        self.assertEqual(self.place(5)["error"]["code"], "stale_epoch")
        r = self.env("ha-fence", {"reason": "x"}, epoch=5)
        self.assertEqual(r["error"]["code"], "stale_epoch")

    def test_op_id_replay(self):
        self.place(1)
        a = self.env("ha-fence", {"reason": "x"}, epoch=1, op_id="same-op")
        b = self.env("ha-fence", {"reason": "x"}, epoch=1, op_id="same-op")
        self.assertTrue(a["ok"])
        self.assertTrue(b["replayed"])

    def test_mutating_needs_epoch_and_op_id_and_root(self):
        r = ha.handle({"schema_version": "adlab-ha/1", "verb": "ha-fence", "args": {}})
        self.assertEqual(r["error"]["code"], "refused")
        os.geteuid = lambda: 1000
        r = self.env("ha-fence", {}, epoch=1)
        self.assertIn("requires root", r["error"]["message"])
        self.assertTrue(self.env("ha-rejoin-check")["ok"])   # a read is fine as non-root

    def test_unknown_schema(self):
        r = ha.handle({"schema_version": "adlab-ha/2", "verb": "ha-status"})
        self.assertEqual(r["error"]["code"], "unsupported_schema")


class TestSeize(Base):
    def proof(self, cls="down", **kw):
        p = {"lease": {"host": "adl-ha-a", "epoch": 2}, "takeover": "quorum", "classification": cls}
        p.update(kw)
        return p

    def expired_lease_on_record(self):
        self.place(2, holder="adl-ha-a", expires=time.time() - 1000)   # A's lease, long expired here

    def seize(self, role="class-a", proof=None, **extra):
        a = {"role": role, "to": "dc3", "lease_proof": proof or self.proof()}
        a.update(extra)
        return self.env("ha-fsmo-seize", a, epoch=3)

    def test_happy_class_a(self):
        self.expired_lease_on_record()
        r = self.seize()
        self.assertTrue(r["ok"], r)
        self.assertEqual(len([c for c in self.calls if "fsmo seize" in c]), 4)

    def test_split_never_seizes(self):
        self.expired_lease_on_record()
        r = self.seize(proof=self.proof("split"))
        self.assertIn("split", r["error"]["message"])
        self.assertEqual(self.calls, [])

    def test_unknown_needs_attestation(self):
        self.expired_lease_on_record()
        self.assertFalse(self.seize(proof=self.proof("unknown"))["ok"])

    def test_before_expiry_plus_grace(self):
        self.place(2, holder="adl-ha-a", expires=time.time() - 5)      # expired, but inside the grace
        r = self.seize()
        self.assertIn("grace", r["error"]["message"])
        self.assertTrue(r["error"]["retryable"])

    def test_proof_must_match_local_record(self):
        self.expired_lease_on_record()
        r = self.seize(proof=dict(self.proof(), lease={"host": "adl-ha-a", "epoch": 1}))
        self.assertIn("does not match", r["error"]["message"])

    def test_holder_alive_refused(self):
        self.expired_lease_on_record()
        self.alive = True
        r = self.seize()
        self.assertIn("holder alive", r["error"]["message"])
        self.assertEqual(self.calls, [])

    def test_class_b_needs_all_flags(self):
        self.expired_lease_on_record()
        self.assertFalse(self.seize(role="rid")["ok"])
        self.assertFalse(self.seize(role="rid", class_b=True, i_understand=True)["ok"])   # no actor/reason
        r = self.seize(role="rid", class_b=True, i_understand=True, actor="op", reason="host gone for good")
        self.assertTrue(r["ok"], r)

    def test_attestation_never_for_class_b(self):
        self.expired_lease_on_record()
        self.env("ha-attest-host-dead", {"host": "adl-ha-a", "actor": "op", "reason": "dead",
                                         "attestation_id": "att-1"}, epoch=2)
        r = self.seize(role="rid", class_b=True, i_understand=True, actor="op", reason="r",
                       proof=self.proof("unknown", attestation_id="att-1", takeover="attestation"))
        self.assertIn("never authorises a class-B", r["error"]["message"])

    def test_attestation_bound_to_one_epoch(self):
        self.expired_lease_on_record()
        self.env("ha-attest-host-dead", {"host": "adl-ha-a", "actor": "op", "reason": "dead",
                                         "attestation_id": "att-2"}, epoch=2)
        p = self.proof("unknown", attestation_id="att-2", takeover="attestation")
        self.assertTrue(self.seize(proof=p)["ok"])
        r = self.env("ha-fsmo-seize", {"role": "pdc", "to": "dc3", "lease_proof": p}, epoch=4)
        self.assertIn("bound to epoch", r["error"]["message"])


class TestWriterAndFence(Base):
    def test_sysvol_writer_refuses_when_placement_behind(self):
        self.place(3)
        r = self.env("ha-sysvol-writer", {"dc": "dc3", "phase": "prepare"}, epoch=4)
        self.assertIn("placement behind", r["error"]["message"])

    def test_fence_stops_writes_not_lease(self):
        self.place(1, writer="dc3", holder="adl-ha-b")
        self.assertTrue(ha.lease_view()["may_write"])
        self.env("ha-fence", {"reason": "failback"}, epoch=1)
        lv = ha.lease_view()
        self.assertFalse(lv["may_write"])
        self.assertTrue(lv["valid"] and lv["holder"] == "adl-ha-b")   # serving (read-only) may continue

    def test_lease_uses_local_ttl_when_controller_clock_is_ahead(self):
        rec = ha.store_lease({"host": "adl-ha-b", "epoch": 1, "expires_at": time.time() + 10_000, "ttl_s": 60})
        self.assertLessEqual(rec["expires_local"], time.time() + 61)   # skew can only shorten a lease


if __name__ == "__main__":
    unittest.main()
