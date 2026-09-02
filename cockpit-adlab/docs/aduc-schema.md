# Users & Computers — how the AD schema drives the forms

The **Users & Computers** tab (dsa.msc) builds every form from the *live*
Active Directory schema instead of hard-coding fields. This note explains how
faithfully a schema that mirrors Microsoft AD can drive those forms, and where
— exactly — additional metadata is required. It is written against the lab
forest `DC=ad,DC=edt1,DC=lab`, whose Samba schema mirrors the MS AD schema
(same `classSchema`/`attributeSchema` objects, same OIDs, and the same
`DisplaySpecifiers` container).

## The three metadata layers AD actually has

A Microsoft-compatible directory exposes three distinct layers. Two are real
directory data; the third is **not in the directory at all**.

1. **`classSchema` / `attributeSchema`** — `CN=Schema,CN=Configuration,…`.
   The authoritative schema: which attributes a class may/must hold, each
   attribute's syntax, single/multi-valued, range, and write constraints.
2. **`DisplaySpecifiers`** — `CN=<locale>,CN=DisplaySpecifiers,CN=Configuration,…`
   (e.g. `CN=409` = en-US). Per-class presentation hints:
   `classDisplayName` (friendly class name), `attributeDisplayNames`
   (`ldapDisplayName,Friendly Label` pairs), context-menu and
   **`adminPropertyPages`** entries.
3. **Property-page layout** — the field list and control layout of each
   *friendly* tab (General, Account, Address…). In Microsoft ADUC this lives in
   **COM property-page extensions** (dsadmin.dll and friends), referenced only
   *by GUID* from `adminPropertyPages`. **It is not stored in the directory.**

`adminPropertyPages` on `user-Display`, verbatim from this forest:

```
adminPropertyPages: 1,{6dfe6485-a212-11d0-bcd5-00c04fd8d5b6}   # General
adminPropertyPages: 3,{B52C1E50-1DD2-11D1-BC43-00C04FC31FD3}   # Address
adminPropertyPages: 4,{FD57D295-4FD9-11D1-854E-00C04FC31FD3}   # Account
adminPropertyPages: 5,{6dfe6488-a212-11d0-bcd5-00c04fd8d5b6}   # Profile
adminPropertyPages: 6,{4E40F770-369C-11d0-8922-00A024AB2DBB}   # Telephones
adminPropertyPages: 7,{8c5b1b50-d46e-11d1-8091-00a024c48131}   # Organization
adminPropertyPages: 8,{0910dd01-df8c-11d1-ae27-00c04fa35813}   # Member Of …
```

These GUIDs tell you *which* pages a Windows box would show, and in what
order — but a GUID is a pointer to compiled UI, not a field list. So the schema
tells you *which page GUIDs and which attributes are legal*; it does **not**
tell you *which attributes each page contains*.

## What each form consults

### Attribute Editor (the **Advanced** button) — 100% schema-driven

This is the general editor, and it needs **no additional metadata** — only
`classSchema` + `attributeSchema`. The algorithm (verb `object-schema`,
`_resolve_class_attrs` + `_attr_meta`):

1. Take the object's **structural class** (last `objectClass` value).
2. Walk `subClassOf` up to `top` (which is its own parent — the terminator),
   and pull in every `auxiliaryClass` / `systemAuxiliaryClass` (and *their*
   chains). For `user` this is
   `user → organizationalPerson → person → top`, plus `securityPrincipal`,
   `mailRecipient`, `msDS-CloudExtensions`, `posixAccount`, `shadowAccount`.
3. Union `mustContain` + `systemMustContain` (mandatory) and
   `mayContain` + `systemMayContain` (optional) across that set. For `user`
   this yields **401 attributes, 7 mandatory** in this forest.
4. For each attribute, read its `attributeSchema`:
   * `attributeSyntax` (+ `oMSyntax`) → the control type (see table below),
   * `isSingleValued` → single field vs. multi-value list,
   * `rangeUpper` → max length (and long unicode strings render multi-line),
   * `systemOnly = TRUE` or `systemFlags & 0x4` (constructed, e.g. `memberOf`,
     `tokenGroups`) → **read-only**,
   * `attributeDisplayNames` (from the displaySpecifier) or `adminDisplayName`
     → the friendly label.

That is exactly the algorithm Microsoft's Attribute Editor uses. Any custom
attribute you add to the schema shows up here automatically, correctly typed —
no code change.

### Friendly tabs (General / Account / Address / …) — schema + a layout catalog

The friendly pages cannot be reconstructed from the schema alone, because the
schema never says "office phone goes on the Telephones tab." That mapping is
the COM property-page layer above, which is not in the directory.

So the plugin ships the missing layer as a small **layout catalog**
(`OBJECT_FORMS` in `adlab-admin`): per structural class, an ordered list of
tabs, each naming the attributes it shows. This mirrors what MS's property-page
DLLs hard-code, tab-for-tab (General, Address, Account, Profile, Telephones,
Organization, Member Of for `user`; General, Members, Member Of, Managed By for
`group`; etc.).

Crucially, the catalog is **layout only, never a second copy of the schema**:

* every field is validated against the live resolved may/must set — a field
  whose attribute the class can't hold is silently dropped, so the catalog
  self-heals against schema differences;
* every field's **label, control type, single/multi, max length and
  read-only-ness come from the live `attributeSchema`**, not the catalog;
* a couple of composite controls (`userAccountControl` → the flag checkboxes,
  `groupType` → scope/security) are flagged with a `kind` so the UI renders the
  Windows-style widget instead of a raw integer.

## Is additional schema required?

**No additional *directory schema* (new classes or attributes) is required** to
drive either form against a Microsoft-mirroring directory:

| Need | Source | Extra schema? |
|------|--------|---------------|
| Validation (legal attrs, mandatory, syntax, single/multi, writability) | `classSchema` + `attributeSchema` | **None** — authoritative |
| Attribute Editor (all attributes) | same | **None** |
| Friendly attribute labels + friendly class name | `DisplaySpecifiers` (`attributeDisplayNames`, `classDisplayName`) | None (already provisioned; falls back to `adminDisplayName`/ldapDisplayName) |
| Which friendly tabs exist and their order | `DisplaySpecifiers.adminPropertyPages` (identity/order only) | None |
| **Which attributes each friendly tab contains, and their layout** | **not in the directory** | **A layout catalog is required** (`OBJECT_FORMS`), mirroring MS's property-page DLLs |

In other words, the only thing the directory cannot give you is the *tab→field
layout* of the friendly pages — and that is a UI-side catalog, not a schema
extension. Two ways to supply it:

* **Curated per-class layout** (what this plugin does): faithful to ADUC,
  because it reproduces the same pages MS hard-codes. New/custom attributes are
  added by editing `OBJECT_FORMS` (one line), and they still validate/typecheck
  against the live schema.
* **Generic pages from `DisplaySpecifiers` only**: you *can* build a single
  generic "Attributes" page purely from schema (that is the Attribute Editor),
  but you cannot reproduce the *named* tabs without the layout layer.

You would only extend the **schema** itself if you introduce custom attributes
or classes — and then they appear in the Attribute Editor for free; adding them
to a friendly tab is a one-line `OBJECT_FORMS` edit, not a schema change.

## Syntax → control mapping

`attributeSyntax` OID (refined by `oMSyntax`) → UI control (`AD_SYNTAX`):

| Syntax OID | AD syntax | Control |
|-----------|-----------|---------|
| 2.5.5.8  | Boolean | checkbox / TRUE-FALSE |
| 2.5.5.9  | Integer / Enumeration | integer |
| 2.5.5.16 | LargeInteger / Interval (Int64; incl. FILETIME) | int64 |
| 2.5.5.11 | UTC / Generalized time | time |
| 2.5.5.1 / .7 / .14 | DN / DN-Binary / DN-String | object reference |
| 2.5.5.12 | Unicode string | text (multi-line when `rangeUpper` is large) |
| 2.5.5.5 / .6 / .4 / .3 | Printable/IA5 / Numeric / case-(in)sensitive string | text |
| 2.5.5.10 | Octet string / Replica-Link | binary (hex, read-only) |
| 2.5.5.17 | SID | SID (read-only) |
| 2.5.5.15 | NT Security Descriptor | descriptor (read-only) |

Multi-valued attributes (`isSingleValued: FALSE`) render as one-value-per-line
lists regardless of syntax.

## Where reads and writes go

* **Reads** run `ldbsearch -H /var/lib/samba/private/sam.ldb` directly on a
  running DC — no credentials, because the helper is root inside the container.
  The Configuration and Schema NCs are derived from the domain
  (`CN=Configuration,<domain>` / `CN=Schema,CN=Configuration,<domain>`), not
  queried, since the forest is single-domain.
* **Writes** (`object-modify`/`object-rename`/`object-delete`) go to the **PDC
  emulator** (queried live via `fsmo show`) through `ldbmodify` / `ldbrename` /
  `ldbdel`. `object-modify` emits standard LDIF:

  ```
  dn: <dn>
  changetype: modify
  replace: <attr>
  <attr>: <value>
  -
  ```

  `replace` with no values clears the attribute; `add`/`delete` are also
  supported, and binary values may be supplied base64 with a `b64` flag.

All of this is exercised by the unit suite (`TestLdifParse`,
`TestSchemaResolution`, `TestObjectSchemaVerb`, `TestObjectVerbs`) and the
`adlab-objects.spec.js` Playwright flow.
