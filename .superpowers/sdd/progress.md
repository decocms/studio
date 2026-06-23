# SDD Progress: direct-nats-projector

Plan: docs/superpowers/plans/2026-06-22-direct-nats-projector.md
Branch: pi-sextantis
Start BASE: a666dc8 (a666dc8)

NOTE: A concurrent agent was editing this tree earlier; its uncommitted Tasks 1-3
work was discarded (tree clean at start). Executing the plan fresh from Task 1.

## Tasks
- [x] Task 1: ingestRun projector-only persistence (commits 2428ef9, b3dbc38, f538e8d)
- [x] Task 2: remove hosted inline part persistence (already satisfied in base a666dc8)
- [x] Task 3: move completion analytics to projector workflow (already satisfied in base a666dc8)
- [x] Task 4: direct NATS publisher for desktop relay rows (4ea8192)
- [x] Task 5: thread active NATS/JetStream into work dispatch (8d2a619)
- [x] Task 6: replace HTTP chunk relay with direct NATS relay (6a: bf7e341, 6b: 17e3e98)
- [x] Task 7: scope daemon NATS publish permissions (0cfaf73)
- [x] Task 8: remove /chunks route and tests (58317ad, guard strengthened 021e38b)
- [x] Task 9: end-to-end verification and cleanup (b66cdbd)

## Post-implementation status
- Focused plan suite: 102 pass / 0 fail (10 files). Full link-daemon dir: 157 pass.
- `bun run check`: ONE error remains, PRE-EXISTING at base a666dc8 and unrelated to
  this plan — run-reactor.test.ts "RUN_FAILED leaves stream cleanup to the projector
  workflow": (a) tsc TS2741 (RunTransition needs `state`), (b) runtime: reactor
  purges ["run_1"] but the test asserts []. Deciding stream-purge ownership
  (reactor vs projector) needs domain input; NOT guess-fixed. FLAG TO HUMAN.
- Commits: 2428ef9, b3dbc38, f538e8d (T1), T2/T3 in base, 4ea8192 (T4), 8d2a619 (T5),
  bf7e341 + 17e3e98 (T6), 0cfaf73 (T7), 58317ad + 021e38b (T8), b66cdbd (T9).
- Plan-gap fixes beyond the written plan (needed for correctness): publisher now
  CONVERTS error events to error chunks (T6a); relayWorkItemFailure publishes
  error+done to NATS (T6b) — both required because the deleted /chunks route did
  this and the projector relies on it for failure detection.

## Notes
- Tasks 2 & 3 were already present in base a666dc8 (verified: no `persistence:` in
  dispatch-run AgentSandboxUiStreamInput; recordCompleted/recordFailed wired in
  projector-workflow + app.ts). Confirmed green via decopilot test suite.
- Task 1 was committed but its `if (!errored)` onFinish guard regressed two
  project-chunks recovery tests. Fixed in f538e8d by gating onFinish on a new
  `sourceThrew` flag instead of `errored`. Reverted the prior agent's dangling
  consume-harness-stream edit (it broke the ingest test the opposite way).
- PRE-EXISTING (out of scope) failure: run-reactor.test.ts "RUN_FAILED leaves
  stream cleanup to the projector workflow" fails at base a666dc8 too; file
  unchanged since base. Not part of this plan. Flag to human.

## Log
20:40:58 start, BASE=a666dc8
21:08 Tasks 1-3 complete (review clean). Task 1 regression fixed in f538e8d.
      Decopilot suite: 446 pass, 1 pre-existing fail (run-reactor). Resuming at Task 4.
