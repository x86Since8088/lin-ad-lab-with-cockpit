# edy-proxy-go integration: CA, agent, client-auth certs

Every lab container (dc1–dc5, client1–client10, rdp1, rdp2) carries the
edy-proxy-go controller's trust anchor and an enrolled `edy-agent`, giving
each one a controller-signed client-auth certificate.

| Piece | Where | How |
|---|---|---|
| CA cert | `/usr/local/share/ca-certificates/edy-proxy-ca.crt` + OS bundle | fetched from `GET /api/ca`, compiled by `update-ca-certificates` |
| agent | `/usr/local/bin/edy-agent` | copied from the controller's `agent-dist` staging dir |
| client cert | `/etc/edy-agent/agent.crt` (+ `agent.key`, mode 600) | enrollment: key generated in-container, CSR signed with PKI profile `machine` (ClientAuth+ServerAuth, 1 year) |

Lifecycle: `./40-agent.sh` installs/repairs everything (idempotent);
`./45-agent-verify.sh` is the acceptance gate. Both run as root via the job
runner, like every other lab script.

## Decisions that are easy to un-learn

- **Server URL is `https://172.16.4.1:8444`.** The controller does not listen
  on the containers' own gateway (172.15.4.1) — only DNS lives there
  (aardvark). 172.16.4.1 is a host address, so the lab subnet reaches it
  through the gateway in one hop, and the 8444 leaf cert carries an IP SAN
  for it. HTTP on 8080 also works but would force `--insecure`, which
  silently disables self-update.
- **Enrollment pins the leaf fingerprint** (`--ca-fingerprint`, read live
  from `/api/cert-pinning`) instead of `--insecure`. After enrollment the
  anchored CA makes verification ordinary.
- **`--manage-dns=false` always.** The agent's default prepends the
  controller as a resolver on the interface that routes to it. Inside this
  lab that puts a non-AD resolver ahead of the DCs and breaks SRV
  resolution — the exact failure class 30-verify.sh exists to catch.
- **GUIDs are pinned in `agent-guids.txt`.** The CN
  (`<guid>.agents.ad.edt1.lab`) is the agent's identity; the hostname is
  cosmetic. Pinning `--proposed-guid` means a recreated container re-enrolls
  as the *same* fleet entry instead of accumulating duplicates.
- **No systemd in the containers**, so the agent runs as a detached exec
  session (`podman exec -d`). Self-update still works: restart-mode defaults
  to `exec`, which replaces the process in place. The image entrypoints
  restart an already-enrolled agent after a container restart; a full
  RECREATE (20-up.sh) wipes the overlay, so **re-run 40-agent.sh after any
  20-up.sh** — enrollment state is intentionally not a volume.
- **Tokens and admin credentials never touch argv or logs.** Invitation
  tokens are minted per container (single-use, 1h TTL) and passed on stdin;
  the admin credential goes to curl via `-K -`. Job-runner `output.log` is
  group-readable — treat it as public within the host.
- **Renew over mTLS cannot work against an http-only listener.** The agents
  talk to the https listener, so this should not bite; if renew failures
  appear in `/var/log/edy-agent.log` (in-container), check that 8444 still
  terminates TLS in the Go server itself. Certs last 1 year from enrollment
  (2026-08-31); worst case, wipe `/etc/edy-agent` in the container and re-run
  40-agent.sh to re-enroll under the same pinned GUID.
