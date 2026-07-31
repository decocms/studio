# Sandbox daemon — Go rewrite

A Go reimplementation of the sandbox daemon (`packages/sandbox/daemon`, TypeScript
on Bun). One daemon runs per `(user, project)` sandbox pod and owns the
workspace: clone, dependency install, dev-server supervision, fs/git/exec
routes, the reverse proxy, and harness dispatch.

**Status: passes the full daemon conformance suite (184/184), same as the TS
daemon, and CI runs it against both.** The sandbox image now ships both daemons;
which one runs is `SANDBOX_DAEMON_IMPL`, default `ts` — so the Go daemon is
deployed but not enabled anywhere. Remaining divergences are in the
[Gap ledger](#gap-ledger); what still needs a human is in
[PRODUCTION-READINESS.md](./PRODUCTION-READINESS.md).

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
- **The [gap ledger](#gap-ledger)'s remaining rows.** Each is now either an
  explicit won't-port or blocked on infrastructure — but a won't-port is a
  judgement, not a test result, so re-read the reason before relying on it.
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
| `internal/orgfs` | `daemon/org-fs/` | Sidecar config relay + status gate, `repo/org` link, per-run thread links. Mounting is the sidecar's (cluster) or the TS bundle's (desktop) — see gaps |

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
  broken cache poisons every later boot. The orchestrator therefore holds the
  pending publish until the probe's `running` transition
  (`PublishPendingGolden`), and a restore-hit boot publishes nothing.
- **Org-fs links are gated on the sidecar's *status*, never on the mount-point
  directory existing.** The directory is there even when the mount failed;
  linking into it silently strands the user's shared files on the pod's
  ephemeral disk. (`internal/orgfs/links.go`)
- **The `repo/org` link is created at dispatch time, not at boot.** A link in
  place first makes `git clone` refuse the non-empty directory.

## Gap ledger

| Gap | Consequence today |
| --- | --- |
| **Golden cache L2** (remote archive, `setup/remote-golden.ts`). L1 is done. | A pod landing on a cold node pays a full install even when another node is warm. `GOLDEN_CACHE_REMOTE` in the pod env is *warned about* at boot rather than honored. |
| **Per-phase boot timing** (clone → install → start → first healthy probe). | A boot regression can't be attributed to a phase. New telemetry for *both* daemons: no TS counterpart exists, so there is no contract to match — someone has to pick the line schema and build the panel first, and emitting an unread line into two daemons is worse than not emitting it. |
| **Install runs as one `sh -c` chain.** TS models it as two structured commands (corepack argv, then install argv); Go keeps `corepack … && cd … && <install>` because the chain needs a shell. | Divergence only, and **won't port**: the interpolated values are a config path and a package-manager command from a fixed table, never free text. |
| **Org-fs *mounting*** (`mount-manager.ts`, `webdav.ts`, `mounter.ts`, `invalidator.ts`, `detach-mount.ts`). | **Won't port** while this binary ships only in the sandbox image. Mounting-by-the-daemon is the desktop path (`ORGFS_CONFIG` + `ORGFS_RCLONE_PATH`, set by `link-daemon`), and the desktop runs the TS bundle. A cluster pod cannot mount at all — a privileged sidecar does, and the daemon's half of that (relay, status gate, links) **is** ported. Boot warns if `ORGFS_CONFIG` reaches this binary. |

### Closed since the ledger was written

| Was | Now |
| --- | --- |
| Decofile block validation unported | `internal/decofile` + both publish dispositions (`throw` / `skip`), unit + e2e |
| `force-push` with lease, `fast-forward-to-base` | `gitx.ForcePushWithLease`, `gitx.FastForwardToBase`, wired into publish's reconcile path and the boot path; e2e for both |
| `resolve-shell`, `structured-command` | Daemon-owned git steps (clone, checkout) now spawn **argv**, never `sh -c`. `resolve-shell` itself is win32-only and deliberately not ported — this daemon ships linux-only |
| OTLP metrics/tracing | Not an OTLP job: a sandbox pod's egress is locked to 53/443, so no collector is reachable — the TS daemon emits JSON log lines. `internal/setup/depmetrics.go` matches that contract byte for byte (`sandbox.deps.restore`, chunked `sandbox.deps`) |
| Golden cache L1 | `internal/setup/golden.go`: reflink restore/publish keyed by (repo, pm, lockfile), publish gated on the dev server's first healthy probe, TTL + per-repo cap GC. Dormant behind `GOLDEN_CACHE_ENABLED`. Unit + e2e (`daemon.golden.e2e.test.ts`, both daemons) |
| Org-fs links (the cluster half) | `internal/orgfs/links.go`: sidecar status gate, one-shot first-mount grace, `repo/org` link (+ `.git/info/exclude`), per-run `output`/`upload` thread links. e2e `daemon.orgfs.e2e.test.ts` (5 tests, both daemons) |
| Catalog sync on dispatch | `toolscatalog.Coalescer` (one sync in flight per endpoint, 60s floor), wired into dispatch's `BeforeRun`. Unit-tested incl. the burst case |
| `fsnotify` declared but unused | `internal/gitx/watch.go` watches the repo (noisy dirs and `.git/objects` skipped, watch count bounded), 250ms debounce, 3s poll kept as the safety net. Control-tested by an e2e that fails with the watcher disabled |

## How it ships

Both daemons live in the sandbox image (`image/Dockerfile` builds the Go binary
in a `CGO_ENABLED=0` cross-compile stage), and `image/start-daemon.sh` `exec`s
one of them based on **`SANDBOX_DAEMON_IMPL`** (`ts` default, `go` opt-in). Env,
not `CMD`: a `CMD` change is a rebuild, and a rebuild is not a rollback. Flipping
the chart's `daemonImpl` back routes the *next* sandbox to the TS daemon; live
sandboxes drain on the binary they started with.

`exec` matters — the daemon must be PID 1 so SIGTERM reaches it directly, since
that signal is what triggers the shutdown git publish.

## Harness-runner transport — decided: loopback HTTP

`/dispatch` runs the `claude-code` / `codex` harnesses, which are TypeScript and
can only be embedded by a TS process, so the harness lives in a runner
subprocess. Two transports were on the table; **loopback HTTP won** (owner
decision, 2026-07-30) and the stdio spawner is deleted.

Why: `wt/harness-runner-extraction` already ships that runner — `serve.ts`,
`supervisor.ts`, `client.ts`, a 249-line e2e — and its `protocol.ts` docblock
says outright that it is "the piece a non-TS daemon reimplements". Stdio had no
runner anywhere in the repo, so picking it meant *writing* an untested runner
mode and discarding tested code. Warm runner across runs is a bonus; per-run
process isolation was the thing given up.

`internal/dispatch/runner.go` is this daemon's side of that protocol:

| Step | Wire |
| --- | --- |
| spawn | argv from `HARNESS_RUNNER_CMD`, env `HARNESS_RUNNER_MODE=1` + a per-spawn `HARNESS_RUNNER_TOKEN` |
| ready | runner prints `HARNESS_RUNNER_READY {"port":N}` on stdout (30s budget) |
| run | `POST http://127.0.0.1:N/run` with that bearer, body `{harnessId, input}` → `200 application/x-ndjson`, one event per line, terminated by `{"type":"done"}` |
| cancel | abort the request; the runner tears its CLI down with it |
| death | one shared runner, spawned on demand, **never auto-respawned** — a crash costs each in-flight run one `harness_crashed`, and the next dispatch spawns fresh |

Two invariants worth not "cleaning up": the daemon holds the runner's **stdin
open and never writes** (the pipe closing is how the runner detects this daemon
died, even under SIGKILL), and the HTTP client has **no overall timeout** — a run
streams for minutes, so only the response *headers* are deadlined and
cancellation is the request context's job.

Covered by `internal/dispatch/runner_test.go`, where the fake runner is the test
binary re-executed: frame integrity, runner reuse across runs, respawn after a
mid-stream death, cancel-one-run-without-killing-the-runner, a runner that never
reports ready, and a missing binary. It cannot prove a real harness streams —
that is still G5's by-hand acceptance, and it needs the extraction branch merged
so `HARNESS_RUNNER_CMD` has something to point at.

## Related

- `packages/sandbox/README.md` — the sandbox subsystem end to end
- `CONTRIBUTING.md` rule #1 — no blocking work on the daemon's event loop; the
  constraint that motivated this rewrite
- `wt/sandbox-controller-go` (local branch) — the sibling track extracting
  Studio's k8s sandbox orchestration into a Go control-plane service
