# Go sandbox daemon — specification

The authoritative document for the Go sandbox daemon: what it must do, what is
proven today, what is deliberately not ported, and how it reaches production.
Supersedes `PRODUCTION-READINESS.md` (folded in here) and the `docs-design/`
RFCs, which were never committed and are permanently lost. `README.md` stays as
package orientation — how to build it and where the code lives.

Written against `wt/daemon-go` @ `5ee25fc6e` (pushed to origin).

If you read the old gate ledger: G0–G2 and G5's decision are closed and now live
in §6 with their evidence; G3's L1 tier is in §6 and its L2 tier in §7; G4 is
split between §6 (the parts a laptop can prove) and §8.3's P0/P1 (the parts only
a pod can); G6 is §8. The gate names are retired — a gate that is closed is just
a row in §6.

**Status.** The daemon passes the full conformance suite, **184/184, on both
implementations**, and CI enforces that on every PR. Both daemons ship in the
sandbox image; `SANDBOX_DAEMON_IMPL` (default `ts`) picks one at container
start, so the Go daemon is deployed and enabled nowhere. What remains is a real
pod, a canary, and the targeting mechanism specified in §8 — not more daemon
code.

---

## 1. Definition of done

**A real user session — clone, install, dev server, preview, agent file/git
edits, publish — runs end to end on a Go daemon pod in prod, behind a default-off
flag, with a rollback that takes one config change and no data loss.**

Deleting `packages/sandbox/daemon` is *not* part of done. That happens after a
soak, and only once the desktop path no longer needs the TS bundle.

Three properties, in priority order, because they conflict under time pressure:

1. **No silent data loss.** A sandbox holds the only copy of the user's
   uncommitted work until publish. Anything that can drop it outranks everything
   else here.
2. **No silent divergence.** A behavior that differs from the TS daemon and is
   not asserted by a test is the failure mode this whole rewrite is exposed to.
   Prefer a test over a claim, always.
3. **Not slower to boot.** Boot cost is the sandbox's dominant user-visible
   latency. Parity is the floor, not the goal.

### Why Go

Go's runtime dissolves the bug class that actually paged us: a blocked
single-threaded event loop starving the daemon's HTTP health probe, which Studio
reads as *dead* and tears the sandbox down (`CONTRIBUTING.md` rule #1 — the
`gitAsync` split and the thread-links self-mount deadlock were both this). Rust
would keep that hazard alive as `spawn_blocking` discipline. Measured, under a
`git status` loop over 4000 dirty files: **Go worst 1ms, TS worst 186ms**,
against Studio's 500ms probe budget (§6).

Trade accepted: weaker compile-time state machines than Rust. Sending on a closed
channel still panics in Go, so the dispatch-storm invariant stays a named test
rather than a type.

---

## 2. Scope: what this daemon owns

One daemon per `(user, project)` sandbox pod. In a **cluster** pod it owns:

- the workspace lifecycle — clone → dependency install → dev-server supervision,
  with the lifecycle state machine and health probe;
- the fs / git / exec / bash / tasks routes the harness and the UI drive;
- the HTTP + WebSocket reverse proxy to the dev server (preview, HMR);
- the tools catalog (`/tools/sync` → `.deco/tools/`);
- the org-fs *links* (§4.3.2);
- graceful shutdown = git publish.

### 2.1 What it does not own in a cluster pod: harness dispatch

**`POST /_sandbox/dispatch` is dead code on a cluster sandbox.** Confirmed in
code, not assumed:

- `apps/api/src/harnesses/local-dispatch.ts` — *"This is the ONLY dispatch path
  for hosted (agent-sandbox / legacy) harnesses."* The cluster runs the harness
  **in the API process** (`InProcessSandboxClient.dispatch` → `localDispatch`:
  *"a direct call, no HTTP, no wire, no serialization"*).
- `apps/api/src/api/routes/decopilot/dispatch-run.ts` — a CLI harness *"never
  reaches a successful dispatch on this path: … on agent-sandbox it is rejected
  up front by the gate (cloud-CLI is a planned follow-up)"*.
- The only callers of the daemon's `/dispatch` are the desktop link path
  (`apps/api/src/link-daemon/handle-local-dispatch.ts`) and `apps/native/e2e`.
  Desktop runs the **TS bundle** materialized by `server/daemon-spawn.ts`, never
  this image.

Consequences, both load-bearing for the plan: a cluster canary does **not** need
the harness bridge to work, and the harness bridge cannot be validated by a
cluster canary. Re-read this section if cloud-CLI ships — it is the change that
makes `/dispatch` live in the cluster.

---

## 3. Startup contract

Read from the environment at boot. A reimplementation must honor exactly these:

| Variable | Meaning |
| --- | --- |
| `DAEMON_TOKEN` | Bearer for every `/_sandbox/*` route. Rotatable via `POST /_sandbox/config` (warm-pool sentinel → per-claim token). |
| `APP_ROOT` | Workspace root. Every user-supplied path is clamped to it. |
| `PROXY_PORT` | Port the daemon listens on. |
| `DAEMON_BOOT_ID` | Studio-injected per-boot id, echoed by `/health`; Studio re-reads it on rehydrate. |

Optional, feature-gating:

| Variable | Effect |
| --- | --- |
| `SANDBOX_DAEMON_IMPL` | Read by the *image entrypoint*, not the daemon: `ts` (default) or `go`. |
| `DEPS_CACHE_ROOT` | Root of the node-local dependency cache; per-repo keys derive under it. |
| `GOLDEN_CACHE_ENABLED` | `1`/`true` arms the golden node_modules cache. Off by default — it touches the boot install path. |
| `GOLDEN_CACHE_REMOTE` | L2 archive root. **Not implemented in Go**; boot logs a warning rather than silently ignoring it. |
| `OFFLOAD_ALLOWED_HOSTS`, `OFFLOAD_ALLOW_SAME_HOST_DEV` | SSRF allowlist for `/write_from_url` + `/upload_to_url`; fail-closed. |
| `ORGFS_SIDECAR_CONFIG_PATH`, `ORGFS_SIDECAR_STATUS_PATH` | Org-fs control volume (cluster). Presence means org-fs is expected. |
| `ORGFS_CONFIG`, `ORGFS_RCLONE_PATH` | Desktop mounting. **Unsupported in Go** — boot warns (§7). |
| `HARNESS_RUNNER_CMD` | argv of the harness-runner subprocess (§4.3.3). Unset → every dispatch answers `unknown_harness`. |

---

## 4. Contracts

### 4.1 Acceptance contract — the conformance suite

`packages/sandbox/daemon/daemon.*e2e*.test.ts` is a black-box HTTP/SSE suite. It
imports no daemon source, so it drives any implementation honoring §3. Point
`DAEMON_E2E_CMD` at a different binary and nothing else changes.

```bash
bun run --cwd=packages/sandbox build:daemon          # TS bundle (the baseline)
cd packages/sandbox/daemon-go && go build -o bin/daemon .

cd packages/sandbox
DAEMON_E2E_CMD="$PWD/daemon-go/bin/daemon" bun test daemon/daemon.*e2e*.test.ts
bun test daemon/daemon.*e2e*.test.ts                 # TS baseline
cd daemon-go && go test -race ./...                  # guardrails the suite can't see
```

**CI enforces both** (`.github/workflows/sandbox-daemon.yml`): `daemon-e2e` (TS),
`daemon-e2e-go` (`go vet` + `go test -race` + the suite via `DAEMON_E2E_CMD`),
and `docker-smoke`, which builds the image and smokes it twice — variable unset
(must land on TS) and `SANDBOX_DAEMON_IMPL=go`.

A test that passes on only one daemon does not belong in this suite. Two
categories legitimately live elsewhere: Go-only guardrails
(`daemon-go/internal/**/*_test.go`) and seams the TS daemon does not have on this
branch (the harness-runner bridge, §4.3.3).

**What the suite does not prove:** a real harness run (needs model providers and
MCP); anything in the gap ledger (§7); and behavior on pod hardware — boot
timings and the SIGTERM-inside-the-grace-period check can only be measured in a
pod.

### 4.2 Health probe

`GET /health` reports the injected `DAEMON_BOOT_ID`, readiness, and orchestrator
state. Studio polls it with a **500ms timeout**
(`packages/sandbox/server/daemon-client.ts:HEALTH_PROBE_TIMEOUT_MS`) and treats a
single miss as a dead sandbox: it tears the pod down, discarding every
uncommitted change. **No daemon-internal work may stall this handler** — that is
the property this rewrite buys, and `daemon.probe.e2e.test.ts` asserts it against
that exact budget.

### 4.3 Wire contracts the daemon must match

#### 4.3.1 Dependency telemetry — log lines, not OTLP

A sandbox pod's **egress is locked to 53/443**, so no in-cluster OTLP collector
is reachable; stdout scraped out-of-band is the only channel that leaves the pod.
The TS daemon therefore emits JSON *log lines*, and per-package data is logs
rather than metrics (per-package cardinality would wreck Prometheus). No otel
dependency belongs in `go.mod`.

`internal/setup/depmetrics.go` matches that contract byte for byte:

- `sandbox.deps.restore` — one line per dependency step: `source`
  (`l1` | `l2` | `miss` | `no-install`), `repo_hash` (credential-stripped before
  hashing), `duration_ms`, `bootId`.
- `sandbox.deps` — the installed dep set, byte-chunked under 600 bytes/line with
  `deps` as a pre-encoded JSON string. Both simpler shapes fail in the pipeline:
  one big line is truncated at 16KB, one line per dep is ~99% rate-sampled away.

Proven, not asserted: booting both daemons against the same repo produces
identical `sandbox.deps.restore` lines (modulo hash/duration/bootId), and feeding
120 deps with over-long meta through each implementation's line builder yields
**18 byte-identical lines**. Go reports `l1` once the golden cache hits; `l2`
arrives only with the remote tier, which is not implemented (§7).

#### 4.3.2 Org-fs — the cluster half

A hosted pod **cannot mount** (locked-down securityContext). A privileged sidecar
FUSE-mounts the org volumes at `<appRoot>/org/<volume>` with Bidirectional
propagation, and the two sides talk through a shared control volume:

| Path | Direction | Contents |
| --- | --- | --- |
| `ORGFS_SIDECAR_CONFIG_PATH` (`/run/orgfs/config.json`) | daemon → sidecar | The `OrgFsMountConfig` Studio POSTs to `/_sandbox/orgfs-config` post-bind (warm-pool claims reject `spec.env`, so it cannot be boot env). Relayed atomically. |
| `ORGFS_SIDECAR_STATUS_PATH` (`/run/orgfs/status.json`) | sidecar → daemon | `{ mounts: [{ volume, mountPath }] }` — what is *actually* mounted. |

The daemon's job is the links that make those volumes reachable the way the
prompts assume:

- `<repoDir>/org` → `../org`, created at **dispatch time, never at boot** (a link
  in place first makes `git clone` refuse the non-empty directory), and
  registered in `.git/info/exclude` so the shutdown `git add -A` never commits it
  to a user branch.
- `org/output` → `.outputs/<threadId>` and `org/upload` → `.uploads/<threadId>`,
  repointed per run so an agent writing the bare link path lands in the *running*
  thread's subtree. Uploads is best-effort (older sandboxes have no `.uploads`
  mount); outputs is required for the repoint to count.

Every step gates on the **status file**, never on the mount-point directory
existing: the directory is there even when the mount failed, and linking into it
silently strands the user's shared files on the pod's ephemeral disk.

First-touch grace: a freshly provisioned sandbox can take its first tool call
while the sidecar is still attaching (~2–5s after the relay), so the first call
waits up to 10s, once, fail-open.

#### 4.3.3 Harness runner — loopback HTTP (decided 2026-07-30)

The harnesses are TypeScript and can only be embedded by a TS process, so
`/dispatch` drives them through a runner subprocess. The wire is the one
`daemon/harness-runner/protocol.ts` defines on `wt/harness-runner-extraction` —
the file whose docblock says it is *"the piece a non-TS daemon reimplements"*.
`internal/dispatch/runner.go` is that reimplementation; keep the two in step.

| Step | Wire |
| --- | --- |
| spawn | argv from `HARNESS_RUNNER_CMD`, env `HARNESS_RUNNER_MODE=1` + a per-spawn `HARNESS_RUNNER_TOKEN` |
| ready | runner prints `HARNESS_RUNNER_READY {"port":N}` on stdout (30s budget) |
| run | `POST http://127.0.0.1:N/run` with that bearer, body `{harnessId, input}` → `200 application/x-ndjson`, one event per line, terminated by `{"type":"done"}` |
| cancel | abort the request; the runner tears its CLI down with it |
| death | one shared runner, spawned on demand, **never auto-respawned** |

Why this and not per-run stdio: that branch already ships the runner
(`serve.ts`), the daemon side (`client.ts`, `supervisor.ts`) and a 249-line e2e,
while **no `HARNESS_RUNNER_CMD` runner exists in this repo at all** — picking
stdio meant writing an untested runner mode and discarding tested code. The warm
runner across runs is a bonus; per-run process isolation is what was given up.

---

## 5. Carried invariants

Behaviors with no local justification in the code that read like bugs if
"cleaned up". Each was a production incident, or prevents one.

- **The protected-branch block lives in code, not just the hook.** `publish`
  pushes `--no-verify`, which skips pre-push hooks entirely, so the hook alone
  lets a sandbox push straight to `main`. Both must exist, and the block must
  fire *before* the commit so no stray commit lands either. The protected set is
  `{main, master, origin's actual default}` — plenty of repos use
  `trunk`/`develop`.
- **`--no-verify` on publish's push is deliberate.** A repo's own pre-push hook
  can fail or hang; the shutdown sync shares this path and has no room to wait it
  out before the grace period elapses and SIGKILL drops unsynced work.
- **Shutdown publishes before it unmounts or unwinds anything else.** Syncing the
  user's work is the only irrecoverable step.
- **The decofile last-resort net has two dispositions.** `throw` for interactive
  writes; `skip` for the shutdown sync — aborting that commit would lose *all* the
  user's other work.
- **Upstream failures are WebSocket closes, not HTTP errors.** Once a browser has
  sent an upgrade it only surfaces close codes — a 502 on the upgrade reads as a
  protocol error (1002). Complete the 101, *then* close 1011.
- **The catalog dir is `.git/info/exclude`d**, and so is the org link. Otherwise
  the shutdown `git add -A` commits daemon-managed files onto the user's branch.
- **The endpoint file is a dotfile at 0600.** Dotfile so the catalog prune (which
  targets non-dot `*.json`) never eats it; 0600 because it holds a bearer.
- **Golden-cache publish happens only after a health signal.** Publishing a
  broken cache poisons every later boot; the orchestrator holds the publish until
  the probe's `running` transition, and a restore-hit boot publishes nothing.
- **Org-fs links gate on the sidecar's status, not on the directory.** See
  §4.3.2.
- **The `repo/org` link is created at dispatch time, not at boot.**
- **The daemon holds the harness runner's stdin open and never writes to it.**
  The pipe closing is how the runner detects this daemon died, including under
  SIGKILL.
- **The runner HTTP client has no overall timeout.** A run streams for minutes; a
  deadline would cut a working agent off mid-answer. Only the response headers
  are deadlined; cancellation is the request context's job.
- **uid/gid drop is conditional on being root.** `applyUidDrop` is guarded by
  `os.Geteuid() != 0`, and the image runs `USER sandbox` (uid 1000) with no k8s
  `runAsUser` override — so the drop is a no-op in prod, exactly as under Bun
  (which silently ignored spawn uid/gid). It engages only under root, where
  dropping to 1000 matches the workspace's ownership. Pinned by
  `internal/gitx/uiddrop_test.go` so a future edit cannot make it unconditional.

---

## 6. Implemented, with evidence

Conformance suite: **184/184 on both daemons** (Go 38.6s wall clock, TS 69.3s).

| Area | Evidence |
| --- | --- |
| Workspace, git, proxy, tasks, events, config, tools catalog | The conformance suite, on both daemons, in CI |
| Decofile block validation | `internal/decofile` + both publish dispositions; unit table + 5 e2e (write, edit, publish-throw, shutdown-skip) |
| SSRF fail-closed | `internal/urlallow` gates `/write_from_url` + `/upload_to_url` (they had **no** validation in either daemon); 17-case unit table + redirect tests + 11 e2e |
| Protected-branch guard | e2e: 409 on `main`, and HEAD unmoved so no stray commit |
| `force-push` with lease, `fast-forward-to-base` | `gitx.ForcePushWithLease` / `gitx.FastForwardToBase`; e2e for diverged-origin reconcile, for shutdown *not* reconciling, and for boot fast-forward (control-tested — fails without the implementation) |
| Catalog prune-on-resync | e2e: stale tool file removed, survivors kept, `.endpoint.json` spared |
| Dependency telemetry | Byte-identical to TS (§4.3.1) |
| Structured logs | `log/slog` on stdout with an explicit `level=`, guarded by `logging_test.go`. Stderr means error — the previous default inflated every pod's error rate |
| Golden cache L1 | `internal/setup/golden.go`: reflink restore/publish keyed by (repo, pm, lockfile), health-gated publish, 7-day TTL + 5-per-repo cap GC, dormant behind `GOLDEN_CACHE_ENABLED`. Unit: key isolation, lockfile hashing, kill switch, GC bounds, and a real reflink round trip asserting CoW independence where the filesystem supports it. e2e: an install-fine/never-healthy boot publishes nothing **and never attempts it** (`d.stdout` carries no `[golden]` line — a store-only check would pass on a non-CoW filesystem while the gate was broken) |
| Per-repo cache isolation (a security boundary, not an optimization) | `TestGoldenRoundTrip`: repo B cannot restore repo A's golden for a byte-identical lockfile. `TestGoldenNodeModulesPath`: neither repo's path nests inside the other's |
| Org-fs links | `internal/orgfs/links.go` + `daemon.orgfs.e2e.test.ts` (5 tests, both daemons): output/upload point at the calling thread and repoint across threads; nothing is linked while the sidecar reports no live mount; a non-single-segment threadId is refused; a repo tracking its own `org/` is never shadowed; a pod with no sidecar env stays inert. Unit test pins the one thing the e2e cannot see — a failed repoint is never memoized |
| Catalog sync on dispatch | `toolscatalog.Coalescer` (one sync in flight per endpoint, 60s floor), wired into dispatch's `BeforeRun`; unit tests cover a 20-way burst, the interval floor, per-endpoint keying, and a run with no MCP endpoint |
| File watching | `internal/gitx/watch.go` (noisy dirs and `.git/objects` skipped, watch count bounded at 4096, 250ms debounce, 3s poll retained as the safety net). Its e2e is **control-tested**: with the watcher disabled the daemon fails it, because only the fs routes would report writes — and a CLI harness edits through `bash` |
| Probe under load | `daemon.probe.e2e.test.ts` samples `/health` for 4s while `git status` runs over 4000 untracked files, against the real 500ms budget. Measured: **Go p50 0ms / p95 0ms / worst 1ms; TS p50 22ms / p95 60ms / worst 186ms**. Both pass — TS's worst case is 37% of the budget before a slower node or a bigger repo enters the picture |
| Harness-runner bridge | `internal/dispatch/runner_test.go`, where the fake runner is the test binary re-executed: frame integrity, runner reuse across runs, respawn after a mid-stream death, cancelling one run without killing the runner, a runner that never reports ready, a missing binary |
| Runtime binary selection | `image/start-daemon.sh` (`exec`, so the daemon is PID 1 and SIGTERM still triggers the publish) + chart value `daemonImpl`; CI smokes the image unset and `=go` |

---

## 7. Gaps and won't-ports

| Item | Disposition |
| --- | --- |
| **Golden cache L2** (remote archive, `setup/remote-golden.ts`) | **Gap.** A pod landing on a cold node pays a full install even when another node is warm. `GOLDEN_CACHE_REMOTE` is warned about at boot rather than silently ignored. Blocked on infrastructure, not on this daemon. |
| **Per-phase boot timing** (clone → install → start → first healthy probe) | **Deferred by decision.** New telemetry for *both* daemons — no TS counterpart, so there is no contract to match and no panel that reads it. Someone picks the line schema and builds the panel first; emitting an unread line into two daemons is worse than not emitting it. |
| **Org-fs *mounting*** (`mount-manager.ts`, `webdav.ts`, `mounter.ts`, `invalidator.ts`, `detach-mount.ts`) | **Won't port** while this binary ships only in the sandbox image. Mounting-by-the-daemon is the desktop path (`ORGFS_CONFIG` + `ORGFS_RCLONE_PATH`, set by `link-daemon`), and desktop runs the TS bundle. Boot warns if that env reaches this binary. Revisit only if the Go daemon ever ships on desktop. |
| **Install runs as one `sh -c` chain** | **Won't port.** TS models it as two structured commands; the chain needs a shell. The interpolated values are a config path and a package-manager command from a fixed table, never free text. |
| **`resolve-shell`** | **Won't port** — win32-only; this daemon ships linux-only. Daemon-owned git steps already spawn argv, never `sh -c`. |

---

## 8. Rollout

Principles: one flag of its own, default off — deployed must not mean enabled;
the switch is env, **not** a `Dockerfile` `CMD` swap, because a `CMD` change is a
rebuild and a rebuild is not a rollback; flipping off routes the *next* sandbox
to TS while live sandboxes drain, never migrating a live workspace; the drill
happens *before* the canary; and the `sandbox-env` chart is pinned in
`deco-apps-cd`, so a chart change needs a `targetRevision` bump or it silently
will not ship. A prior fix was lost exactly this way.

Per §2.1, a cluster canary does not need the harness bridge.

### 8.1 Why the per-sandbox opt-in cannot be a per-claim env var

`SANDBOX_DAEMON_IMPL` is read by the image entrypoint at container start, so the
choice must be made *before* the pod exists. In prod the pod usually already
exists — it comes from the warm pool — and
`provider/agent-sandbox/runner.ts:buildClaim` spells out the constraint: in
warm-pool mode the claim carries `spec.env: []` and `warmpool: "default"`,
because **the operator rejects per-claim env when the claim may bind a warm
pod**. Env-based selection is therefore only available on the `warmpool: "none"`
path, which forces a cold pod per claim — fine for a one-off smoke, wrong for a
canary whose whole point is that boot cost stays comparable.

What *is* per-claim is `spec.sandboxTemplateRef`. So selection is by **template**:
an opt-in second `SandboxTemplate` (`<name>-go`, identical but with
`SANDBOX_DAEMON_IMPL=go`) plus its own small `SandboxWarmPool`, **in the same
helm release**. A second release would mint a second sentinel Secret
(`randAlphaNum 64` per install) that Studio's single
`STUDIO_SANDBOX_SENTINEL_TOKEN` could not authenticate against, and would
duplicate the preview Gateway, cert, housekeeper and RBAC.

### 8.2 Three layers of control

| Layer | Where | Purpose |
| --- | --- | --- |
| `STUDIO_SANDBOX_GO_TEMPLATE_NAME` | API deployment env | Global kill switch. Unset → the prop and the flag are ignored; there is nothing to point a claim at. |
| `sandboxGoDaemon` org flag | `organization_settings.flags` (`OrgFlagsSchema`) | Who gets Go *by default* — what puts a real user's sandboxes on Go without asking them to pass anything. |
| `daemonImpl?: "ts" \| "go"` | `SANDBOX_START` input | Targets one sandbox. The escape hatch both ways: opt one sandbox in, or pin one back to `ts` inside a flagged org. |

Resolution order: **explicit prop → org flag → `ts`**, mirroring how
`apps/api/src/sandbox/resolve-provider.ts` already resolves the provider kind.
Two required properties:

- **Sticky per sandbox.** Persist the resolved impl in the runner's state blob
  (`RunnerStateRecord.state` is an opaque `Record<string, unknown>` — no
  migration) so autonomous recovery rebuilds the pod on the same binary. A
  sandbox that silently changed implementation mid-life makes every incident
  unattributable.
- **Attributable.** Stamp `studio.decocms.com/daemon-impl` in the claim's
  `additionalPodMetadata.labels` next to the existing tenant labels
  (`LABEL_KEYS` in `runner.ts`), and emit one boot log line naming the
  implementation from *both* daemons. Without the label, every panel below is a
  guess.

### 8.3 Phases

Do not start a phase whose predecessor is not green.

| Phase | Scope | Green when | Undo |
| --- | --- | --- | --- |
| **P0 — kind** | `kind-studio-sandbox-dev`, both templates rendered, one sandbox started with `daemonImpl: "go"` | The full session runs: clone → install → dev server → preview through the proxy → HMR over the WS proxy → agent edits a file → publish → SIGTERM → the work is on origin. Plus `/health` stays responsive during a large `git status`, and the org-fs links appear when the sidecar is enabled. | Nothing shipped. |
| **P1 — stg, one sandbox, by hand** | The prop only; no org flag | The same checklist on pod hardware. Boot p50/p95 for Go ≤ TS on the same repo, from `sandbox.deps.restore` and the lifecycle transitions. SIGTERM publish completes inside the pod's real grace period. First look at the split-by-impl panels with real data. | Stop passing the prop. |
| **P2 — rollback drill** | stg | Flag on for a stg org → sandbox lands on Go; flag off → next sandbox **lands on TS**; the first sandbox's uncommitted work still publishes on shutdown. An undrilled rollback is a hypothesis. | This *is* the undo, rehearsed. |
| **P3 — prod, one internal org** | `sandboxGoDaemon` on for a single internal org; Go warm pool sized 1–2 | 7-day soak, no regression on the four alerts, no manual intervention. | Flip the org flag off. Next sandbox is TS; in-flight ones drain. |
| **P4 — widen** | A second org, then a percentage, then the default | Out of scope for "targeted sandboxes only"; revisit with P3's numbers. | Same flag. |

### 8.4 Alerts before traffic

Four, each **split by `daemon-impl`**, each with a TS baseline captured before
P3 starts:

- **probe-miss rate** — the teardown trigger, and the metric the rewrite exists for;
- **sandbox teardown rate** — the user-visible consequence of a missed probe;
- **publish failure rate** — the only one that means lost work; page on it;
- **boot p50/p95** — parity is the floor (§1).

### 8.5 Work items

1. `EnsureOptions.daemonImpl` + a per-ensure `sandboxTemplateRef` override in
   `AgentSandboxProviderOptions`/`buildClaim`; persist the resolved value in the
   runner state blob.
2. `daemonImpl` on `SANDBOX_START`'s input schema + `resolveDaemonImpl(input,
   flags, env)` beside `resolveSandboxProvider`; then
   `bun run --cwd=apps/api generate:tool-contracts`.
3. `sandboxGoDaemon` in `OrgFlagsSchema`
   (`packages/shared/src/organization/schema.ts` — one line; flags are a jsonb bag).
4. Chart: opt-in `<name>-go` `SandboxTemplate` + `SandboxWarmPool`, same release,
   same sentinel Secret; then the `targetRevision` bump in `deco-apps-cd`.
5. The `daemon-impl` pod label and the boot log line in both daemons.
6. Panels + the four alerts, split by impl, with the TS baseline recorded.

---

## 9. Risk register

| Risk | Why it is live | Mitigation |
| --- | --- | --- |
| Golden cache publishes a broken tree | Cheapest mistake to make; poisons every later boot of that lockfile until the TTL reaps it | Health-gated publish is a named invariant with a negative test that asserts the publish is not even *attempted* |
| A sandbox silently changes implementation mid-life | Pod recreation under a live claim re-reads config | Stickiness in the runner state blob (§8.2); the pod label makes a violation visible |
| The canary is unattributable | Two implementations, one dashboard | `daemon-impl` label + boot line + split alerts, all before P3 |
| Work lost to a rollback | Rolling back mid-session could strand uncommitted work | Never migrate a live workspace; the flag affects the *next* sandbox only, and P2 rehearses exactly this |
| The chart change does not ship | `sandbox-env` is pinned in `deco-apps-cd` | `targetRevision` bump is an explicit work item; a prior fix was lost this way |
| A won't-port turns out to be needed | Four judgements in §7, not test results | Each states its precondition ("while this binary ships only in the image", "unless cloud-CLI ships") — re-read before relying on it |
| Both harness transports get carried "for now" | The mismatch already survived one cycle | Decided and implemented one-way; the stdio spawner is deleted, not parked |
| Work lost to an uncommitted worktree | Already happened once — the `docs-design/` RFCs | Branch is committed and pushed; keep it that way |

---

## 10. Findings that belong to other components

Found while writing tests against the TS baseline first, as the method requires.
The first three were **fixed in the TS daemon too**, since the suite has to pass
on the daemon that is actually in production.

1. **The decofile last-resort net never fired for a new block.** `git status
   --porcelain` collapses an untracked directory into a single `?? .deco/` entry,
   so the validator never saw the file while `git add -- .deco/` still committed
   it — an invalid block written by bash reached the user's branch and broke the
   site render, the exact outcome the net exists to prevent. Fixed in both by
   expanding directory entries via `git ls-files --others --exclude-standard`
   (git does the expansion, so `.gitignore` is honored).
2. **`/write_from_url` and `/upload_to_url` had no URL validation at all** — in
   the TS daemon, the Go daemon, *and* the Rust local-api. The TS comment
   asserting SSRF defenses "aren't needed" rested on `copy_to_sandbox` /
   `share_with_user`, which have since been removed from the harness tool list,
   so nothing enforced the premise any more. Both daemons now enforce the
   boot-env allowlist and re-check every redirect hop. **`apps/native`'s Rust
   implementation is untouched and still unguarded.**
3. **A zero-dependency install emitted a stderr error instead of its telemetry.**
   `readInstalledDeps` scanned a `node_modules` a zero-dep install never creates,
   threw ENOENT into the catch, and logged `[install] dep metrics emit failed` —
   so the countable zero-dep line its own comment calls load-bearing for the
   denominator was never emitted, and every such boot wrote a spurious error
   line. Fixed in TS with an `existsSync` guard; Go emits the line by
   construction.
4. **A CLI harness's file writes never emitted `file-changed` in Go** before the
   watcher landed, because only the fs routes reported writes and CLI harnesses
   edit through `bash`. Worth remembering as a shape: "the daemon reports its own
   actions" is not the same as "the daemon reports what happened".

---

## 11. Non-goals

- Deleting `packages/sandbox/daemon`. Post-soak, and the desktop path still needs
  the TS bundle.
- The `wt/sandbox-controller-go` track (Studio's k8s orchestration). Related,
  separately scoped, **still local-only**.
- The agent-sandbox `v1alpha1` → `v1beta1` operator migration.
- Golden cache L2 — blocked on infrastructure.
- Cloud-CLI (a CLI harness on agent-sandbox). It is the change that would make
  §2.1 false.

---

## 12. Open owner actions

Nothing here is closed by writing more daemon code.

| Action | Why it needs a human |
| --- | --- |
| **Merge `wt/harness-runner-extraction`** | The transport is decided and the Go side is done, but the runner it talks to lives on that branch — it splits `entry.ts` into `daemon-entry.ts` + `harness-runner/`, which is a merge, not a port. Until it lands, `HARNESS_RUNNER_CMD` has nothing to point at. Only blocks cloud-CLI, not the canary (§2.1). |
| **Build §8.5's six work items** | The targeting mechanism does not exist yet. |
| **P0–P3** | A human drives the session, reads the panels, and runs the drill. |
| **A real `claude-code` run** | Needs model providers and MCP. Gates dispatch traffic, not the canary. |
| **`deco-apps-cd` `targetRevision` bump** | Outside this repo. |
| **Push `wt/sandbox-controller-go`** | Still local only, and the RFC loss already happened once. |
