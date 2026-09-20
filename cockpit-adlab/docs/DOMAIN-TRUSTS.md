# Parent domains & forest trusts

## The samba constraint

Samba AD is **single-domain-per-forest**. `samba-tool domain join` only does
`DC | RODC | MEMBER` (join an *existing* domain), and `samba-tool domain
provision` only creates a *forest root*. There is **no child/subdomain/tree
domain** support. So you cannot make a domain an in-forest child of a parent.

What samba *does* support is **domain and forest trusts** (`samba-tool domain
trust create`). That is how this plugin realizes "specify a parent domain to
join a forest": the new domain is its own forest, provisioned next to the parent
and linked to it with a trust.

## `domain-add --parent <realm>`

With `--parent`, the new domain is:

- provisioned as its own forest (same as always — samba can't do otherwise), but
- placed on the **parent's podman network** (each child gets its own address
  block starting at `.50`), so its DC can reach the parent DC, and
- labelled with its parent (`adlab.parent`, shown by `domain-list` and in the UI).

A **contiguous `CHILD.parent` namespace** (e.g. `CORP.AD.EDT1.LAB` under
`AD.EDT1.LAB`) best emulates a child domain — same DNS tree, linked by a trust.

Provisioning is asynchronous, so establish the trust once the child's DC is up.

## `domain-trust-create`

```
domain-trust-create --realm CORP.AD.EDT1.LAB --parent AD.EDT1.LAB \
    [--type forest|external] [--direction both|incoming|outgoing]
```

Runs on the local (child) DC and creates the trust on **both sides**
(`--create-location=both`). It:

- reaches the partner DC by IP (`--ipaddress`) and adds a temporary resolver
  entry so the partner realm resolves;
- authenticates to the partner with an **authfile** (`-A`), never a password on
  the command line (all lab domains share the mounted admin credential);
- defaults to a **forest** trust, **both** directions.

`domain-trust-list [--realm]` shows the configured trusts; `domain-trust-delete
--realm [--parent]` removes one (both sides).

## Limits

- These are **separate forests linked by a trust**, not a single multi-domain
  forest — that is the best samba can do.
- For cross-realm authentication to fully work you generally also need DNS name
  resolution between the forests (a conditional forwarder each way). On the shared
  network the trust creation adds a resolver entry for setup; durable two-way
  resolution across restarts is an environment concern (the DC entrypoint rewrites
  `resolv.conf` to itself on start).
- Trust creation and deletion are **danger** operations and require the partner
  to be reachable and provisioned.
