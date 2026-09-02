#!/usr/bin/env python3
"""Full unit tests for the adlab-admin verb API.

Everything effectful goes through adlab_admin.RUN, so a FakeRunner gives the
tests complete control: each test declares what the lab looks like (which
containers run, what samba-tool prints) and asserts on BOTH the JSON the verb
returns and the exact commands it constructed. No podman, no containers, no
root needed.

Run:  python3 -m unittest discover -s tests -v          (from source/)
"""

import importlib.machinery
import importlib.util
import io
import json
import os
import sys
import tempfile
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
HELPER = os.path.join(HERE, "..", "adlab-admin")

loader = importlib.machinery.SourceFileLoader("adlab_admin", HELPER)
spec = importlib.util.spec_from_loader("adlab_admin", loader)
mod = importlib.util.module_from_spec(spec)
loader.exec_module(mod)


# ---------------------------------------------------------------------------
# fixtures: realistic samba-tool output
# ---------------------------------------------------------------------------

FSMO_OUT = """SchemaMasterRole owner: CN=NTDS Settings,CN=DC2,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
InfrastructureMasterRole owner: CN=NTDS Settings,CN=DC3,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
RidAllocationMasterRole owner: CN=NTDS Settings,CN=DC1,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
PdcEmulationMasterRole owner: CN=NTDS Settings,CN=DC1,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
DomainNamingMasterRole owner: CN=NTDS Settings,CN=DC2,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
DomainDnsZonesMasterRole owner: CN=NTDS Settings,CN=DC4,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
ForestDnsZonesMasterRole owner: CN=NTDS Settings,CN=DC5,CN=Servers,CN=Default-First-Site-Name,CN=Sites,CN=Configuration,DC=ad,DC=edt1,DC=lab
"""

SHOWREPL_HEALTHY = """Default-First-Site-Name\\DC1
DSA Options: 0x00000001
DSA object GUID: 4a6b8f00-1111-2222-3333-444455556666
DSA invocationId: deadbeef-1111-2222-3333-444455556666

==== INBOUND NEIGHBORS ====

DC=ad,DC=edt1,DC=lab
\tDefault-First-Site-Name\\DC2 via RPC
\t\tDSA object GUID: 12345678-aaaa-bbbb-cccc-dddddddddddd
\t\tLast attempt @ Mon Aug 31 12:00:01 2026 CDT was successful
\t\t0 consecutive failure(s).
\t\tLast success @ Mon Aug 31 12:00:01 2026 CDT

==== OUTBOUND NEIGHBORS ====

CN=Configuration,DC=ad,DC=edt1,DC=lab
\tDefault-First-Site-Name\\DC3 via RPC
\t\tDSA object GUID: 87654321-aaaa-bbbb-cccc-dddddddddddd
\t\tLast attempt @ Mon Aug 31 12:00:05 2026 CDT was successful
\t\t0 consecutive failure(s).
\t\tLast success @ Mon Aug 31 12:00:05 2026 CDT

==== KCC CONNECTION OBJECTS ====
"""

SHOWREPL_BROKEN = SHOWREPL_HEALTHY.replace(
    "Last attempt @ Mon Aug 31 12:00:01 2026 CDT was successful",
    "Last attempt @ Mon Aug 31 12:00:01 2026 CDT failed, result 1722 (WERR_RPC_S_SERVER_UNAVAILABLE)"
).replace("0 consecutive failure(s).", "7 consecutive failure(s).", 1)

USER_SHOW = """dn: CN=Alice Adams,CN=Users,DC=ad,DC=edt1,DC=lab
objectClass: top
objectClass: person
objectClass: user
cn: Alice Adams
sAMAccountName: alice
memberOf: CN=Domain Admins,CN=Users,DC=ad,DC=edt1,DC=lab
memberOf: CN=stress-g1,CN=Users,DC=ad,DC=edt1,DC=lab
userAccountControl: 512
"""

GPO_LISTALL = """GPO          : {31B2F340-016D-11D2-945F-00C04FB984F9}
display name : Default Domain Policy
path         : \\\\ad.edt1.lab\\sysvol\\ad.edt1.lab\\Policies\\{31B2F340-016D-11D2-945F-00C04FB984F9}
dn           : CN={31B2F340-016D-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=ad,DC=edt1,DC=lab
version      : 3
flags        : NONE

GPO          : {6AC1786C-016F-11D2-945F-00C04FB984F9}
display name : Default Domain Controllers Policy
path         : \\\\ad.edt1.lab\\sysvol\\ad.edt1.lab\\Policies\\{6AC1786C-016F-11D2-945F-00C04FB984F9}
dn           : CN={6AC1786C-016F-11D2-945F-00C04FB984F9},CN=Policies,CN=System,DC=ad,DC=edt1,DC=lab
version      : 0
flags        : NONE
"""

DNS_ZONELIST = """  2 zone(s) found

  pszZoneName                 : ad.edt1.lab
  Flags                       : DNS_RPC_ZONE_DSINTEGRATED DNS_RPC_ZONE_UPDATE_SECURE
  ZoneType                    : DNS_ZONE_TYPE_PRIMARY

  pszZoneName                 : _msdcs.ad.edt1.lab
  Flags                       : DNS_RPC_ZONE_DSINTEGRATED DNS_RPC_ZONE_UPDATE_SECURE
  ZoneType                    : DNS_ZONE_TYPE_PRIMARY
"""

DNS_QUERY = """  Name=, Records=2, Children=0
    SOA: serial=110, refresh=900, retry=600, expire=86400, minttl=3600, ns=dc1.ad.edt1.lab., email=hostmaster.ad.edt1.lab. (flags=600000f0, serial=110, ttl=3600)
    NS: dc1.ad.edt1.lab. (flags=600000f0, serial=110, ttl=900)
  Name=dc1, Records=1, Children=0
    A: 172.15.4.10 (flags=f0, serial=110, ttl=900)
  Name=dc2, Records=1, Children=0
    A: 172.15.4.11 (flags=f0, serial=110, ttl=900)
"""

PROCESSES = """ Service:                          PID
 --------------------------------------
 cldap_server                     87
 dnssrv                           92
 dnsupdate                        95
 kdc_server                       88
 ldap_server                      85
"""

DOMAIN_INFO = """Forest           : ad.edt1.lab
Domain           : ad.edt1.lab
Netbios domain   : EDT1LAB
DC name          : dc1.ad.edt1.lab
DC netbios name  : DC1
Server site      : Default-First-Site-Name
Client site      : Default-First-Site-Name
"""


# ---------------------------------------------------------------------------
# the fake runner
# ---------------------------------------------------------------------------

class FakeRunner:
    """Routes argv to canned results; records every call for assertions."""

    def __init__(self):
        self.rules = []          # (predicate, (rc, out, err))
        self.calls = []          # (argv, stdin)

    def on(self, pred, rc=0, out="", err=""):
        self.rules.append((pred, (rc, out, err)))
        return self

    def run(self, argv, stdin=None, timeout=120):
        self.calls.append((list(argv), stdin))
        for pred, res in self.rules:
            if pred(argv):
                return res
        return 1, "", "no fake rule for: %s" % " ".join(map(str, argv))

    # -- convenience canned lab -------------------------------------------
    def lab_up(self):
        """All 5 DCs and 10 clients running; fsmo answered by any DC."""
        self.on(lambda a: a[:2] == ["podman", "inspect"] and
                          "--format" in a and "{{.State.Status}}" in a,
                out="running\n")
        self.on(lambda a: a[:2] == ["podman", "inspect"] and
                          any("Networks" in x for x in a),
                out="172.15.4.10\n")
        self.on(lambda a: "fsmo" in a and "show" in a, out=FSMO_OUT)
        return self

    def argv_containing(self, *words):
        """All recorded argvs containing every word (in any element)."""
        hits = []
        for argv, _ in self.calls:
            joined = " ".join(map(str, argv))
            if all(w in joined for w in words):
                hits.append(argv)
        return hits


class Base(unittest.TestCase):
    def setUp(self):
        self.fake = FakeRunner()
        self._old_run = mod.RUN
        mod.RUN = self.fake
        self._audit = tempfile.NamedTemporaryFile(delete=False, suffix=".log")
        self._audit.close()
        self._old_audit = mod.AUDIT_LOG
        mod.AUDIT_LOG = self._audit.name

    def tearDown(self):
        mod.RUN = self._old_run
        mod.AUDIT_LOG = self._old_audit
        os.unlink(self._audit.name)

    def call_main(self, argv, stdin=""):
        """Invoke main() capturing stdout; returns (exit_code, parsed_json)."""
        old_out, old_in = sys.stdout, sys.stdin
        sys.stdout = io.StringIO()
        sys.stdin = io.StringIO(stdin)
        try:
            rc = mod.main(argv)
            out = sys.stdout.getvalue()
        finally:
            sys.stdout, sys.stdin = old_out, old_in
        self.assertTrue(out.strip(), "verb printed nothing")
        return rc, json.loads(out)


# ---------------------------------------------------------------------------
# 1. schema integrity — the contract that drives every UI control
# ---------------------------------------------------------------------------

KNOWN_TYPES = {"str", "int", "bool", "enum", "password-stdin"}
KNOWN_GROUPS = {"meta", "overview", "fsmo", "users", "groups", "gpo",
                "sites", "dns", "dcs", "clients", "activity"}
DESTRUCTIVE = {"fsmo-transfer", "fsmo-seize", "user-delete", "group-delete",
               "ou-delete", "gpo-delete", "gpo-unlink", "gpo-settings-remove",
               "dns-delete", "dc-restart", "dc-shell", "dc-promote", "dc-demote",
               "client-remove"}


class TestSchema(Base):
    def test_every_verb_is_complete(self):
        for name, spec_ in mod.VERBS.items():
            self.assertTrue(callable(spec_["fn"]), name)
            self.assertTrue(spec_["help"], "%s: empty help" % name)
            self.assertIn(spec_["group"], KNOWN_GROUPS, name)
            for a in spec_.get("args", []):
                self.assertIn(a["type"], KNOWN_TYPES, "%s.%s" % (name, a["name"]))
                self.assertIn("required", a, "%s.%s" % (name, a["name"]))
                if a["type"] == "enum":
                    self.assertTrue(a.get("choices"), "%s.%s: enum without choices"
                                    % (name, a["name"]))

    def test_destructive_verbs_are_flagged_danger(self):
        for name in DESTRUCTIVE:
            self.assertTrue(mod.VERBS[name].get("danger"),
                            "%s must carry danger:true" % name)

    def test_password_args_never_travel_on_argv(self):
        for name, spec_ in mod.VERBS.items():
            for a in spec_.get("args", []):
                if "password" in a["name"]:
                    self.assertEqual(a["type"], "password-stdin",
                                     "%s.%s" % (name, a["name"]))

    def test_schema_verb_dumps_the_whole_table(self):
        rc, out = self.call_main(["schema"])
        self.assertEqual(rc, 0)
        self.assertEqual(set(out["verbs"]), set(mod.VERBS))
        for name, v in out["verbs"].items():
            self.assertIn("help", v)
            self.assertIn("group", v)
            self.assertIn("danger", v)
            json.dumps(v)   # everything serializable

    def test_version_verb(self):
        rc, out = self.call_main(["version"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["realm"], mod.LAB["REALM"])


# ---------------------------------------------------------------------------
# 2. argument parsing / validation
# ---------------------------------------------------------------------------

class TestParseArgs(Base):
    SPEC = {"args": [mod.arg("name"), mod.arg("lines", "int", required=False,
                                              default=80),
                     mod.arg("dc", "enum", required=False,
                             choices=["dc1", "dc2"]),
                     mod.arg("password", "password-stdin")]}

    def test_happy_path_with_default(self):
        got = mod.parse_args(self.SPEC, ["--name", "alice"])
        self.assertEqual(got, {"name": "alice", "lines": 80})

    def test_int_coercion_and_enum(self):
        got = mod.parse_args(self.SPEC, ["--name", "x", "--lines", "5",
                                         "--dc", "dc2"])
        self.assertEqual(got["lines"], 5)
        self.assertEqual(got["dc"], "dc2")

    def test_missing_required(self):
        with self.assertRaisesRegex(mod.Fail, "missing required --name"):
            mod.parse_args(self.SPEC, [])

    def test_bad_int(self):
        with self.assertRaisesRegex(mod.Fail, "--lines must be an integer"):
            mod.parse_args(self.SPEC, ["--name", "x", "--lines", "many"])

    def test_bad_enum(self):
        with self.assertRaisesRegex(mod.Fail, "--dc must be one of"):
            mod.parse_args(self.SPEC, ["--name", "x", "--dc", "dc9"])

    def test_unknown_argument_rejected(self):
        with self.assertRaisesRegex(mod.Fail, "unknown argument"):
            mod.parse_args(self.SPEC, ["--name", "x", "--nope", "1"])

    def test_password_never_accepted_on_argv(self):
        with self.assertRaisesRegex(mod.Fail, "unknown argument"):
            mod.parse_args(self.SPEC, ["--name", "x", "--password", "pw"])

    def test_dangling_flag(self):
        with self.assertRaisesRegex(mod.Fail, "missing value"):
            mod.parse_args(self.SPEC, ["--name"])


# ---------------------------------------------------------------------------
# 3. parsers against fixtures
# ---------------------------------------------------------------------------

class TestParsers(Base):
    def test_fsmo(self):
        roles = mod.parse_fsmo(FSMO_OUT)
        self.assertEqual(len(roles), 7)
        self.assertEqual(roles["PdcEmulationMasterRole"], "dc1")
        self.assertEqual(roles["ForestDnsZonesMasterRole"], "dc5")

    def test_showrepl_healthy(self):
        rep = mod.parse_showrepl(SHOWREPL_HEALTHY)
        self.assertEqual(len(rep["neighbors"]), 2)
        self.assertTrue(all(n["ok"] for n in rep["neighbors"]))
        dirs = {n["direction"] for n in rep["neighbors"]}
        self.assertEqual(dirs, {"inbound", "outbound"})
        self.assertIn("DC2", rep["neighbors"][0]["partner"])

    def test_showrepl_broken(self):
        rep = mod.parse_showrepl(SHOWREPL_BROKEN)
        bad = [n for n in rep["neighbors"] if not n["ok"]]
        self.assertEqual(len(bad), 1)
        self.assertEqual(bad[0]["consecutive_failures"], 7)

    def test_ldif(self):
        ents = mod.parse_ldif_entries(USER_SHOW)
        self.assertEqual(len(ents), 1)
        self.assertEqual(ents[0]["sAMAccountName"], ["alice"])
        self.assertEqual(len(ents[0]["memberOf"]), 2)

    def test_gpo_listall(self):
        gpos = mod.parse_gpo_listall(GPO_LISTALL)
        self.assertEqual(len(gpos), 2)
        self.assertEqual(gpos[0]["display_name"], "Default Domain Policy")
        self.assertTrue(gpos[1]["gpo"].startswith("{6AC1786C"))

    def test_dns_zonelist(self):
        self.assertEqual(mod.parse_dns_zonelist(DNS_ZONELIST),
                         ["_msdcs.ad.edt1.lab", "ad.edt1.lab"])

    def test_dns_query(self):
        recs = mod.parse_dns_query(DNS_QUERY)
        a = [r for r in recs if r["type"] == "A"]
        self.assertEqual(len(a), 2)
        self.assertEqual(a[0], {"name": "dc1", "type": "A",
                                "data": "172.15.4.10", "ttl": 900})
        ns = [r for r in recs if r["type"] == "NS"]
        self.assertEqual(ns[0]["name"], "@")

    def test_processes(self):
        procs = mod.parse_processes(PROCESSES)
        self.assertIn({"service": "kdc_server", "pid": 88}, procs)
        self.assertEqual(len(procs), 5)

    def test_domain_info(self):
        info = mod.parse_domain_info(DOMAIN_INFO)
        self.assertEqual(info["netbios_domain"], "EDT1LAB")
        self.assertEqual(info["dc_name"], "dc1.ad.edt1.lab")

    def test_name_list(self):
        self.assertEqual(mod.parse_name_list("b\n\na\n"), ["a", "b"])


# ---------------------------------------------------------------------------
# 4. handlers: command construction, targeting, secrets, errors
# ---------------------------------------------------------------------------

class TestHandlers(Base):
    def test_fsmo_show(self):
        self.fake.lab_up()
        rc, out = self.call_main(["fsmo-show"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["roles"]["PdcEmulationMasterRole"], "dc1")

    def test_user_create_targets_pdc_and_keeps_password_off_argv(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "user" in a and "create" in a, out="User 'bob' added successfully\n")
        rc, out = self.call_main(["user-create", "--name", "bob"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["created"], "bob")
        self.assertTrue(out["password"])
        creates = self.fake.argv_containing("user create")
        self.assertEqual(len(creates), 1)
        argv, stdin = next((c for c in self.fake.calls if "create" in c[0]), (None, None))
        self.assertNotIn(out["password"], " ".join(argv))
        self.assertIn(out["password"], stdin or "")
        self.assertIn("dc1", argv)   # the PDC emulator

    def test_user_setpassword_reads_stdin(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "setpassword" in a, out="Changed password OK\n")
        rc, out = self.call_main(["user-setpassword", "--name", "bob"],
                                 stdin="S3cret-pw!\n")
        self.assertEqual(rc, 0)
        _, stdin = next(c for c in self.fake.calls if "setpassword" in c[0])
        self.assertIn("S3cret-pw!", stdin)

    def test_user_setpassword_requires_stdin(self):
        self.fake.lab_up()
        rc, out = self.call_main(["user-setpassword", "--name", "bob"], stdin="")
        self.assertEqual(rc, 1)
        self.assertIn("stdin", out["error"])

    def test_gpo_create_goes_to_pdc_with_authfile(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo create" in str(x) for x in a),
                     out="GPO 'test' created as {AAAAAAAA-1111-2222-3333-444455556666}\n")
        rc, out = self.call_main(["gpo-create", "--name", "test"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["on"], "dc1")
        self.assertTrue(out["gpo"].startswith("{AAAAAAAA"))
        argv = self.fake.argv_containing("gpo create")[0]
        joined = " ".join(argv)
        self.assertIn("/run/adminpass", joined)      # password read in-container
        self.assertIn("rm -f /run/adlab.auth", joined)  # authfile cleaned up
        self.assertNotIn(mod.LAB["ADMIN_PASS_FILE"], joined)

    def test_dns_add_targets_pdc(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("dns add" in str(x) for x in a),
                     out="Record added successfully\n")
        rc, out = self.call_main(["dns-add", "--zone", "ad.edt1.lab",
                                  "--name", "www", "--type", "A",
                                  "--data", "172.15.4.99"])
        self.assertEqual(rc, 0)
        argv = self.fake.argv_containing("dns add")[0]
        self.assertEqual(argv[2], "dc1")

    def test_dns_type_is_validated(self):
        rc, out = self.call_main(["dns-add", "--zone", "z", "--name", "n",
                                  "--type", "BOGUS", "--data", "d"])
        self.assertEqual(rc, 2)
        self.assertIn("--type must be one of", out["error"])

    def test_dc_demote_refuses_dc1(self):
        self.fake.lab_up()
        rc, out = self.call_main(["dc-demote", "--dc", "dc1"])
        self.assertEqual(rc, 1)
        self.assertIn("refusing", out["error"])

    def test_dc_promote_picks_next_free_slot(self):
        # dc1..dc5 exist; dc6 missing -> promote creates dc6 at .15
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"] and "dc6" in a,
                     rc=1, out="")
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"],
                     out="running\n")
        self.fake.on(lambda a: a[:2] == ["podman", "run"], out="abc123\n")
        rc, out = self.call_main(["dc-promote"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["promoting"], "dc6")
        self.assertEqual(out["ip"], "172.15.4.15")
        argv = self.fake.argv_containing("podman run")[0]
        self.assertIn("--ip", argv)
        self.assertIn("172.15.4.15", argv)
        self.assertIn("ROLE=join", " ".join(argv))

    def test_client_remove_validates_name(self):
        rc, out = self.call_main(["client-remove", "--name", "dc1"])
        self.assertEqual(rc, 1)
        self.assertIn("clientN", out["error"])

    def test_dc_debug_range(self):
        self.fake.lab_up()
        rc, out = self.call_main(["dc-debug", "--dc", "dc2", "--level", "99"])
        self.assertEqual(rc, 1)
        self.assertIn("0..10", out["error"])

    def test_dc_logs(self):
        self.fake.on(lambda a: a[:2] == ["podman", "logs"], out="line1\nline2\n")
        rc, out = self.call_main(["dc-logs", "--dc", "dc3"])
        self.assertEqual(rc, 0)
        self.assertIn("line2", out["log"])
        argv = self.fake.argv_containing("podman logs")[0]
        self.assertEqual(argv[argv.index("--tail") + 1], "80")   # default applied

    def test_health_rolls_up_broken_replication(self):
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], out="running\n")
        self.fake.on(lambda a: "showrepl" in a, out=SHOWREPL_BROKEN)
        rc, out = self.call_main(["health"])
        self.assertEqual(rc, 0)
        self.assertTrue(all(r["failures"] == 1 for r in out["dcs"]))

    def test_no_dc_running_is_a_clean_error(self):
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], out="exited\n")
        rc, out = self.call_main(["fsmo-show"])
        self.assertEqual(rc, 1)
        self.assertIn("no DC container is running", out["error"])

    def test_repl_status_single_dc(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "showrepl" in a, out=SHOWREPL_HEALTHY)
        rc, out = self.call_main(["repl-status", "--dc", "dc2"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(out["replication"]), 1)
        self.assertEqual(out["replication"][0]["dc"], "dc2")

    def test_sysvol_status_flags_divergence(self):
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], out="running\n")
        seq = iter(["aaaa\n", "5\n", "bbbb\n", "5\n", "aaaa\n", "5\n",
                    "aaaa\n", "5\n", "aaaa\n", "5\n"])
        self.fake.on(lambda a: "bash" in a, out="")  # placeholder, replaced below
        self.fake.rules[-1] = (lambda a: "bash" in a and "-c" in a,
                               None)  # dynamic below

        def dyn(argv, stdin=None, timeout=120):
            self.fake.calls.append((list(argv), stdin))
            if argv[:2] == ["podman", "inspect"]:
                return 0, "running\n", ""
            return 0, next(seq), ""
        mod.RUN = type("R", (), {"run": staticmethod(dyn)})()
        rc, out = self.call_main(["sysvol-status"])
        self.assertEqual(rc, 0)
        self.assertFalse(out["identical"])

    def test_dc_shell_returns_rc_and_both_streams(self):
        self.fake.on(lambda a: "bash" in a, rc=3, out="OUT", err="ERR")
        rc, out = self.call_main(["dc-shell", "--dc", "dc4",
                                  "--command", "false"])
        self.assertEqual(rc, 0)          # the verb succeeded; the command's rc is data
        self.assertEqual(out["rc"], 3)
        self.assertEqual(out["stdout"], "OUT")
        self.assertEqual(out["stderr"], "ERR")


# ---------------------------------------------------------------------------
# 5. main(): contract — JSON always, correct exit codes, audit hygiene
# ---------------------------------------------------------------------------

class TestMainContract(Base):
    def test_unknown_verb(self):
        rc, out = self.call_main(["frobnicate"])
        self.assertEqual(rc, 2)
        self.assertIn("unknown verb", out["error"])
        self.assertIn("status", out["verbs"])

    def test_no_verb_usage(self):
        rc, out = self.call_main([])
        self.assertEqual(rc, 2)
        self.assertIn("usage", out["error"])

    def test_arg_error_is_json_exit_2(self):
        rc, out = self.call_main(["user-show"])
        self.assertEqual(rc, 2)
        self.assertIn("missing required --name", out["error"])

    def test_internal_error_still_prints_json(self):
        self.fake.lab_up()
        orig = mod.VERBS["status"]["fn"]
        mod.VERBS["status"]["fn"] = lambda a: 1 / 0
        try:
            rc, out = self.call_main(["status"])
            self.assertEqual(rc, 3)
            self.assertIn("internal", out["error"])
        finally:
            mod.VERBS["status"]["fn"] = orig

    def test_audit_written_and_never_contains_passwords(self):
        self.fake.lab_up()
        self.fake.on(lambda a: "user" in a and "create" in a, out="ok\n")
        rc, out = self.call_main(["user-create", "--name", "carol"])
        self.assertEqual(rc, 0)
        with open(mod.AUDIT_LOG) as f:
            log = f.read()
        self.assertIn("user-create", log)
        self.assertIn("carol", log)
        self.assertNotIn(out["password"], log)

    def test_every_readonly_verb_survives_a_dead_lab(self):
        """With nothing running, every no-arg verb must still return JSON
        (success or a clean error), never crash."""
        self.fake.on(lambda a: a[:2] == ["podman", "inspect"], rc=1, out="")
        for name, spec_ in mod.VERBS.items():
            if any(a.get("required") for a in spec_.get("args", [])):
                continue
            rc, out = self.call_main([name])
            self.assertIsInstance(out, dict, name)
            self.assertIn(rc, (0, 1, 2, 3), name)


# ---------------------------------------------------------------------------
# 6. Group Policy: PReg / ADMX parsers + the stacking verbs
# ---------------------------------------------------------------------------

import struct as _struct


def _u16(s):
    return s.encode("utf-16-le") + b"\x00\x00"


def _preg(entries):
    """Build a PReg blob from [(key,val,type_id,data_bytes)]."""
    blob = b"PReg" + _struct.pack("<I", 1)
    for key, val, tid, data in entries:
        blob += (b"[\x00" + _u16(key) + b";\x00" + _u16(val) + b";\x00"
                 + _struct.pack("<I", tid) + b";\x00"
                 + _struct.pack("<I", len(data)) + b";\x00" + data + b"]\x00")
    return blob


class TestPReg(Base):
    def test_roundtrip_types(self):
        blob = _preg([
            ("Software\\A", "Str", 1, "hello".encode("utf-16-le") + b"\x00\x00"),
            ("Software\\A", "Dw", 4, _struct.pack("<I", 7)),
            ("Software\\A", "Qw", 11, _struct.pack("<Q", 99)),
            ("Software\\A", "Multi", 7,
             "a\x00b\x00".encode("utf-16-le") + b"\x00\x00"),
        ])
        out = mod.parse_preg(blob)
        self.assertEqual(len(out), 4)
        self.assertEqual(out[0], {"keyname": "Software\\A", "valuename": "Str",
                                  "type": "REG_SZ", "data": "hello"})
        self.assertEqual(out[1]["data"], 7)
        self.assertEqual(out[1]["type"], "REG_DWORD")
        self.assertEqual(out[2]["data"], 99)
        self.assertEqual(out[3]["data"], ["a", "b"])

    def test_not_preg_returns_empty(self):
        self.assertEqual(mod.parse_preg(b"notpreg...."), [])
        self.assertEqual(mod.parse_preg(b""), [])

    def test_truncated_is_safe(self):
        blob = _preg([("K", "V", 4, _struct.pack("<I", 1))])[:-6]
        self.assertIsInstance(mod.parse_preg(blob), list)   # no exception


class TestAdmx(Base):
    ADMX = ('<policyDefinitions><policies>'
            '<policy name="Pbool" class="Machine" key="Software\\P" valueName="On">'
            '<enabledValue><decimal value="1"/></enabledValue>'
            '<disabledValue><decimal value="0"/></disabledValue></policy>'
            '<policy name="Pstr" class="User" key="Software\\Q" valueName="S">'
            '<enabledValue><string>yes</string></enabledValue></policy>'
            '<policy name="Pelem" class="Both" key="Software\\R">'
            '<elements><text id="t1" valueName="TextVal"/>'
            '<decimal id="d1" valueName="NumVal"/></elements></policy>'
            '</policies></policyDefinitions>')

    def test_enabled_disabled_values(self):
        pols = {p["id"]: p for p in mod.parse_admx(self.ADMX)}
        self.assertEqual(set(pols), {"Pbool", "Pstr", "Pelem"})
        self.assertEqual(pols["Pbool"]["enabled_type"], "REG_DWORD")
        self.assertEqual(pols["Pbool"]["enabled_data"], 1)
        self.assertEqual(pols["Pbool"]["disabled_data"], 0)
        self.assertEqual(pols["Pstr"]["enabled_type"], "REG_SZ")
        self.assertEqual(pols["Pstr"]["enabled_data"], "yes")

    def test_elements_typed(self):
        pols = {p["id"]: p for p in mod.parse_admx(self.ADMX)}
        el = pols["Pelem"]["elements"]
        kinds = {e["valuename"]: e["type"] for e in el}
        self.assertEqual(kinds["TextVal"], "REG_SZ")
        self.assertEqual(kinds["NumVal"], "REG_DWORD")

    def test_bad_xml_returns_empty(self):
        self.assertEqual(mod.parse_admx("<not xml"), [])


class TestAdml(Base):
    ADML = ('<policyDefinitionResources><resources><stringTable>'
            '<string id="POL_Foo">Disable Printing</string>'
            '<string id="POL_Bar">Whitelisted Accounts</string>'
            '</stringTable></resources></policyDefinitionResources>')

    def test_parse_adml_strings(self):
        t = mod.parse_adml(self.ADML)
        self.assertEqual(t["POL_Foo"], "Disable Printing")
        self.assertEqual(t["POL_Bar"], "Whitelisted Accounts")

    def test_resolve_ref(self):
        strings = mod.parse_adml(self.ADML)
        # a $(string.POL_Foo) displayName arrives as "string.POL_Foo"
        self.assertEqual(mod._resolve_ref("string.POL_Foo", strings), "Disable Printing")
        # unknown ref stays as-is (so the UI can flag it unresolved)
        self.assertEqual(mod._resolve_ref("string.POL_Missing", strings), "string.POL_Missing")
        # a literal name is untouched
        self.assertEqual(mod._resolve_ref("Already Text", strings), "Already Text")

    def test_bad_adml_returns_empty(self):
        self.assertEqual(mod.parse_adml("<broken"), {})


class TestGpoVerbs(Base):
    def _mock_sysvol_preg(self, machine_entries):
        """Make base64 reads of Machine/registry.pol return machine_entries."""
        blob = _preg(machine_entries)
        b64 = _b64(blob)
        # the helper runs bash -c 'find .../Machine ... base64 -w0 ...'
        self.fake.on(lambda a: "bash" in a and any("/Machine" in str(x) for x in a),
                     out=b64)
        self.fake.on(lambda a: "bash" in a and any("/User" in str(x) for x in a),
                     out="")

    def test_settings_apply_builds_gpo_load_with_stdin(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="Success\n")
        entries = ('[{"keyname":"Software\\\\P","valuename":"On",'
                   '"class":"MACHINE","type":"REG_DWORD","data":1}]')
        rc, out = self.call_main(["gpo-settings-apply",
                                  "--gpo", "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--entries", entries])
        self.assertEqual(rc, 0)
        self.assertEqual(out["applied"], 1)
        # command targets the PDC (dc1) and passes the registry CSE + JSON stdin
        argv, stdin = next(c for c in self.fake.calls
                           if any("gpo load" in str(x) for x in c[0]))
        self.assertIn("dc1", argv)
        self.assertIn("35378EAC", " ".join(argv))
        self.assertIn('"valuename": "On"', stdin)

    def test_settings_apply_rejects_bad_class(self):
        self.fake.lab_up()
        entries = '[{"keyname":"K","valuename":"V","class":"NOPE","type":"REG_SZ","data":"x"}]'
        rc, out = self.call_main(["gpo-settings-apply", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--entries", entries])
        self.assertEqual(rc, 1)
        self.assertIn("MACHINE|USER|BOTH", out["error"])

    def test_settings_apply_rejects_bad_guid(self):
        self.fake.lab_up()
        rc, out = self.call_main(["gpo-settings-apply", "--gpo", "not-a-guid",
                                  "--entries", "[]"])
        self.assertEqual(rc, 1)
        self.assertIn("GUID", out["error"])

    def test_registry_list_parses_sysvol(self):
        self.fake.lab_up()
        self._mock_sysvol_preg([("Software\\P", "On", 4, _struct.pack("<I", 1))])
        rc, out = self.call_main(["gpo-registry-list", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}"])
        self.assertEqual(rc, 0)
        self.assertEqual(len(out["settings"]), 1)
        self.assertEqual(out["settings"][0]["class"], "MACHINE")
        self.assertEqual(out["settings"][0]["data"], 1)

    def test_template_stack_merges_sources(self):
        self.fake.lab_up()
        self._mock_sysvol_preg([("Software\\P", "On", 4, _struct.pack("<I", 1))])
        self.fake.on(lambda a: any("gpo load" in str(x) for x in a), out="ok\n")
        rc, out = self.call_main(["gpo-template-stack",
                                  "--target", "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--sources", "{6AC1786C-016F-11D2-945F-00C04FB984F9}"])
        self.assertEqual(rc, 0)
        self.assertEqual(out["applied"], 1)
        self.assertEqual(out["layers"][0]["settings"], 1)

    def test_pref_set_builds_manage_command(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo manage smb_conf set" in str(x) for x in a),
                     out="")
        rc, out = self.call_main(["gpo-pref-set", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--cse", "smb_conf", "--entry", "apply group policies",
                                  "--value", "yes"])
        self.assertEqual(rc, 0)
        argv = next(c[0] for c in self.fake.calls
                    if any("gpo manage smb_conf set" in str(x) for x in c[0]))
        joined = " ".join(argv)
        self.assertIn("apply group policies", joined)
        self.assertIn("yes", joined)

    def test_pref_set_rejects_unknown_cse(self):
        self.fake.lab_up()
        rc, out = self.call_main(["gpo-pref-set", "--gpo",
                                  "{31B2F340-016D-11D2-945F-00C04FB984F9}",
                                  "--cse", "bogus"])
        self.assertEqual(rc, 2)   # enum validation at parse time
        self.assertIn("--cse must be one of", out["error"])

    def test_admxload_reports_central_store(self):
        self.fake.lab_up()
        self.fake.on(lambda a: any("gpo admxload" in str(x) for x in a), out="done\n")
        self.fake.on(lambda a: "bash" in a and any("PolicyDefinitions" in str(x) for x in a),
                     out="samba.admx GNOME_Settings.admx\n")
        rc, out = self.call_main(["gpo-admxload"])
        self.assertEqual(rc, 0)
        self.assertTrue(out["loaded"])
        self.assertIn("samba.admx", out["central_store"])


import base64 as _base64
def _b64(blob):
    return _base64.b64encode(blob).decode()


if __name__ == "__main__":
    unittest.main(verbosity=2)
