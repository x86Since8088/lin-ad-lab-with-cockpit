# Delegation (S4U) & authentication hardening

A schema-backed **Delegation** tab and two verb groups (`delegation`, `authpolicy`)
covering Kerberos delegation and the modern authentication controls. Everything
wraps `samba-tool` run locally as root on the PDC emulator via `-H` (no credential
file — same model as the object write verbs). samba 4.23 supports the full set.

## The three delegation types

| Type | Where it lives | Verb(s) | Risk |
|---|---|---|---|
| **Unconstrained** | `userAccountControl` UF_TRUSTED_FOR_DELEGATION (0x80000) | `delegation-set-unconstrained` | **High** — the host can impersonate anyone to anything. DCs hold it by design. |
| **Constrained** | `msDS-AllowedToDelegateTo` (list of SPNs) | `delegation-add-service` / `-remove-service` | Medium — limited to named services. |
| **Protocol transition (S4U2Proxy)** | UF_TRUSTED_TO_AUTHENTICATE_FOR_DELEGATION (0x1000000) | `delegation-set-protocol-transition` | Lets constrained delegation work for any protocol. |
| **Resource-based (RBCD)** | `msDS-AllowedToActOnBehalfOfOtherIdentity` on the **target** | `rbcd-add` / `-remove` / `-show` | Medium — the target names who may impersonate to it. |

`delegation-list` is the security inventory: every account with any delegation,
classified and risk-ranked (unconstrained first). `delegation-show` reads one
account's outbound delegation.

**RBCD decoding:** `msDS-AllowedToActOnBehalfOfOtherIdentity` is a binary security
descriptor. `rbcd-show` decodes it to SDDL via samba-python
(`ndr_unpack(security.descriptor, …).as_sddl()`) and resolves each ACE SID to a
name — so you see *who* may act on behalf of the resource, not raw bytes.

**Name resolution:** delegation/RBCD writes need the exact `sAMAccountName`, so a
computer given as `web01` is resolved to `web01$` automatically (`_deleg_sam`).

## Authentication hardening

- **Protected Users** (`protected-users-list/-add/-remove`) — members get hardened
  credentials: no NTLM/DES/RC4, no delegation, and a short (~4h) TGT. Never add
  service accounts or computers that rely on those.
- **Authentication policies** (`authpolicy-list/-show/-create/-delete`) — TGT
  lifetime and allowed-to-authenticate-from/to (SDDL). `authpolicy-create`
  defaults to **audit** (`--audit`); pass `enforce=true` to enforce.
- **Authentication silos** (`authsilo-list/-show/-create/-delete` +
  `authsilo-member-grant/-revoke`) — bind user/computer/service policies and
  assign accounts.

Enforcement is by samba's KDC (needs FAST/Kerberos armoring), applied to accounts
in an assigned silo or with a policy set directly. The lab is at 2008 R2 domain
functional level — the policy/silo *objects* live under
`CN=AuthN Policy Configuration,CN=Services,CN=Configuration,<forestDN>` and are
manageable regardless; create audit-first and test before enforcing.

## Verbs

| Verb | What |
|---|---|
| `delegation-list` | Risk-ranked inventory of all delegation. |
| `delegation-show --account` | One account's outbound delegation. |
| `delegation-set-unconstrained --account --state on\|off` | Toggle unconstrained (danger). |
| `delegation-set-protocol-transition --account --state on\|off` | Toggle S4U2Proxy (danger). |
| `delegation-add-service --account --service` | Add a constrained target SPN. |
| `delegation-remove-service --account --service` | Remove one (danger). |
| `rbcd-show --account` | Principals allowed to act on behalf of a resource. |
| `rbcd-add --account --principal` | Grant RBCD. |
| `rbcd-remove --account --principal` | Revoke RBCD (danger). |
| `protected-users-list / -add / -remove` | Manage Protected Users. |
| `authpolicy-list / -show / -create / -delete` | Authentication policies. |
| `authsilo-list / -show / -create / -delete` | Authentication silos. |
| `authsilo-member-grant / -revoke` | Silo membership. |

All validated live on AD.EDT1.LAB against throwaway accounts (cleaned up).
