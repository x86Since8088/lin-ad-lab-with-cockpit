# cockpit-adlab

The AD Lab Cockpit plugin: a schema-driven console for the `samba-ad-lab` DC
fleet. The page builds itself from `adlab-admin schema`, and every privileged
action goes through that one root verb helper.

**This directory is canonical.** It is tracked inside the `samba-ad-lab`
repository because the plugin and the lab it drives version together — a verb
that grows a new `samba-tool` flag and the lab image that provides it must land
in one commit. A second, untracked copy used to exist at
`projects/cockpit-adlab/source`; it is not a seventh repository and it is not a
place to edit. See "The other copy" below.

## Install

Two processes, and they are not the same thing.

```bash
sudo ./deploy.sh          # the real deployment: copy -> /opt/cockpit-adlab,
                          # seed .env, then run the INSTALLED install.sh
./install.sh              # an in-place install BY SYMLINK, from wherever it is run
```

`install.sh` never copies the payload. It links the files beside it into
`/usr/share/cockpit/adlab` and `/usr/local/sbin`. Run it from this checkout and
Cockpit serves the checkout — edit `adlab.js`, reload the browser. Run the very
same script from `/opt/cockpit-adlab/payload` and you get a production install
with no relationship to any share. Nothing in it branches on which one it is to
decide *what* to link; it branches only to record which it did.

### Which install is this host running?

```bash
readlink -f /usr/share/cockpit/adlab/index.html
#   /opt/cockpit-adlab/payload-1.0.0/index.html   -> deployed
#   /srv/smb/.../cockpit-adlab/index.html         -> dev
cat /etc/cockpit-adlab/install.conf               # INSTALL_KIND, ENV_FILE, VERSION
```

Every plugin on the host, in one command:

```bash
for d in /usr/share/cockpit/*/; do
    n=${d%/}; n=${n##*/}
    t=$(readlink -f "$d/index.html" 2>/dev/null) || continue
    case $t in
      /srv/smb/share/sc/ai-orchestrator-group/*) k="DEV  (share)";;
      /opt/*)                                    k="prod (/opt)";;
      *)                                         k="OTHER";;
    esac
    printf '%-12s %s  %s\n' "$n" "$k" "$t"
done
```

## Configuration

This plugin is the only one that needs **another project's** location, which is
exactly what a deployed `.env` is for. It holds no path to `samba-ad-lab` in any
shipped file; `install.sh` refuses to install one that does.

`deploy.sh` seeds `[install path]/.env` from `.envdefault`, **missing-only**, and
never overwrites your edits. `adlab-admin` finds it through
`/etc/cockpit-adlab/install.conf` — never by looking beside itself, because the
same code in a dev install would land in the checkout and read a developer's file.

| Key | What it names |
|---|---|
| `ADLAB_ROOT` | Where samba-ad-lab keeps its installed configuration |
| `ADLAB_LAB_ENV` | The lab's settings file (realm, network, DC/client counts) |
| `ADLAB_RDP_ENV` | The RDP overlay's settings |
| `ADLAB_SYSVOL_REPLICATE` | The SYSVOL replication script `sysvol-sync` runs |
| `ADLAB_SECRET_DIR` | Directory of lab credential **files**, 0700, operator-created |
| `ADLAB_GPO_TEMPLATE_DIR` | GPO template store as seen inside a DC container |

A `.env` carries **locations and settings, never a secret** — `deploy.sh` refuses
to write one whose value looks like a credential. `ADLAB_SECRET_DIR` names the
*directory*; `adlab-admin` joins `administrator.pass` onto it.

**If the lab is not deployed yet, the page still appears.** Its Cockpit condition
tests `/usr/local/sbin/adlab-admin` — a path this project's own `install.sh`
creates — and nothing else. An unmet condition makes a plugin *silently absent*:
no page, no menu entry, no error anywhere an operator will look. A missing
sibling is therefore diagnosed at runtime instead:

```bash
/usr/local/sbin/adlab-admin config     # every key, its value, and whether it exists
```

## Tests

```bash
python3 -m unittest discover -s tests      # 107 tests, no podman, no root
```

The suite points `$ADLAB_ENV` at `tests/adlab.env.fixture`. That variable is the
one bypass the contract allows, honoured **only** for a non-root process whose own
uid owns the file: an environment variable that redirects a *root* helper's
configuration is a privilege escalation, so `adlab-admin` ignores it when running
as root and says so on stderr.

## The other copy

`projects/cockpit-adlab/source` is untracked and was byte-identical to this
directory apart from `__pycache__`. **A human should delete it**, and nothing here
can or should do it:

```bash
rm -rf /srv/smb/share/sc/ai-orchestrator-group/ai-orchestrator-storage/projects/cockpit-adlab
```

Nothing in git references it; it is not a submodule and not a remote. Its
`project_scope.md` and `config.json` describe this same plugin and are superseded
by this README and by the repository they now live in. The place that name should
point at from now on is `/opt/cockpit-adlab` — the *output* of `deploy.sh`, not a
checkout.

## Conformance (DEPLOY-CONTRACT)

| | |
|---|---|
| Layout | `/opt/cockpit-adlab`, `payload-<version>/` + `payload` symlink, `.env` a sibling |
| install.sh | `readlink -f` self-resolution; per-file symlinks; refuses paths it does not own; writes `install.conf`; never touches `cockpit.socket` |
| deploy.sh | self-contained; ships a subset; seeds `.env` missing-only; refuses secret-shaped values; keeps one previous payload |
| Config | one `.envdefault`; helper resolves only via `install.conf`; all four standing greps clean |
| Gate | one declaration sourced by both scripts; nine pre-flight refusals; post-install assertion |
| Units | none declared — nothing is enabled or started |
| Windows | out of scope; `deploy.ps1` explains rather than pretending |

Verified: staged deploy + staged install pass, and `grep -rl` for the development
root or the retired root over the staged result returns nothing.
