# Sandbox daemon — Go rewrite

A Go reimplementation of the sandbox daemon (`packages/sandbox/daemon`, TypeScript
on Bun). One daemon runs per `(user, project)` sandbox pod and owns the
workspace: clone, dependency install, dev-server supervision, fs/git/exec
routes, the reverse proxy, and harness dispatch.

**Status: passes the full daemon conformance suite (176/176), same as the TS
daemon.** Not wired into any deploy path — the sandbox image still ships the TS
daemon. Several production behaviors are unported; see [Gap ledger](#gap-ledger).

## Why Go

Go's runtime dissolves the bug class that actually paged us: a blocked
single-threaded event loop starving the daemon's HTTP health probe, which Studio
reads as *dead* and tears the sandbox down (`CONTRIBUTING.md` rule #1 — the
`gitAsync` split and the thread-links self-mount deadlock were both this). Rust
would keep that hazard alive as `spawn_blocking` discipline. `x/net/webdav`,
`creack/pty`, and `fsnotify` cover the subtle modules, and it is one new
language shared with the sandbox-controller track.

Trade accepted: weaker compile-time state machines than Rust. Sending on a
closed channel still panics in Go, so the dispatch-storm invariant stays a named
test rather than a type.

## The acceptance contract

`packages/sandbox/daemon/daemon.e2e.*.test.ts` is a black-box HTTP/SSE
conformance suite over the daemon. It imports no daemon source, so it drives any
implementation that honors the env startup contract. Point `DAEMON_E2E_CMD` at a
different binary and nothing else changes.

```bash
# build both sides
bun run --cwd=packages/sandbox build:daemon          # TS bundle (the baseline)
go build -o bin/daemon .                             # this daemon

# the suite, against the Go daemon
cd packages/sandbox
DAEMON_E2E_CMD="$PWD/daemon-go/bin/daemon" bun test daemon/daemon.*e2e*.test.ts

# drop DAEMON_E2E_CMD for the TS baseline
bun test daemon/daemon.*e2e*.test.ts

# Go unit tests (guardrails the black-box suite can't see)
cd daemon-go && go test ./...
```

Startup contract, read from the environment at boot: `DAEMON_TOKEN` (bearer for
every `/_sandbox/*` route), `APP_ROOT` (workspace root; every user-supplied path
is clamped to it), `PROXY_PORT`, `DAEMON_BOOT_ID`.

### What the suite does *not* prove

- **Harness dispatch.** `daemon.dispatch.e2e.test.ts` is contract-only — it
  asserts the gates that fire *before* a harness streams (bearer auth, bad
  JSON, missing `harnessId`/`runId`, malformed input envelope, run
  cancellation), never a real run. A real run needs model providers and MCP. The harness bridge is unverified by tests; it was verified once by
  hand against real `claude-code`.
- **Anything in the [gap ledger](#gap-ledger).** These are unported *and*
  untested — the suite passing is not evidence they work.
- **uid/gid drop.** Settled: the sandbox image runs `USER sandbox` (uid 1000)
  with no k8s `runAsUser` override, and Go's `applyUidDrop` is guarded by
  `os.Geteuid() != 0` — so the drop is a no-op in prod, exactly as under Bun. It
  engages only if the daemon is run as root, where dropping to 1000 matches the
  workspace's ownership. Pinned by `internal/gitx/uiddrop_test.go`.

## Package map

| Package | TS counterpart | Owns |
| --- | --- | --- |
| `internal/routes` | `daemon/routes/` | HTTP handlers: fs, git, tasks, exec, bash, config, events, tools |
| `internal/setup` | `daemon/setup/` | Orchestrator state machine: clone → install → start |
| `internal/gitx` | `daemon/git/` | git porcelain, publish, rebase, checkout, protected branches |
| `internal/proc` | `daemon/process/` | PTY spawn, task manager, log tee, ring buffer, port sniffer |
| `internal/proxy` | `daemon/proxy.ts`, `ws-proxy.ts` | HTTP + WebSocket reverse proxy to the dev server |
| `internal/dispatch` | `daemon/routes/dispatch.ts` | `/dispatch` gates, SSE framing, harness-runner subprocess |
| `internal/config` | `daemon/config-store/` | Workload config store, merge, classify, persistence |
| `internal/events` | `daemon/events/` | Lifecycle SSE broadcaster + replay buffer |
| `internal/toolscatalog` | `daemon/tools-catalog.ts` | `/tools/sync`: Virtual MCP catalog → `.deco/tools/` |
| `internal/lifecycle`, `internal/probe` | `daemon/lifecycle/`, `probe.ts` | Lifecycle state machine, dev-server health probe |
| `internal/orgfs` | `daemon/org-fs/` | Org-fs mount config parsing **only** (see gaps) |

`internal/toolscatalog` carries its own minimal MCP client (Streamable HTTP:
`initialize`, `notifications/initialized`, paged `tools/list`) instead of an MCP
SDK. The daemon never calls tools itself — the in-workspace typegen CLI does,
reading the `.endpoint.json` this writes — so a full SDK would be dead weight.

## Carried invariants

Behaviors with no local justification in the code that reads like a bug if
"cleaned up". Each was a production incident in the TS daemon.

- **Protected-branch block lives in code, not just the hook.** `publish` pushes
  `--no-verify`, which skips pre-push hooks entirely, so the hook alone lets a
  sandbox push straight to `main`. Both must exist, and the block must fire
  *before* the commit so no stray commit lands on a protected branch either.
  The protected set is `{main, master, origin's actual default}` — plenty of
  repos use `trunk`/`develop`. (`internal/gitx/publish.go`, `checkout.go`)
- **`--no-verify` on publish's push is deliberate.** A repo's own pre-push hook
  can fail or hang; the shutdown sync shares this path and has no room to wait
  it out before the pod's grace period elapses and SIGKILL drops unsynced work.
- **Upstream failures are WebSocket closes, not HTTP errors.** Once a browser
  has sent an upgrade it only surfaces close codes — a 502 on the upgrade reads
  as a protocol error (1002). Complete the 101, *then* send close 1011 with
  `no upstream dev server` / `upstream not reachable`. (`internal/proxy/ws.go`)
- **The catalog dir is `.git/info/exclude`d.** Otherwise the shutdown
  `git add -A` commits daemon-managed files onto the user's branch.
- **The endpoint file is a dotfile at 0600.** Dotfile so the catalog prune
  (which targets non-dot `*.json`) never eats it; 0600 because it holds a bearer
  credential.
- **Golden-cache publish happens only after a health signal.** Publishing a
  broken cache poisons every later boot.

## Gap ledger

Unported and untested. Each is a real production behavior of the TS daemon.

| Gap | Consequence today |
| --- | --- |
| **Org-fs mounting.** `internal/orgfs` parses `OrgFsMountConfig` and stops. No WebDAV mount, sidecar, repo-link, invalidator, or detach. | Org volumes never appear in the workspace. |
| **Golden cache.** `Orchestrator.PublishPendingGolden()` is a no-op; no L1 reflink, no L2 remote archive (`setup/remote-golden.ts`). | Every boot pays a full dependency install. This is the dominant boot cost. |
| **`fsnotify` is in `go.mod` but unused** — file watching is a 3s poll. | Slower change detection than the TS daemon; wasted wakeups. |
| **Per-phase boot timing** (clone → install → start → first healthy probe). | G3 can't attribute a boot regression to a phase. New telemetry for *both* daemons — needs a line schema and a panel before either emits it. |
| **Catalog sync on dispatch.** TS wires `makeCatalogSync` into dispatch's `onDispatchMcp` (coalesced, 60s min interval). Go serves `/tools/sync` only. | The catalog is not refreshed automatically per run. |
| **Install runs as one `sh -c` chain.** TS models it as two structured commands (corepack argv, then install argv); Go keeps `corepack … && cd … && <install>` because the chain needs a shell. | Divergence only. The interpolated values are a config path and a package-manager command from a fixed table, not free text. |

### Closed since the ledger was written

| Was | Now |
| --- | --- |
| Decofile block validation unported | `internal/decofile` + both publish dispositions (`throw` / `skip`), unit + e2e |
| `force-push` with lease, `fast-forward-to-base` | `gitx.ForcePushWithLease`, `gitx.FastForwardToBase`, wired into publish's reconcile path and the boot path; e2e for both |
| `resolve-shell`, `structured-command` | Daemon-owned git steps (clone, checkout) now spawn **argv**, never `sh -c`. `resolve-shell` itself is win32-only and deliberately not ported — this daemon ships linux-only |
| OTLP metrics/tracing | Not an OTLP job: a sandbox pod's egress is locked to 53/443, so no collector is reachable — the TS daemon emits JSON log lines. `internal/setup/depmetrics.go` matches that contract byte for byte (`sandbox.deps.restore`, chunked `sandbox.deps`) |

## Open decision: harness-runner transport

`/dispatch` runs the `claude-code` / `codex` harnesses, which are TypeScript and
can only be embedded by a TS process. Both tracks agree the harness moves to a
subprocess behind a seam — they disagree on the seam:

- **This daemon** (`internal/dispatch/dispatch.go`): spawns `HARNESS_RUNNER_CMD`
  per run, writes the request frame to **stdin**, reads NDJSON events from
  stdout.
- **`wt/harness-runner-extraction`** (TS, branch also on origin): spawns the
  daemon's own bundle with `HARNESS_RUNNER_MODE=1`, reads
  `HARNESS_RUNNER_READY <port>` from stdout, then **POSTs `/run` over loopback
  HTTP** with a per-spawn bearer token, answered `200 application/x-ndjson`.
  Cancellation is aborting the request; the runner is long-lived and supervised.

Both carry the same NDJSON event stream, so only the transport and the runner
lifetime differ. **Pick one before wiring either into a deploy path** — stdio is
simpler to supervise and needs no port or token; loopback HTTP keeps one warm
runner across runs and already has an e2e
(`daemon.harness-runner.e2e.test.ts`, on that branch).

## Related

- `packages/sandbox/README.md` — the sandbox subsystem end to end
- `CONTRIBUTING.md` rule #1 — no blocking work on the daemon's event loop; the
  constraint that motivated this rewrite
- `wt/sandbox-controller-go` (local branch) — the sibling track extracting
  Studio's k8s sandbox orchestration into a Go control-plane service
