# Production readiness — Go sandbox daemon

Companion to [`README.md`](./README.md), which describes what the Go daemon *is*
and what it currently does. This document defines what has to be true before it
runs a real sandbox pod, in what order, and how each claim gets proven.

Written 2026-07-30, against `wt/daemon-go` @ `bbe3cde12` (conformance suite
153/153, unreferenced by any deploy path).

**Progress (2026-07-30, same day):** §2.0, all of §2.2 (G2) and §2.3 (G3's L1)
are done, G4's remaining *code* is done (org-fs links, probe-under-load), and G6
now has a real kill switch. The suite is **184/184 on both daemons**, and CI runs
it against both. What is left needs a human in a pod (G4's real session, G5's
real harness run, G6's drill) plus one owner decision on the harness transport.
See [§6 Status](#6-status) for the line-by-line ledger.

## 0. Definition of done

The Go daemon is production ready when **a real user session — clone, install,
dev server, preview, agent file/git edits, publish — runs end to end on a Go
daemon pod in prod, behind a default-off flag, with a rollback that takes one
config change and no data loss.**

Deleting `packages/sandbox/daemon` is *not* part of this. That happens after a
soak, and only once dispatch (G5) has also landed.

Three properties, in priority order, because they conflict under time pressure:

1. **No silent data loss.** A sandbox holds the only copy of the user's
   uncommitted work until publish. Anything that can drop it outranks
   everything else here.
2. **No silent divergence.** A behavior that differs from the TS daemon and is
   not asserted by a test is the failure mode this whole rewrite is exposed to.
   Prefer a test over a claim, always.
3. **Not slower to boot.** Boot cost is the sandbox's dominant user-visible
   latency. Parity is the floor, not the goal.

## 1. Readiness gates

Gates, not a task list: each is a statement that becomes *true* and stays true,
with a named way to prove it. G0–G4 are the every-sandbox path and must land in
order. G5 is independent and can run in parallel from the start.

| Gate | Statement | Proven by |
| --- | --- | --- |
| **G0** | A Go-daemon pod is indistinguishable from a TS one in our telemetry. | Side-by-side Grafana panels for one kind pod of each. |
| **G1** | Every item in the README gap ledger either has a test or a signed-off "won't port". | The ledger table has no untested row. |
| **G2** | Workspace correctness and the security invariants hold. | Conformance suite + the red-team checklist in §2.2. |
| **G3** | Boot is no slower than the TS daemon, and measurable. | p50/p95 boot from the metrics G0 added, Go vs TS, same repo. |
| **G4** | A real session runs end to end in a real pod. | kind, then a stg pod, driven by a human. |
| **G5** | `/dispatch` runs a real harness. | A real `claude-code` run, by hand — no test can do this. |
| **G6** | Rollout is reversible and observed. | A rollback drill executed, not just documented. |

**Production ready = G0–G4 + G6 green, plus a 7-day soak on a canary.** G5 gates
dispatch traffic specifically; a preview/dev-server-only canary does not need it.

## 2. Workstreams

### 2.0 Free wins (do first, hours)

- **Log severity.** 11 `log.Printf` sites (`main.go` ×5, `dispatch.go` ×5,
  `misc.go` ×1) land on stderr — Go's stdlib default, no `log.SetOutput`
  anywhere — while proxy/setup logs tee to stdout through the broadcaster
  (`internal/events/broadcast.go:86`). The TS daemon put everything on stdout.
  Our log pipeline reads stderr as error severity, so normal lifecycle lines
  would inflate the error rate on every pod.
  **Acceptance:** `log.SetOutput(os.Stdout)` at boot; only genuine errors reach
  stderr; a Go pod's error-log rate matches a TS pod's at idle.
- **Push the branches.** `wt/daemon-go` and `wt/sandbox-controller-go` are local
  only. The original `docs-design/` RFCs for this work were never committed and
  are permanently lost — do not repeat that.

### 2.1 G0 — Observability parity

You cannot canary what you cannot see, and per the boot-cost work the
observability gap is already the critical path. This lands **before** any
behavior work so every later change is measured rather than argued.

- OTLP traces + metrics matching the TS daemon's spans and names, including
  `setup/dep-metrics.ts` (dependency install timings). No otel dependency exists
  in `go.mod` today.
- Per-phase boot timing: clone → install → start → first healthy probe, as
  distinct spans, so G3 can attribute a regression to a phase.
- Structured logs with a severity field, not stream-inferred.

**Acceptance:** boot one kind sandbox on each daemon against the same repo;
every panel on the sandbox dashboard populates for both, with the same metric
names.

### 2.2 G2 — Workspace correctness and security

Ranked by blast radius, worst first.

| Item | Why it is here | Acceptance |
| --- | --- | --- |
| **Decofile block validation** (`decofile-json.ts`, unported) | Smallest fix, worst outcome: an invalid block reaches the user's branch through `/write`, `/edit` or `publish` and breaks the whole site render. TS has a last-resort net in publish with two dispositions — `throw` for interactive, `skip` for shutdown-sync (aborting the shutdown commit would lose *all* the user's other work). | Both dispositions ported; e2e for each, written against the TS daemon first. |
| **Per-repo cache isolation** | This is a security boundary, not an optimization — one repo's cache must never be readable from another's sandbox. | An e2e that fails if repo A's cache is reachable from repo B. |
| **SSRF fail-closed** on `/write_from_url` + `/upload_to_url` | Allowed-host list and `OFFLOAD_ALLOW_SAME_HOST_DEV` must fail closed on a malformed or unlisted host, never open. | Negative tests: unlisted host, redirect to a listed host, IP-literal loopback, IPv6 loopback. |
| **Protected-branch guard** | Ported, but only a Go unit test covers it. `publish` pushes `--no-verify`, so the pre-push hook is bypassed and the in-code guard is the *only* thing standing between a sandbox and a direct push to `main`. | Promote to an e2e asserting 409 on `main`/`master`/`origin`'s actual default, and that no commit was created. |
| **`force-push` with lease + `fast-forward-to-base`** | Without these, publish cannot recover a diverged `origin/<branch>`; the PR flow dead-ends. | Port with the lease semantics intact (fetch, read remote sha, push with lease); e2e for the diverged-origin recovery. |
| **Catalog prune-on-resync** | Already implemented; a renamed/removed tool must not linger, and the dotfile endpoint must survive the prune. | e2e: sync A→B, assert A's file is gone and `.endpoint.json` remains. |

### 2.3 G3 — Boot economics

- **Golden cache L1** — reflink-based, currently a no-op
  (`Orchestrator.PublishPendingGolden()`). Per prior prod investigation the L1
  reflink path *works* in prod; treat that as settled and do not re-derive it.
- **Publish only after the health signal.** A cache published before the dev
  server is confirmed healthy poisons every subsequent boot. This is the single
  most important invariant in this workstream.
- **Eviction: TTL + size cap**, and invalidation of a bad entry.
- **`.git/info/exclude`** for any artifact written into the repo, so the
  shutdown `git add -A` never commits it onto the user's branch. The tools
  catalog already does this; new artifacts must too.
- L2 (remote archive, `setup/remote-golden.ts`) is **out of scope for G3** —
  it depends on infrastructure not yet in place. Land L1 first.

**Acceptance:** cold boot and warm boot p50/p95 for Go ≤ TS on the same repo,
measured with G0's spans; a deliberately unhealthy dev server publishes nothing.

### 2.4 G4 — Runtime fidelity in a real pod

This is where the rewrite meets reality, and where the suite is least useful.

- **uid/gid drop is a real landmine.** `git-sync.ts` and `pty-spawn.ts` request
  a drop to 1000:1000, but Bun silently ignores spawn uid/gid — so the TS daemon
  has *never actually done it*, and the conformance suite runs as the invoking
  user. Go's `syscall.Credential` will honor it. A Go daemon running as a
  different uid will EPERM in the git routes where TS silently did not.
  **Decide explicitly:** honor the drop (and fix the permissions model), or
  don't (and delete the request). Do not discover this in a pod.
- **Image.** Multi-arch `linux/amd64` + `linux/arm64` today. All Go deps
  (`creack/pty`, `fsnotify`, `x/sys`) are pure Go, so `CGO_ENABLED=0` static
  builds are available — which also drops the `node-pty` native-addon build
  from the image if the TS daemon is not also shipped. Keep both while both
  ship. `typegen.tgz` and the in-workspace tooling must still be installed.
- **Health probe semantics.** The daemon serves `/health` reporting the
  studio-injected per-boot id; Studio re-reads it on rehydrate and **tears the
  sandbox down on a single missed probe**. Verify: boot-id round-trip, probe
  latency under a heavy git operation, and that no daemon-internal lock can
  stall the probe handler. *Probe latency under load is now asserted by
  `daemon.probe.e2e.test.ts` against Studio's real 500ms budget (§6); the pod
  measurement still has to happen on pod hardware.*
- **Graceful shutdown = git publish.** SIGTERM must publish before SIGKILL, and
  finish inside the pod's real grace period — this is precisely why publish
  pushes `--no-verify`. The suite covers the SIGTERM path in-process; verify
  against the actual configured grace period in a pod.
- ~~**Org-fs mounting** (WebDAV, sidecar, repo-link, invalidator, detach) —
  currently config-parse-only, so any sandbox with org volumes is broken. The
  largest single chunk of remaining work.~~ **Resolved, and it was never the
  largest chunk:** a cluster pod cannot mount at all (the sidecar does), and
  daemon-side mounting exists only on the desktop, which runs the TS bundle. The
  pod-side half — relay, status gate, repo link, per-run thread links — is ported
  with a 5-test e2e on both daemons. See §6.
- ~~**`resolve-shell` / `structured-command`**~~ — done; `resolve-shell` is
  win32-only and deliberately not ported (§6).
- ~~**`fsnotify`** — declared in `go.mod`, unused; watching is a 3s poll.~~ Now
  used (`internal/gitx/watch.go`), with the poll kept as the safety net.

**Acceptance:** a human drives a full session on a kind pod, then a stg pod:
clone → install → dev server → preview through the proxy → HMR over the WS proxy
→ agent edits a file → publish → SIGTERM → the work is on origin.

### 2.5 G5 — Dispatch (parallel track)

**Resolved 2026-07-30: loopback HTTP.** Implemented in
`internal/dispatch/runner.go` with the stdio spawner deleted; see the README's
transport section for the wire table and the two carried invariants. The original
framing is kept below for the record.

Resolve the transport mismatch, then verify by hand:

- **This daemon:** spawns `HARNESS_RUNNER_CMD` per run, request frame on stdin,
  NDJSON events on stdout.
- **`wt/harness-runner-extraction`** (on origin): long-lived supervised runner,
  `HARNESS_RUNNER_MODE=1`, `HARNESS_RUNNER_READY <port>` on stdout, then
  `POST /run` over loopback with a per-spawn bearer, answered
  `200 application/x-ndjson`.

Same event stream; the difference is transport and runner lifetime. Stdio needs
no port or token and is simpler to supervise; loopback HTTP keeps one warm
runner across runs and already has an e2e on that branch. **Pick one and delete
the other** — carrying both is how this stalls again.

`daemon.dispatch.e2e.test.ts` is gate-only (8 tests: bearer auth, bad JSON,
missing `harnessId`/`runId`, malformed envelope, cancellation). It will never
tell you the bridge works. **Acceptance is a real `claude-code` run, by hand.**

## 3. Rollout

Principles (unchanged): one flag of its own, default off — deployed must not mean
enabled; the switch is env, **not** a `Dockerfile` `CMD` swap, because a `CMD`
change is a rebuild and a rebuild is not a rollback; flipping off routes the
*next* sandbox to TS while live sandboxes drain, never migrating a live
workspace; the drill happens *before* the canary, not after; and the `sandbox-env`
chart is pinned in `deco-apps-cd`, so a chart change needs a `targetRevision`
bump or it silently will not ship.

### 3.0 What a cluster canary does not have to cover

**Harness dispatch is not used by cluster sandboxes.** Confirmed in code, not
assumed:

- `apps/api/src/harnesses/local-dispatch.ts` — "This is the ONLY dispatch path
  for hosted (agent-sandbox / legacy) harnesses." The cluster runs the harness
  **in the API process** (`InProcessSandboxClient.dispatch` → `localDispatch`:
  "a direct call, no HTTP, no wire").
- `dispatch-run.ts` — a CLI harness "never reaches a successful dispatch on this
  path: … on agent-sandbox it is rejected up front by the gate (cloud-CLI is a
  planned follow-up)".
- The only callers of the daemon's `POST /_sandbox/dispatch` are the desktop
  path (`apps/api/src/link-daemon/handle-local-dispatch.ts`) and
  `apps/native/e2e`. Desktop runs the **TS bundle** materialized by
  `daemon-spawn.ts`, never this image.

So on a cluster pod the daemon serves fs/git/exec/tasks, the dev-server proxy,
the tools catalog and the org-fs links — and `/dispatch` is dead code there.
**G5 does not gate this rollout at all**; it gates cloud-CLI, whenever that
lands. Re-check this section if cloud-CLI ships.

### 3.1 The mechanism: why the prop cannot be a per-claim env var

`SANDBOX_DAEMON_IMPL` is read by the image entrypoint at container start, so the
choice must be made *before* the pod exists. In prod the pod usually already
exists — it comes from the warm pool — and
`provider/agent-sandbox/runner.ts:buildClaim` spells out the constraint: in
warm-pool mode the claim carries `spec.env: []` and `warmpool: "default"`,
because **the operator rejects per-claim env when the claim may bind a warm
pod**. A per-sandbox env var is therefore only available on the
`warmpool: "none"` path, which forces a cold pod per claim — acceptable for a
one-off smoke, not for a canary whose whole point is that boot cost stays
comparable.

What *is* per-claim is `spec.sandboxTemplateRef`. So selection is by **template**:

- Extend `deploy/helm/sandbox-env` with an opt-in second `SandboxTemplate`
  (`<name>-go`, identical but with `SANDBOX_DAEMON_IMPL=go`) plus its own small
  `SandboxWarmPool`. **Same helm release** — a second release would mint a second
  sentinel Secret (`randAlphaNum 64` per install) that Studio's single
  `STUDIO_SANDBOX_SENTINEL_TOKEN` could not authenticate against, and would
  duplicate the preview Gateway, cert, housekeeper and RBAC.
- `AgentSandboxProviderOptions.sandboxTemplateName` is instance-level today; add
  a per-ensure override so one claim can point at the Go template.

Three layers of control, each able to stop the rollout on its own:

| Layer | Where | Purpose |
| --- | --- | --- |
| `STUDIO_SANDBOX_GO_TEMPLATE_NAME` | API deployment env | Global kill switch. Unset → the prop and the flag are ignored entirely; there is nothing to point a claim at. |
| `sandboxGoDaemon` org flag | `organization_settings.flags` (`OrgFlagsSchema`) | Who gets Go *by default* — this is what puts a real user's sandboxes on Go without asking them to pass anything. |
| `daemonImpl?: "ts" \| "go"` | `SANDBOX_START` input | Targets one sandbox. The escape hatch in both directions: opt a single sandbox in for testing, or pin one back to `ts` inside a flagged org. |

Resolution order: **explicit prop → org flag → `ts`**, mirroring how
`resolveSandboxProvider` already resolves the provider kind. Two properties this
must have:

- **Sticky per sandbox.** Persist the resolved impl in `sandbox_runner_state`
  alongside the handle, so autonomous recovery (pod recreated under a live claim)
  rebuilds the pod on the same binary. A sandbox that silently changed
  implementation mid-life would make every incident unattributable.
- **Attributable.** Stamp `studio.decocms.com/daemon-impl` in the claim's
  `additionalPodMetadata.labels` (next to the existing tenant labels) and emit
  one boot log line naming the implementation from *both* daemons. Without the
  label, every panel below is a guess.

### 3.2 Phases

Each phase states what makes it green and what undoes it. Do not start a phase
whose predecessor is not green.

| Phase | Scope | Green when | Undo |
| --- | --- | --- | --- |
| **P0 — kind** | Local `kind-studio-sandbox-dev`, both templates rendered, one sandbox started with `daemonImpl: "go"` | The G4 session runs end to end: clone → install → dev server → preview through the proxy → HMR over the WS proxy → agent edits a file → publish → SIGTERM → the work is on origin. Plus: `/health` keeps answering during a big `git status`, and the org-fs links appear if the sidecar is enabled. | Nothing shipped. |
| **P1 — stg, one sandbox, by hand** | The prop only; no org flag yet | Same checklist against a stg pod, on pod hardware. Boot p50/p95 for Go ≤ TS on the same repo, measured from `sandbox.deps.restore` and the pod's lifecycle transitions. First look at the split-by-impl panels with real data in them. | Stop passing the prop. |
| **P2 — rollback drill** | stg | Flip the org flag on for a stg org, start a sandbox (lands on Go), flip it off, start another (**lands on TS**), and the first sandbox's uncommitted work is still published on shutdown. An undrilled rollback is a hypothesis. | n/a — this *is* the undo, rehearsed. |
| **P3 — prod, one internal org** | `sandboxGoDaemon` on for a single internal org; Go warm pool sized 1–2 | 7-day soak with no regression on the four alerts below, and no manual intervention. Publish-failure rate is the one that matters most: it is the only metric that maps to lost work. | Flip the org flag off. Next sandbox is TS; in-flight ones drain. |
| **P4 — widen** | A second org, then a percentage, then the default | Out of scope for "targeted sandboxes only" — revisit with P3's numbers in hand. | Same flag. |

### 3.3 Alerts before traffic

Four, each **split by `daemon-impl`** so a regression is attributable at a
glance, and each with a TS baseline captured *before* P3 starts:

- **probe-miss rate** — the teardown trigger, and the metric the rewrite exists
  for (measured locally: Go worst 1ms vs TS worst 186ms under load).
- **sandbox teardown rate** — the user-visible consequence of a missed probe.
- **publish failure rate** — the only one that means lost work; page on it.
- **boot p50/p95** — parity is the floor per §0.

### 3.4 Work items

1. `EnsureOptions.daemonImpl` + a per-ensure `sandboxTemplateRef` override in
   `AgentSandboxProviderOptions`/`buildClaim`, and the resolved value persisted
   in `sandbox_runner_state`.
2. `daemonImpl` on `SANDBOX_START`'s input schema + `resolveDaemonImpl(input,
   flags, env)` next to `resolveSandboxProvider`; regenerate tool contracts.
3. `sandboxGoDaemon` in `OrgFlagsSchema` (one line — flags are a jsonb bag).
4. Chart: opt-in `<name>-go` `SandboxTemplate` + `SandboxWarmPool`, same release,
   same sentinel Secret; then the `targetRevision` bump in `deco-apps-cd`.
5. The `daemon-impl` pod label and the boot log line in both daemons.
6. Panels + the four alerts, split by impl, with a TS baseline recorded.

## 4. Risk register

| Risk | Why it is likely | Mitigation |
| --- | --- | --- |
| uid/gid drop now actually happens | Bun ignored it for years; Go honors it | Decide in G4 *before* a pod, not after |
| A gap ledger item is "obviously fine" and ships untested | Nine unported behaviors, all currently green in CI | G1 forbids an untested row |
| Golden cache publishes a broken tree | Cheapest mistake to make, poisons every later boot | Health-gated publish is a named invariant, with a negative test |
| Probe stalls under a long git operation | This exact class is what motivated the rewrite | Explicit probe-latency test under load in G4 |
| Both harness transports get carried "for now" | The mismatch has already survived one cycle | G5 requires deleting the loser |
| Work is lost to an uncommitted worktree | Already happened once — the RFCs | Push branches; commit before releasing any worktree |

## 5. Non-goals

- Deleting the TS daemon. Post-soak, after G5.
- The `wt/sandbox-controller-go` track (Studio's k8s orchestration). Related, separately scoped.
- The agent-sandbox `v1alpha1` → `v1beta1` operator migration.
- Golden cache L2 / remote archive — blocked on infrastructure, not on this daemon.

## 6. Status

Conformance suite: **184/184 on both daemons** (was 153; the 23 new tests all
run against the TS daemon too, which is what makes them parity evidence rather
than Go-only assertions).

| Gate | State |
| --- | --- |
| §2.0 free wins | **Done** — logs on stdout via `log/slog` with an explicit `level=`, guarded by `logging_test.go`. Branches still local (see below). |
| **G0** observability | **Partly done** — dependency telemetry ported and proven byte-identical to TS; structured logs done. Per-phase boot timing is now a *recorded deferral*, not a gap (see below). |
| **G1** ledger has no untested row | **Done** — every remaining row is either tested or an explicit won't-port with its reason (README ledger). The won't-ports: L2 golden (infra-blocked, §5 non-goal), the `sh -c` install chain (fixed-table inputs), org-fs *mounting* (desktop-only path; this binary ships in the cluster image), per-phase boot timing (no schema, no panel, no TS counterpart). |
| **G2** correctness + security | **Done** — every row has an e2e, including the per-repo cache isolation row that was deferred here from G2. |
| **G3** boot economics | **L1 done** — reflink restore/publish, health-gated publish, TTL + per-repo cap GC, dormant behind `GOLDEN_CACHE_ENABLED`; unit + e2e on both daemons. L2 stays out of scope (§5). Boot p50/p95 comparison still needs a real pod. |
| **G4** runtime fidelity | **Code done, pod pending** — uid/gid decided and pinned; org-fs links ported with a 5-test e2e on both daemons; probe-under-load asserted against Studio's real 500ms budget. The human-driven session in kind and stg remains. |
| **G5** dispatch | **Transport decided and implemented** — loopback HTTP (owner decision): `internal/dispatch/runner.go` speaks the extraction branch's protocol, the stdio spawner is deleted, and `runner_test.go` covers the bridge with a fake runner. Two things remain, both outside this daemon: merge `wt/harness-runner-extraction` so `HARNESS_RUNNER_CMD` has a runner to point at, and the by-hand `claude-code` run. |
| **G6** rollout | **Kill switch done** — `SANDBOX_DAEMON_IMPL` (`ts` default) selected by the image entrypoint, `daemonImpl` in the `sandbox-env` chart, both smoke-tested in CI. The per-sandbox targeting mechanism, phases and alerts are specified in §3; none of it is built yet. |

### What landed in G3 / G4 / G6 (this pass)

| Item | Evidence |
| --- | --- |
| Golden cache L1 | `internal/setup/golden.go` + `PublishPendingGolden` deferred to the probe's `running` transition. Unit: key isolation, lockfile hashing, kill switch, GC bounds, and a real reflink round trip that asserts CoW independence where the filesystem supports it. e2e: an install-fine/never-healthy boot publishes nothing **and never even attempts it** (`d.stdout` carries no `[golden]` line — the store check alone would pass on a non-CoW filesystem while the gate was broken) |
| Per-repo cache isolation (the G2 row deferred here) | `TestGoldenRoundTrip` asserts repo B cannot restore repo A's golden for a byte-identical lockfile, and `TestGoldenNodeModulesPath` that neither repo's path nests inside the other's |
| Org-fs links | `internal/orgfs/links.go` + `daemon.orgfs.e2e.test.ts` (5 tests, both daemons): output/upload point at the calling thread and repoint across threads; nothing is linked while the sidecar reports no live mount; a non-single-segment threadId is refused; a repo tracking its own `org/` is never shadowed; a pod with no sidecar env stays inert |
| Catalog sync on dispatch | `toolscatalog.Coalescer`, wired into dispatch's `BeforeRun`; unit tests cover the 20-way burst, the interval floor, per-endpoint keying, and a run with no MCP endpoint |
| File watching | `internal/gitx/watch.go`. The e2e that proves it (`a file written outside the fs routes still emits file-changed`) was **control-tested**: with the watcher disabled the Go daemon fails it, because only the fs routes would report writes — and a CLI harness edits through `bash` |
| Probe under load | `daemon.probe.e2e.test.ts` samples `/health` for 4s while `git status` runs over 4000 untracked files, asserting Studio's real 500ms budget. Measured on this machine: **Go p50 0ms / p95 0ms / worst 1ms; TS p50 22ms / p95 60ms / worst 186ms**. Both pass; the margin is the rewrite's whole point, and TS's worst case is 37% of the budget before a slower node or a bigger repo is in the picture |
| Runtime binary selection | `image/start-daemon.sh` (`exec`, so the daemon stays PID 1 and SIGTERM still triggers the publish) + `daemonImpl` in the chart; CI smokes the image with the variable unset **and** set to `go` |
| Parity is now enforced, not asserted | `.github/workflows/sandbox-daemon.yml` gains `daemon-e2e-go`: `go vet`, `go test -race`, then the whole conformance suite via `DAEMON_E2E_CMD`. The "passes on both daemons" claim was previously a sentence in a doc |

### What landed in G2

| Item | Evidence |
| --- | --- |
| Decofile block validation | `internal/decofile` + both dispositions; unit table + 5 e2e (write, edit, publish-throw, shutdown-skip) |
| SSRF fail-closed | `internal/urlallow` now gates `/write_from_url` + `/upload_to_url` (they had **no** validation in either daemon); 17-case unit table + redirect tests + 11 e2e |
| Protected-branch guard | Promoted to e2e: 409 on `main`, and HEAD is unmoved so no stray commit |
| `force-push` w/ lease + `fast-forward-to-base` | `gitx.ForcePushWithLease` / `gitx.FastForwardToBase`; e2e for diverged-origin reconcile, for shutdown *not* reconciling, and for boot fast-forward (control-tested — it fails without the implementation) |
| Catalog prune-on-resync | e2e: stale tool file removed, survivors kept, `.endpoint.json` spared |
| Per-repo cache isolation | **Deferred to G3** — `PublishPendingGolden()` is a no-op, so there is no cache to isolate yet. The test lands with the implementation. |

### §2.1's premise was wrong: G0 is not an OTLP job

§2.1 asks for "OTLP traces + metrics … including `setup/dep-metrics.ts`". But
`dep-metrics.ts` documents the opposite, and gives the reason: a sandbox pod's
**egress is locked to 53/443, so no in-cluster OTLP collector is reachable**.
Its stdout, scraped out-of-band, is the only channel that leaves the pod. That
is why the TS daemon emits JSON *log lines*, not spans, and why the per-package
data is logs rather than metrics (per-package cardinality would wreck
Prometheus).

So the G0 deliverable is **matching the log-line contract**, and no otel
dependency belongs in `go.mod`. `internal/setup/depmetrics.go` now emits both
shapes:

- `sandbox.deps.restore` — one line per dependency step (`source`, `repo_hash`,
  `duration_ms`, `bootId`). `repo_hash` strips credentials before hashing.
- `sandbox.deps` — the installed dep set, byte-chunked under 600 bytes/line
  with `deps` as a pre-encoded JSON string (both simpler shapes fail in the
  pipeline: one big line is truncated at 16KB, one line per dep gets ~99%
  rate-sampled away).

**Proven, not asserted:** booting both daemons against the same repo produces
identical `sandbox.deps.restore` lines (modulo hash/duration/bootId), and
feeding 120 deps with over-long meta through each implementation's line builder
yields **18 byte-identical lines**. Go can only report `miss` / `no-install`
today — `l1`/`l2` arrive with the golden cache in G3.

**Still open in G0:** per-phase boot timing (clone → install → start → first
healthy probe). This is *new* telemetry — the TS daemon has no counterpart, so
there is no contract to match and no panel that reads it. Someone should pick
the line schema and build the panel before either daemon emits it; inventing one
here would just add an unread log line to two daemons.

### Three findings worth carrying to the TS daemon

Both were found by writing the e2e against the TS baseline first, exactly as
§2.2 prescribes — and both were **fixed in the TS daemon too**, since the suite
has to pass on the daemon that is actually in production.

1. **The decofile last-resort net never fired for a new block.** `git status
   --porcelain` collapses an untracked directory into a single `?? .deco/`
   entry, so the validator never saw the file while `git add -- .deco/` still
   committed it. An invalid block written by bash reached the user's branch and
   broke the site render — the exact outcome the net exists to prevent. Fixed in
   both daemons by expanding directory entries via `git ls-files --others
   --exclude-standard` (git does the expansion so `.gitignore` is honored).
2. **`/write_from_url` and `/upload_to_url` had no URL validation at all** — in
   the TS daemon, the Go daemon, *and* the Rust local-api. The TS comment
   asserting SSRF defenses "aren't needed" because the model can't supply a URL
   rested on `copy_to_sandbox`/`share_with_user`, which have since been removed
   from the harness tool list — so nothing enforced the premise any more. Both
   daemons now enforce the boot-env allowlist and re-check every redirect hop.
   `apps/native`'s Rust implementation is **untouched and still unguarded**.
3. **A zero-dependency install emitted a stderr error instead of its telemetry.**
   `readInstalledDeps` scanned a `node_modules` that a zero-dep install never
   creates, threw ENOENT into the catch, and logged `[install] dep metrics emit
   failed` — so the countable zero-dep line its own comment calls load-bearing
   for the denominator was never emitted, and every such boot wrote a spurious
   error line. Fixed in TS with an `existsSync` guard; Go emits the line by
   construction. This also serves §2.0's acceptance — that stderr line was
   inflating the TS pod's error rate.

### Correction to §2.4's uid/gid entry

The premise ("Go's `syscall.Credential` will honor it", so a Go daemon "will
EPERM in the git routes") does not hold: `applyUidDrop` is guarded by
`os.Geteuid() != 0`, and the sandbox image runs `USER sandbox` (uid 1000) with
no k8s `runAsUser` override. The drop is already a no-op in prod and engages
only under root, where it is correct. Pinned by `internal/gitx/uiddrop_test.go`
so a future edit can't silently make it unconditional.

### What is left, and who has to do it

Nothing below can be closed by writing more code in this repo.

| Left | Why it needs a human |
| --- | --- |
| **Merging `wt/harness-runner-extraction`** | The transport is decided (loopback HTTP) and the Go side is done, but the runner it talks to lives on that branch — it splits `entry.ts` into `daemon-entry.ts` + `harness-runner/`, which is a merge, not a port. Until it lands, `HARNESS_RUNNER_CMD` has nothing to point at and dispatch on the Go daemon answers `harness_crashed`. The image and chart also need that env once it exists. |
| **G4's real session** | kind, then a stg pod: clone → install → dev server → preview → HMR → agent edit → publish → SIGTERM → work on origin. Also the pod-hardware boot p50/p95 (G3) and the SIGTERM-inside-the-real-grace-period check, neither of which a laptop can measure. |
| **G5 acceptance** | A real `claude-code` run. Needs model providers and MCP — and note §3.0: this gates cloud-CLI, **not** the cluster canary, because cluster harnesses run in the API process and never touch the daemon's `/dispatch`. |
| **G6 canary + drill** | Flip `daemonImpl: go` on one org, flip it back, confirm the next sandbox lands on TS and no work was lost. Alerts split by implementation before traffic. |
| **Per-phase boot timing** | Pick the log-line schema and build the panel first — see the G0 note above; emitting an unread line into two daemons is worse than not emitting it. |
| **Chart rollout** | `sandbox-env` is pinned in `deco-apps-cd`; the new `daemonImpl` value ships only with a `targetRevision` bump. A prior fix was lost exactly this way. |
| **The branches** | `wt/daemon-go` and `wt/sandbox-controller-go` are committed but **local only**, and `docs-design/`'s RFCs were already lost to an uncommitted worktree once. Pushing is one command and is not mine to run.
