# Linux administrative templates (adsys / Ubuntu ADMX)

Group Policy administrative templates are the ADMX/ADML XML that GPMC (and this
plugin's GP editor) reads from the **SYSVOL central store**:

```
\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\        *.admx
\\<domain>\SYSVOL\<domain>\Policies\PolicyDefinitions\<lang>\ *.adml
```

Windows ships no "Linux" ADMX. The Linux GPO clients define their own:

- **adsys** (Ubuntu's AD GPO client) publishes `Ubuntu.admx` in namespace
  `Canonical.Policies.Ubuntu`, covering dconf (desktop + login screen), privilege
  authorization (local admins / AD-granted admins), client scripts, AppArmor,
  network mounts, the system proxy and certificate autoenrollment. Its registry
  keys live under `Software\Policies\Ubuntu\...`.
- **samba** ships `GNOME_Settings.admx` and `samba.admx`, and its own **CSE**
  preferences (`gpo manage`: `sudoers`, `motd`, `issue`, `openssh`, `smb_conf`,
  `scripts`, ...) — Linux client policy that is not ADMX at all.

`samba-tool gpo admxload` loads only the Windows set + samba's two files. So the
editor showed Windows templates and nothing that represents Linux-targeted
policy. This is what the Linux ADMX support adds.

## What the plugin does now

- **Reads** the central store (`gpo-admx-list`) and classifies each ADMX file as
  Windows or Linux. `_derive_tags` tags `ubuntu`/`adsys`/`canonical` and
  `gnome`/`samba` ADMX as **Linux**; everything else Windows.
- **Seeds** a Linux template set: `gpo-linux-seed` generates a self-contained,
  lint-clean, adsys-faithful `Ubuntu.admx` (23 policies / 9 categories, keys under
  `Software\Policies\Ubuntu`) and installs it into the central store on the PDC
  emulator. Additive and idempotent. The generator (`linux_admx_generate`) is a
  pure function in `adlab-admin`, unit-tested for a clean lint and no cross-file
  category dependency, so the lab always has a Linux set with no network fetch.
- **Surfaces** it in the GP editor: seeded policies appear in the settings
  catalog faceted **Linux** (subsystems ubuntu/gnome/debian), alongside the
  Windows templates and the samba CSE preferences.
- **Reports** which GPOs carry Linux settings: `gpo-linux-report` flags GPOs whose
  registry.pol has keys under `Software\Policies\{Ubuntu,Canonical,GNOME}` or that
  carry samba Unix/VGP CSE preference artifacts.

In the UI: **Group Policy -> ADMX central store (Windows + Linux)** separates the
two template sets, offers **Install Linux (Ubuntu/adsys) templates**, and has a
**GPOs with Linux settings** report.

## The generated set vs. the full upstream adsys tree

The generated `Ubuntu.admx` is a curated, representative subset — enough to
*represent* Linux policy end to end and to browse/set it in the editor. The full
upstream tree (github.com/ubuntu/adsys, `policies/Ubuntu/all/`) is a ~550 KB
generated `Ubuntu.admx` + `Ubuntu.adml` whose `all/` file `<using>`s a base
namespace, so it is neither self-contained nor reviewable as vendored source.

To install the full upstream set instead (or any other vendor ADMX), use the
generic import framework:

```bash
# fetch policies/Ubuntu/all/{Ubuntu.admx,en-US/Ubuntu.adml} + its base file into <dir>
adlab-admin admx-import-lint  --path <dir>
adlab-admin admx-import-stage --label adsys-all --source <dir>
adlab-admin admx-import-plan  --label adsys-all          # dry run: add / update / retire
adlab-admin admx-import-apply --label adsys-all          # add + update only
```

`admx-import-apply` is **additive by default**. `admx_plan` treats a batch as
authoritative for the *whole* store, so its `retire` list would drop every file
the batch does not contain; retirements are acted on **only** with
`--retire true`, which is meant for a full Windows-ADMX-set re-import, not a
single vendor file. Apply is idempotent on the batch+store fingerprint.

## Verbs

| Verb | Effect |
|---|---|
| `gpo-admx-list` | List central-store ADMX files + parsed policies (ADML-resolved). |
| `gpo-admxload` | Load samba's ADMX (Windows set + GNOME/samba) into the store. |
| `gpo-linux-seed [--label]` | Generate + install the Ubuntu Linux ADMX. Additive, idempotent. |
| `gpo-linux-report` | Which GPOs carry Linux-targeted settings. Read-only. |
| `gpo-catalog [--os_type Linux]` | All available settings, faceted by OS type + subsystem. |
| `admx-import-lint/-stage/-plan/-apply` | Validate, stage, dry-run and install an arbitrary ADMX batch. |

All writes target the PDC emulator (resolved live); SYSVOL replicates within
5 minutes.
