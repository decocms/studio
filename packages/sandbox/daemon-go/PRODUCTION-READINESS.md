# Production readiness — Go sandbox daemon

Companion to [`README.md`](./README.md), which describes what the Go daemon *is*
and what it currently does. This document defines what has to be true before it
runs a real sandbox pod, in what order, and how each claim gets proven.

Written 2026-07-30, against `wt/daemon-go` @ `bbe3cde12` (conformance suite
153/153, unreferenced by any deploy path).

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
  stall the probe handler.
- **Graceful shutdown = git publish.** SIGTERM must publish before SIGKILL, and
  finish inside the pod's real grace period — this is precisely why publish
  pushes `--no-verify`. The suite covers the SIGTERM path in-process; verify
  against the actual configured grace period in a pod.
- **Org-fs mounting** (WebDAV, sidecar, repo-link, invalidator, detach) —
  currently config-parse-only, so any sandbox with org volumes is broken. The
  largest single chunk of remaining work.
- **`resolve-shell` / `structured-command`** — exec/bash divergence, on the
  scripting-agent path.
- **`fsnotify`** — declared in `go.mod`, unused; watching is a 3s poll.

**Acceptance:** a human drives a full session on a kind pod, then a stg pod:
clone → install → dev server → preview through the proxy → HMR over the WS proxy
→ agent edits a file → publish → SIGTERM → the work is on origin.

### 2.5 G5 — Dispatch (parallel track)

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

- **One flag, default off, its own.** Never piggyback on a neighbor's flag.
  Deployed must not mean enabled. Selecting the binary belongs behind an env
  switch, **not** a `Dockerfile` `CMD` swap — a `CMD` change is a rebuild, which
  is not a rollback.
- **Canary shape:** preview/dev-server workloads first (they do not need G5),
  one org, then a percentage.
- **Kill switch:** flipping the flag off must route the *next* sandbox to the TS
  daemon. In-flight sandboxes drain naturally — never migrate a live workspace.
- **Rollback drill before the canary, not after.** Flip on, flip off, confirm
  the next sandbox lands on TS and no work was lost. An undrilled rollback is a
  hypothesis.
- **Chart caveat:** the `sandbox-env` chart is pinned in `deco-apps-cd`; a chart
  change needs a `targetRevision` bump or it silently will not ship. A prior fix
  was lost exactly this way.
- **Alerts before traffic:** probe-miss rate, sandbox teardown rate, publish
  failure rate, boot p95 — each split by daemon implementation so a regression
  is attributable at a glance.

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
