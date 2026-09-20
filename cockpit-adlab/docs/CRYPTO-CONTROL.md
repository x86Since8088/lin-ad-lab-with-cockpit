# Crypto control plane

A schema-backed **Crypto** tab to enable or disable encryption per *situation*
across the lab. The `crypto-catalog` verb enumerates every setting with its
current value, allowed choices and the hardened recommendation; the set verbs
apply changes. Two mechanisms, by situation:

- **Directory (live, `ldbmodify`)** — per-account, bulk, and krbtgt Kerberos
  encryption types (`msDS-SupportedEncryptionTypes`). Takes effect immediately.
- **Server (`smb.conf` + reload)** — Kerberos KDC etypes, SMB
  encryption/signing, NTLM, LDAP/TLS and schannel. Some only take full effect
  after a DC restart, and a wrong value can break authentication.

## Verbs

| Verb | Situation | What |
|---|---|---|
| `crypto-catalog` | all | Schema-backed inventory + current values (drives the tab). |
| `crypto-account-etypes --account [--set <preset>]` | account | Read/set one account's Kerberos etypes. |
| `crypto-harden --scope <s> [--preset] [--commit]` | accounts (filtered) | Bulk-set etypes; dry-run unless `--commit true`. |
| `crypto-set --id <id> --value <v>` | server | Set a server crypto param (smb.conf + reload). |

## Kerberos encryption-type presets

`msDS-SupportedEncryptionTypes` is a bitmask: `0x1`/`0x2` DES, `0x4` RC4, `0x8`
AES128, `0x10` AES256. Presets:

| preset | value | meaning |
|---|---|---|
| `aes-only` | `0x18` (24) | AES128+AES256 — hardened; no RC4 ticket can be issued |
| `aes+rc4` | `0x1C` (28) | AES + RC4 (compatibility) |
| `rc4-only` | `0x4` (4) | RC4 only (weak — roastable) |
| `all` | `0x1F` (31) | DES + RC4 + AES |
| `clear` | (unset) | removes the attribute → the account falls back to the domain/KDC default (legacy = RC4-capable) |

**Setting SPN service accounts to `aes-only` is the durable Kerberoasting
mitigation** — after it, the KDC cannot issue an RC4 (fast-cracking) service
ticket regardless of what a client requests. `crypto-harden --scope spn-users
--preset aes-only --commit true` does this in bulk; it never changes `krbtgt`
(set that deliberately with `crypto-account-etypes`).

## Harden scopes (the "filter" for the situation)

- `spn-users` — user service accounts that hold an SPN (the roast targets).
- `all-users` — every user (`objectCategory=person`).
- `computers` — every computer account (incl. DCs).

Dry-run (default) lists exactly which accounts would change (current → target)
and applies nothing.

## Server crypto settings (whitelisted)

`crypto-catalog` reads the effective value (via `testparm -v`) and marks each as
`hardened` (matches the recommendation) or `review`. `crypto-set` writes the
`smb.conf` param and sends `reload-config`. Coverage:

- **Kerberos**: `kerberos encryption types` (all/strong/legacy), `kdc default
  domain supported enctypes`, `kdc supported enctypes`, `kdc force enable rc4
  weak session keys`.
- **SMB**: `server smb encrypt`, `server signing`, `server max protocol`.
- **NTLM**: `ntlm auth`, `raw NTLMv2 auth`, `reject md5 clients`, `reject md5
  servers`, `allow nt4 crypto`.
- **LDAP/TLS**: `ldap server require strong auth`, `tls enabled`.
- **Schannel**: `server schannel`, `server schannel require seal`.

## Notes / limits

- `crypto-set` and `crypto-harden --commit` are **danger** operations — a bad
  value or an over-broad AES-only push (against accounts that hold only RC4 keys)
  can break authentication. `testparm` reflects the *file*; a running process may
  need a restart for some params to take effect.
- `crypto-set` only accepts the whitelisted ids from `crypto-catalog` and
  validates the value against that setting's `choices`, so it cannot write an
  arbitrary smb.conf key.
- These controls are the enable/disable side of the same coin as
  `kerberos-roast-exposure` / `kerberos-anomalies` (detection): see
  `docs/KERBEROS-ANOMALIES.md`.
