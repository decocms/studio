# sandbox daemon (Go)

The daemon that runs inside every Studio sandbox. One static binary, PID 1 of the
sandbox pod, listening on `PROXY_PORT` (9000 in the image). It is the only daemon
implementation — the TypeScript daemon it replaced was deleted.

| Attribute | Value |
| --- | --- |
| Module | `github.com/decocms/studio/sandbox-daemon` |
| Runtime | Go (CGO disabled, cross-compiled for linux/amd64 + linux/arm64) |
| Ships in | `ghcr.io/decocms/studio/studio-sandbox-go` (see `../image/Dockerfile`) |
| Contract tests | `../daemon-e2e/` (black-box HTTP/SSE) |

## Responsibilities

Clone and set up the repo, install dependencies, run the dev script and other
project tasks under a PTY, serve filesystem and Git operations, dispatch agent
harness runs and stream their output as SSE, proxy preview HTTP/WebSocket traffic
to the dev server, publish work back to git on shutdown, and report health so
Studio can tell a live sandbox from a dead one.

### Dispatch is single-writer per run

One run id, one harness. A dispatch for a run that is already in flight is a
TAKEOVER: the daemon cancels the run it displaces, waits for that process group
to die, and only then execs the replacement. Studio sends exactly that when the
pod driving a run was replaced and another picked the work up, and the invariant
it buys is that two `claude` processes never share one checkout.

Two properties the consumer depends on, both asserted in `daemon-e2e/`:

- **Every run ends with a `done` frame** — clean finish, crash, or cancel. A body
  that ends without one means the connection died, not the run, and only that
  case may be continued elsewhere.
- **A streaming or keepalive-ticking run counts as activity** (`/idle`). Without
  it a run that has been producing output for an hour reports as untouched since
  its dispatch request arrived, and the idle reaper deletes the pod mid-turn.

## Layout

| Path | What it owns |
| --- | --- |
| `main.go` | Env contract, wiring, HTTP server, shutdown |
| `internal/routes/` | HTTP surface: `/health`, `/_sandbox/*`, fs, git, bash, exec, tasks, tools, events |
| `internal/setup/` | Clone, install, golden cache, dep metrics, orchestration |
| `internal/dispatch/` | Agent run dispatch, harness runner, offloaded fetch |
| `internal/gitx/` | Git: checkout, rebase, publish, branch status, protected-branch guard |
| `internal/proc/` | PTY spawn, task manager, log tee, ring buffer, port sniffer |
| `internal/config/` | Tenant config store: classify, merge, validate, persist |
| `internal/events/` | SSE broadcast and replay |
| `internal/orgfs/` | Links half of org-fs (the privileged mounter is the sidecar in `../orgfs/`) |
| `internal/proxy/` | Preview HTTP + WebSocket proxy |
| `internal/probe/`, `internal/lifecycle/` | Health probe and lifecycle state |
| `internal/auth/`, `internal/urlallow/` | Bearer-token auth and the offload-fetch allowlist |
| `internal/telemetry/` | OTLP metrics export |
| `internal/worktree/` | Worktree lock |

## Startup contract

Set by the sandbox template, not by the daemon:

| Env | Meaning |
| --- | --- |
| `DAEMON_TOKEN` | Bearer token required by mutating and control-plane routes |
| `DAEMON_BOOT_ID` | Boot identity echoed by `/health`; how Studio detects a restart |
| `APP_ROOT` (or `WORKDIR`) | Workspace root — `repo/` checkout, daemon state, log tees |
| `PROXY_PORT` (or `DAEMON_PORT`) | Listen port |
| `OFFLOAD_ALLOWED_HOSTS` | Allowlist for offloaded fetch; empty fails closed |
| `ORGFS_SIDECAR_CONFIG_PATH` / `ORGFS_SIDECAR_STATUS_PATH` | Org-fs relay to the mounter sidecar; org-fs is inert without them |

`/health` is unauthenticated on purpose: Studio polls it and marks the sandbox
**dead on a single miss**, so never block that path behind slow I/O or a held
lock.

## Development

```bash
go build -o bin/daemon .          # the binary daemon-e2e defaults to
go vet ./... && go test -race ./...
```

Then the conformance suite, from the repo root:

```bash
bun test packages/sandbox/daemon-e2e/daemon*.e2e.test.ts
```

Those assertions are HTTP-only and implementation-agnostic — point
`DAEMON_E2E_CMD` at another binary to hold it to the same contract. CI
(`.github/workflows/sandbox-daemon.yml`) runs vet, unit tests, the suite, and a
Docker boot smoke test on every PR touching this package.

## Boundaries

- Nothing in TypeScript may import from this directory. The contract between
  Studio and the daemon is HTTP, and `daemon-e2e/` is where it is asserted.
- Route behavior changes belong here **and** in `daemon-e2e/` in the same PR.
- Treat every route parameter, filesystem path, proxy target, and dispatch frame
  as untrusted input; keep path containment at the filesystem boundary.
