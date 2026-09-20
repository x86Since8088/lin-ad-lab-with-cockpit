# Kerberos ticket anomaly detection (Kerberoasting)

Two anomalous-ticket detections, matching MITRE ATT&CK **T1558.003**:

1. **RC4 downgrade** — a TGS *service ticket* requested and/or issued with **RC4
   (etype 23 = 0x17)** instead of AES (17/18). The service portion of a TGS is
   encrypted with the target account's long-term key; when that key is RC4 the
   blob is an unsalted-NT-hash-derived cipher that cracks offline far faster than
   AES, so roasting tools deliberately request RC4.
2. **Bulk TGS** — one account requesting service tickets for **many distinct
   SPNs** in a short window: a Kerberoasting sweep. Distinct-SPN count is a more
   reliable signal than raw volume.

Plus a **static exposure** view: which SPN accounts even *permit* RC4, i.e. the
roastable surface, independent of any live telemetry.

## Verbs

| Verb | What |
|---|---|
| `kerberos-roast-exposure` | SPN accounts + decoded `msDS-supportedEncryptionTypes`; RC4-roastable vs AES-only. Always available (ldbsearch). |
| `kerberos-audit-status [--dc]` | Whether KDC request auditing is on per DC, and how many records exist. |
| `kerberos-audit-enable [--dc]` | Turn KDC request auditing on (runtime). |
| `kerberos-audit-disable [--dc]` | Restore the KDC workers' default debug level. |
| `kerberos-ticket-requests [--window N] [--dc]` | Parsed `TGS-REQ SUCCESS` records. |
| `kerberos-anomalies [--window N] [--distinct_spn_threshold K] [--tgs_threshold M] [--dc]` | The two detections (RC4 downgrade + bulk TGS). |

## etype reference

`1` des-cbc-crc · `3` des-cbc-md5 · `17` aes128 · `18` aes256 · `23` **rc4-hmac** ·
`24` rc4-hmac-exp. Weak = DES (1,3) and RC4 (23,24). `msDS-supportedEncryptionTypes`
bits: `0x1`/`0x2` DES, `0x4` RC4, `0x8` AES128, `0x10` AES256; **unset/0 ⇒ the KDC
treats the account as RC4-capable** (the legacy default), which is why an unset
value counts as roastable.

## The data source, and how to enable it

Once the samba **`kerberos` debug class is ≥ 3**, the embedded Heimdal KDC writes
one structured line per request to `/var/log/samba/log.samba`:

```
Kerberos: TGS-REQ SUCCESS ipv4:10.0.0.9:5 alice@REALM MSSQLSvc/db@REALM \
  etype=18/18 ... etypes=23 ... auth=1789865502 ...
```

- `<client>` = requesting principal, `<spn>` = target service, `ipv4:...` = source.
- `etype=<tkt>/<svc>` = the **issued** service ticket's etypes; the part after the
  slash (`<svc>`) is the service key etype — the Kerberoast-crackable one.
- `etypes=<list>` = the **client's requested** etype list.
- `auth=<epoch>` = request time.

**Enabling is fiddly on this lab and worth knowing:** the DC entrypoint launches
samba with `--debuglevel=1`, and a command-line debug level **overrides smb.conf
`log level`** — so editing smb.conf does nothing. samba also **pre-forks** the KDC
into a master + worker processes, and a runtime `smbcontrol` debug change to the
master does **not** propagate to the workers that actually serve requests.
`kerberos-audit-enable` therefore `smbcontrol`s each KDC **worker** PID (found via
the `:88` listener) to `kerberos:3`. This is **runtime-only** — a DC restart
resets it (re-run enable). Persisting it would require the samba-ad-lab image to
start samba with `--debuglevel='1 kerberos:3'` (out of this plugin's scope).

## Detection nuance (important)

The KDC issues a service ticket with the target account's **strongest available
key**. So a client that *requests* RC4 (`etypes=23`) against an AES-capable
account still receives an **AES** ticket (`etype=18/18`) — the downgrade attempt
fails. The tool records and flags **both**:

- **requested RC4** (`etypes` contains 23/24) — the attacker's downgrade attempt,
  visible even when the KDC gives AES; and
- **issued RC4** (`etype=…/23`) — an actually-weak ticket, which happens when the
  target account only has an RC4 key (see `kerberos-roast-exposure`).

The highest-fidelity posture control is therefore to **harden SPN accounts to
AES-only** (`msDS-supportedEncryptionTypes = 0x18`), after which no RC4 ticket can
be issued regardless of what a client requests.

## Notes / limits

- Auditing and log parsing are per-DC; a client can hit any DC, so enable and
  read across all DCs (the default) — or scope with `--dc`.
- `log.samba` rotates; this reads the current file (recent history), not an
  archive. For durable retention, ship the KDC audit to a SIEM.
- `kerberos-anomalies` thresholds are tunable; tune per environment, and expect
  legitimate high-volume services (scanners, multi-service apps) — exclude known
  ones rather than lowering the bar until they are noise.
