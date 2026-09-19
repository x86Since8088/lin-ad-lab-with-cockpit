# OS-exclusive GPOs (Windows vs Linux)

A GPO in this lab is created for **one** operating system — Windows-exclusive or
Linux-exclusive — so that a Linux policy setting never applies on a Windows
system and a Windows setting never applies on Linux. Exclusivity is enforced at
the **source**: the write verbs refuse a setting whose OS differs from the GPO's
declared scope, so the wrong-OS setting never enters the GPO's SYSVOL in the
first place.

## Why enforce at the source (and not with a WMI filter)

Two mechanisms people reach for do **not** give reliable OS exclusivity against a
mixed Windows+Linux (samba-gpupdate / adsys) estate. Both were checked against
primary sources and the samba client code running in the lab.

1. **Registry-root namespace is not a gate on Windows.** The Windows registry
   CSE (`{35378EAC-683F-11D2-A89A-00C04FBBCFA2}`) writes **every** `registry.pol`
   entry into the registry verbatim — there is no filter by root key
   ([MS-GPREG]). So Linux-targeted keys (`Software\Policies\{Ubuntu,Canonical,
   GNOME}`) placed in a GPO that a Windows machine processes **are written** to
   that machine's registry. They have no behavioral effect only because no
   Windows component ever *reads* those roots (they are "managed", non-tattooing
   keys, removed on unlink) — i.e. separation on Windows is a *consumption
   convention*, not a guarantee. Keeping those keys out of Windows GPOs entirely
   is the only way to keep them off Windows.

2. **WMI filters fail *open* on Linux.** A `Win32_OperatingSystem` WMI filter is
   evaluated by the *client* against its own WMI, and only Windows has that
   provider — but the Linux GPO clients never evaluate it at all. samba-gpupdate
   *fetches* `gPCWQLFilter` (`samba/gp/gpclass.py`) but has **no code that
   evaluates it**; adsys likewise ignores it. So a WMI-filtered "Windows-only"
   GPO is still fully processed by a Linux client. (`samba-tool` cannot create
   WMI filters either.)

The dependable lever, therefore, is to make each GPO single-OS and refuse
cross-OS writes.

## What the plugin does

- **`gpo-create --name … --os {Windows|Linux}`** — creates the GPO and records
  its OS scope. The scope is stored host-side (`/var/lib/adlab/gpo-os.json`,
  root-only) keyed by GPO GUID; resolving/enforcing it needs no container call.
- **`gpo-set-os --gpo {GUID} --os {Windows|Linux}`** — declare (or change) the
  scope of a GPO the plugin did not create (e.g. `Default Domain Policy`),
  opting it into enforcement.
- **`gpo-list`** reports each GPO's declared `os_scope` (the **OS** column in the
  UI; blank for an untyped legacy GPO). **`gpo-show`** reports the scope too, and
  *infers* one from SYSVOL contents when none is declared (`os_source:
  declared|inferred|mixed|unknown`).
- **Enforcement** (declared scope only — a legacy, untyped GPO is never blocked):
  - `gpo-settings-apply` and `gpo-template-stack` classify each registry entry by
    key namespace and refuse any whose OS crosses the scope.
  - `gpo-pref-set` refuses on a Windows GPO — the samba Unix CSE preferences
    (`sudoers`, `motd`, `issue`, `smb_conf`, …) are Linux-only.
- **`gpo-delete`** clears the recorded scope.

Setting → OS classification (`_setting_os`):

| Registry key root | OS |
|---|---|
| `Software\Policies\Ubuntu`, `…\Canonical`, `…\GNOME` | Linux |
| `Software\Policies\Microsoft\Cryptography\AutoEnrollment`, `…\PolicyServers` | **shared** (allowed in either scope) |
| everything else (`Software\Policies\Microsoft\…`, etc.) | Windows |

## The one shared exception: Certificate Auto-Enrollment

`Software\Policies\Microsoft\Cryptography\AutoEnrollment\AEPolicy` (and
`…\PolicyServers\`) is Microsoft-rooted yet consumed by native Windows **and**
by both Linux clients (samba's `gp_cert_auto_enroll_ext`; adsys reuses samba's
implementation). It is genuinely OS-agnostic, so it is classed `shared` and
allowed in a Windows *or* a Linux GPO rather than being refused.

## Notes / limits

- Enforcement covers the plugin's write paths. Nothing stops a GPO being edited
  outside the plugin (native GPMC/RSAT, `samba-tool` directly); the scope record
  is the plugin's, not a directory attribute, so it is not visible to native
  tools. `gpo-show` inference is the fallback for anything created elsewhere.
- Samba **security** settings (`GptTmpl.inf`, surfaced here as the `security`
  CSE) apply on Windows too; the plugin models the CSE preferences as Linux, so
  they belong on a Linux (or untyped) GPO.
- Link discipline still matters: scope keeps the wrong-OS *settings* out of a
  GPO, but you still link Windows GPOs to OUs with Windows computers and Linux
  GPOs to Linux OUs.
