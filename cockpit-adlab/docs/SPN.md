# Service Principal Names (SPNs)

A Service Principal Name binds a Kerberos service instance to the account that
runs it — the multi-valued `servicePrincipalName` attribute on a **user** or
**computer** account. A client asking for a ticket to `HTTP/web01.ad.edt1.lab`
gets one encrypted with the key of whichever account holds that SPN; if the SPN
is missing, the service can't do Kerberos, and if the **same SPN is on two
accounts** the KDC can't choose and Kerberos breaks for that service.

The plugin manages SPNs three ways: a dedicated **SPNs** tab (the control plane),
an **SPNs** section on every account in the AD Objects preview, and CLI/API verbs
that mirror Windows `setspn.exe`.

## Windows `setspn` → adlab-admin

| Windows | adlab-admin verb | mechanism |
|---|---|---|
| `setspn -L <acct>` | `spn-list --account <acct>` | `samba-tool spn list` / ldbsearch |
| `setspn -S <spn> <acct>` | `spn-add --account <acct> --spn <spn>` | `samba-tool spn add` (refuses a duplicate) |
| `setspn -A <spn> <acct>` | `spn-add … --force true` | `ldbmodify` (add the value directly — `samba-tool spn add` has no `--force`) |
| `setspn -D <spn> <acct>` | `spn-delete --account <acct> --spn <spn>` | `samba-tool spn delete` |
| `setspn -Q <spn>` | `spn-query --spn <spn>` | ldbsearch `(servicePrincipalName=<spn>)` |
| `setspn -X` | `spn-find-duplicates` | ldbsearch all SPNs, group by value |
| (list every account with SPNs) | `spn-list-all` | ldbsearch `(servicePrincipalName=*)` |

Notes on the mapping:

- **`-S` is the default add.** `samba-tool spn add` refuses an SPN that is already
  registered anywhere, which is exactly `setspn -S` (add-with-duplicate-check).
  `--force true` reproduces the older `setspn -A` (add without that check). Because
  `samba-tool spn add` has no `--force`, that path writes `servicePrincipalName`
  directly with `ldbmodify`. Note it still **cannot create a duplicate**: samba's
  `samldb` module enforces SPN uniqueness at the directory level
  (`samldb_spn_uniqueness_check`), so a real collision is refused with a
  Constraint violation regardless of `--force`. Force only bypasses `samba-tool`'s
  own pre-check.
- **Account name.** A computer account may be given with or without the trailing
  `$` (`WEB01` or `WEB01$`); a user is its `sAMAccountName`.
- **SPN format.** `serviceClass/host[:port][/serviceName]`, e.g.
  `HTTP/web01.ad.edt1.lab`, `MSSQLSvc/db01.ad.edt1.lab:1433`,
  `HOST/web01`. The verb rejects an SPN with no `/` or with spaces.

## Where writes land, and reads come from

- **Reads** (`spn-list`, `spn-list-all`, `spn-query`, `spn-find-duplicates`) go to
  the first up DC via `ldbsearch` against `sam.ldb` — no credentials, because the
  helper runs as root inside the DC.
- **Writes** (`spn-add`, `spn-delete`) run `samba-tool spn` on the **PDC emulator**
  (resolved live, never hardcoded), like the other directory writes — single
  master, and SYSVOL/AD replication carries it to the rest.

## Duplicates matter

`spn-find-duplicates` (setspn -X) is the one to run when Kerberos to a service
fails intermittently: a duplicate SPN (the same value on two accounts) is a
classic cause. `spn-query` on a specific SPN also flags `duplicate: true` when the
value resolves to more than one account.

In this samba directory, though, duplicates should be **impossible to create** —
samba's `samldb_spn_uniqueness_check` refuses any write (including `--force`
`ldbmodify`) that would put an SPN on a second account. So on a healthy DC
`spn-find-duplicates` returns nothing; a non-empty result would point at
something abnormal (e.g. a replication-conflict object), which is exactly when
you want to see it.
