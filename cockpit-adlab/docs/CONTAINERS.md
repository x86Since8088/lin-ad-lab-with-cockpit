# Containers page + startup supervisor

A **Containers** tab and `containers` verb group: a startup supervisor that keeps
lab containers running (5 retries, +1-minute incremental backoff), container
controls, host + per-container system info, and events/errors.

## Why

The lab's DC/client/RDP/CA containers are `podman run` with **no `--restart`
policy** — bring-up is boot-script only, and a crashed container stays down. The
supervisor is the missing auto-restart.

## The supervisor

`container-supervise` runs one pass; a systemd timer fires it every minute.

- Managed set = every lab container by naming (`dc<N>`, `<slug>-dc<N>` across all
  forests, `client<N>`, `rdp<N>`, `adlab-ca`) — never other podman workloads.
- For each container that **exists but is down**, if its next-attempt time has
  arrived and it has fewer than **5** attempts, `podman start` it.
- On failure: `attempts += 1`, and the next attempt is scheduled
  `attempts × 60s` out — i.e. **+1 minute each retry** (1, 2, 3, 4, 5 min). After
  5 failed attempts it **gives up** until reset.
- On success (or when found running again) the retry state is cleared.
- It only **starts existing** containers — it never recreates a removed one (that
  stays the lifecycle verbs' / boot scripts' job). A missing (never-created)
  container is left alone.

Retry state is a host file `/var/lib/adlab/container-supervisor.json`
(`{name: {attempts, next_try, last_error, parked}}`). **Stopping** a container from
the page parks it (`attempts = 5, parked`) so the supervisor won't fight the
operator; **Start** or **Reset retries** re-arms it.

`container-supervise-enable` installs + enables `adlab-container-supervisor.timer`
(OnUnitActiveSec=1min) whose service runs `adlab-admin container-supervise`;
`-disable` removes it. The page shows whether auto-restart is on.

## Verbs (`containers`)

| Verb | What |
|---|---|
| `container-list` | Every lab container: state/health/exit-code/restarts/IP + supervisor retry state + timer status. |
| `container-start --name` | Start a stopped container (clears its retry counter). |
| `container-stop --name` | Stop + **park** (danger). |
| `container-restart --name` | Restart (clears retry counter) (danger). |
| `container-inspect --name` | State, health, restarts, resource limits, restart policy, mounts. |
| `container-system` | Host podman version/storage/disk + lab-state tally. |
| `container-events [--name --since]` | Recent podman events for lab containers. |
| `container-errors [--name --lines]` | Down/unhealthy containers with error-filtered log tails. |
| `container-supervise` | One supervision pass (the timer's target). |
| `container-supervise-reset [--name]` | Clear a container's retry counter / un-park (no name = all). |
| `container-supervise-enable` | Install + enable the 1-minute supervisor timer. |
| `container-supervise-disable` | Remove the supervisor timer (danger). |

## The page

- **Controls** — per-container Start / Stop / Restart / inspect + Reset retries;
  top bar: Run supervisor now, Enable/Disable auto-restart, Refresh.
- **Container system** — host runtime overview + lab-state tally.
- **Events** — recent podman events.
- **Errors** — down/unhealthy containers with error-filtered log tails.
- The Containers table shows each container's supervisor state (`retry N/5 in Ns`,
  `parked`, `gave up`).

## Validation

11 supervisor unit tests (retry, +1min backoff increment, give-up, recover, park,
reset, classify, non-lab rejection) — 268 total. Backend validated live on
AD.EDT1.LAB (list/system/inspect/events/errors; a supervise pass actually started
the down `rdp1`/`rdp2` containers). UI validated in the mock-cockpit harness (all
cards, per-state controls, retry display, enable flow, stop-confirm) with zero JS
errors.
