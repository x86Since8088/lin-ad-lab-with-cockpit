# AD PKI (CA node + domain-integrated templates)

A schema-backed **PKI** tab and `pki` verb group that stand up a working,
domain-integrated public-key infrastructure for the lab.

Samba provisions the *Public Key Services* container tree under
`CN=Public Key Services,CN=Services,CN=Configuration,<forestDN>` (Certificate
Templates, Enrollment Services, Certification Authorities, AIA, CDP, KRA, OID)
but leaves it **empty** — and samba is only a certificate *consumer*, never a
CA. So the feature splits in two:

- **A CA node** — a dedicated openssl-CA container (`adlab-ca`, from the DC
  image, on the lab network at `<prefix>.60`) with its own self-signed
  Enterprise Root CA and persistent material on the host at `/var/lib/adlab/ca`.
  It issues leaf certificates per template.
- **Domain integration** — native `ldb` writes on the PDC emulator that publish
  the CA into AD and create real `pKICertificateTemplate` objects.

Enrollment is **manual** (via `pki-issue`): openssl cannot speak MS-WCCE/XCEP
autoenrollment, which needs a Windows/EJBCA CA. That is honest scope for a lab —
everything else (trust, templates, issuance, verification) works end to end.

## What "Publish to AD" creates

| Object | DN (under Public Key Services) | Class | Effect |
|---|---|---|---|
| Root trust | `CN=<CA>,CN=Certification Authorities` | `certificationAuthority` | Members map it into their Trusted Root store. |
| AIA | `CN=<CA>,CN=AIA` | `certificationAuthority` | Chain building. |
| NTAuth | `CN=NTAuthCertificates` | `certificationAuthority` | Permits smartcard/PKINIT cert logon. |
| Enrollment service | `CN=<CA>,CN=Enrollment Services` | `pKIEnrollmentService` | Advertises the CA + its template list. |

`certificationAuthority` **mustContain** `cn`, `cACertificate`,
`authorityRevocationList` and `certificateRevocationList`, so publish generates
an (empty) CRL on the CA node and supplies it for the two CRL attributes. All
writes are idempotent — re-running refreshes the certificates in place.

## Templates

`pki-template-seed` creates V2 `pKICertificateTemplate` objects (schema version 2)
from a standard catalog. Each template is both an AD object *and* the issuance
policy `pki-issue` applies:

| Template | EKU | Key | Validity |
|---|---|---|---|
| DomainController | serverAuth + clientAuth | 2048 | 1y |
| WebServer | serverAuth | 2048 | 1y |
| Workstation | clientAuth | 2048 | 1y |
| User | clientAuth + EFS + email | 2048 | 1y |
| SmartcardLogon | smartcardLogon + clientAuth | 2048 | 1y |
| CodeSigning | codeSigning | 3072 | 3y |

The binary MS-CRTD attributes are encoded exactly as Windows stores them:
`pKIExpirationPeriod`/`pKIOverlapPeriod` are 8-byte little-endian negative
FILETIME durations, `pKIKeyUsage` is a 2-byte octet string. `msPKI-Certificate-Name-Flag`
is `1` (ENROLLEE_SUPPLIES_SUBJECT) because issuance is manual — the subject/SAN
come from `pki-issue`, not from AD autoenrollment.

## Verbs

| Verb | What |
|---|---|
| `pki-status` | One-call overview (CA node, root CA, AD registration, counts) — drives the tab. |
| `pki-ca-deploy [--cn --days --key_bits]` | Deploy the CA node + generate the root CA. Idempotent. |
| `pki-ca-status` | CA node/root detail + AD-publish state. |
| `pki-ca-destroy [--wipe]` | Remove the CA container (keeps material unless `--wipe true`). |
| `pki-ca-publish` | Publish root into AD (root-trust/AIA/NTAuth/enrollment). Idempotent. |
| `pki-ca-unpublish [--ntauth]` | Remove the AD registration. |
| `pki-ntauth-list` | CAs trusted for cert logon (NTAuthCertificates contents). |
| `pki-template-list` | Templates in AD + the seedable catalog. |
| `pki-template-seed [--name]` | Create the standard templates (or one). Idempotent. |
| `pki-template-delete --name` | Delete a template. |
| `pki-issue --template --cn [--sans --days]` | Issue a leaf per the template; returns the cert PEM. |
| `pki-cert-list` | Certificates the CA node has issued. |

## Notes / limitations

- **Manual enrollment only** — no WCCE/XCEP autoenrollment (no Windows CA).
- **Synthetic template OIDs** — `msPKI-Cert-Template-OID` is a unique per-template
  OID string; samba does not enforce the link to an `msPKI-Enterprise-Oid` object
  under `CN=OID`, so none is created. Sufficient for the lab.
- **Root CA only** — a single self-signed root (no subordinate/issuing tier);
  `pathlen:1` leaves room to add one later. CRLs are LDAP-empty (HTTP CDP not used).
- Directory writes target the PDC emulator and replicate to every DC.
