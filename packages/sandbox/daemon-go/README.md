# Sandbox daemon — Go rewrite

A Go reimplementation of the sandbox daemon (`packages/sandbox/daemon`,
TypeScript on Bun). One daemon runs per `(user, project)` sandbox pod and owns
the workspace: clone, dependency install, dev-server supervision, fs/git/exec
routes, the reverse proxy, the tools catalog and the org-fs links.

**[`SPEC.md`](./SPEC.md) is the authoritative document** — contracts, carried
invariants, what is proven, what is deliberately not ported, and the production
rollout. This file is orientation only: how to build it and where the code lives.

**Status:** passes the full conformance suite, 184/184, same as the TS daemon,
enforced in CI against both. Both daemons ship in the sandbox image;
`SANDBOX_DAEMON_IMPL` (default `ts`) picks one at container start, so this daemon
is deployed and enabled nowhere.

## Build and test

```bash
# build both sides
bun run --cwd=packages/sandbox build:daemon          # TS bundle (the baseline)
cd packages/sandbox/daemon-go && go build -o bin/daemon .

# the black-box conformance suite, against this daemon
cd packages/sandbox
DAEMON_E2E_CMD="$PWD/daemon-go/bin/daemon" bun test daemon/daemon.*e2e*.test.ts

# drop DAEMON_E2E_CMD for the TS baseline
bun test daemon/daemon.*e2e*.test.ts

# Go unit tests — the guardrails the black-box suite can't see
cd daemon-go && go test -race ./...
```

The suite imports no daemon source, so it drives any implementation honoring the
startup contract (`DAEMON_TOKEN`, `APP_ROOT`, `PROXY_PORT`, `DAEMON_BOOT_ID` —
see [SPEC §3](./SPEC.md#3-startup-contract)).
`.github/workflows/sandbox-daemon.yml` runs it against both daemons and
smoke-tests the image with the switch unset and set to `go`.

## Package map

| Package | TS counterpart | Owns |
| --- | --- | --- |
| `internal/routes` | `daemon/routes/` | HTTP handlers: fs, git, tasks, exec, bash, config, events, tools |
| `internal/setup` | `daemon/setup/` | Orchestrator state machine (clone → install → start), golden cache, dependency telemetry |
| `internal/gitx` | `daemon/git/` | git porcelain, publish, rebase, checkout, protected branches, the repo watcher |
| `internal/proc` | `daemon/process/` | PTY spawn, task manager, log tee, ring buffer, port sniffer |
| `internal/proxy` | `daemon/proxy.ts`, `ws-proxy.ts` | HTTP + WebSocket reverse proxy to the dev server |
| `internal/dispatch` | `daemon/routes/dispatch.ts`, `daemon/harness-runner/` | `/dispatch` gates, SSE framing, harness-runner supervision |
| `internal/config` | `daemon/config-store/` | Workload config store, merge, classify, persistence |
| `internal/events` | `daemon/events/` | Lifecycle SSE broadcaster + replay buffer |
| `internal/toolscatalog` | `daemon/tools-catalog.ts` | `/tools/sync`: Virtual MCP catalog → `.deco/tools/`, plus the dispatch-driven re-sync |
| `internal/lifecycle`, `internal/probe` | `daemon/lifecycle/`, `probe.ts` | Lifecycle state machine, dev-server health probe |
| `internal/orgfs` | `daemon/org-fs/` | Sidecar config relay, status gate, repo link, per-run thread links |
| `internal/decofile`, `internal/urlallow`, `internal/paths`, `internal/auth`, `internal/httpx` | assorted | Block validation, SSRF allowlist, path clamping, bearer auth, JSON helpers |

`internal/toolscatalog` carries its own minimal MCP client (Streamable HTTP:
`initialize`, `notifications/initialized`, paged `tools/list`) instead of an MCP
SDK. The daemon never calls tools itself — the in-workspace typegen CLI does,
reading the `.endpoint.json` this writes — so a full SDK would be dead weight.

## Related

- [`SPEC.md`](./SPEC.md) — contracts, invariants, gaps, rollout
- `packages/sandbox/README.md` — the sandbox subsystem end to end
- `CONTRIBUTING.md` rule #1 — no blocking work on the daemon's event loop; the
  constraint that motivated this rewrite
- `wt/sandbox-controller-go` (local branch) — the sibling track extracting
  Studio's k8s sandbox orchestration into a Go control-plane service
