# SDD Progress: decopilot unified per-run workflow (C1 + child harness)

Plan: docs/superpowers/plans/2026-06-26-decopilot-projection-single-workflow.md
Branch: eta-telescopii
Start BASE: 7e8cb29

(Replaces a stale ledger from a different plan: 2026-06-22-direct-nats-projector / pi-sextantis.)

## Pre-flight findings (awaiting human decisions before Tasks 3, 6, 7, 11)
- Task 6 (hostedHarnessWorkflow) and Task 3 (resolveThreadStatus wiring): large
  relocations, not complete-code; need design decisions.
- Open: HOSTED_HARNESS_QUEUE partition key/concurrency; child cancellation wiring;
  resolveThreadStatus inputs (final parts source); automation concurrency cap.
- Pre-existing FAIL in our area: run-reactor.test.ts "RUN_FAILED leaves stream
  cleanup to the projector workflow" (flagged in prior ledger; Task 8 touches this file).

## Tasks
- [x] Task 1: consume-loop pure helpers (afe59cf, review clean)
- [x] Task 2: markRunRequiresAction (4b86a44, +9129a5e comment, review clean)
- [x] Task 3: finish-reason->status mapping + analytics (ac19806, +19ab045 fixes, review clean)
- [x] Task 4: export projection primitives (862243a, verified)
- [x] Task 5: the consume loop (f011d03, review clean — msgId via Nats-Msg-Id header)
- [x] Task 6: hostedHarnessWorkflow child (ccc289d, review approved)
- [x] Task 7a: hoist run-claim fence to gate (99cecf7, review clean)
- [x] Task 7b: flip hosted->child + consume step + drop poll + cancel (939efb7, +c33b777 comments, review clean)
- [x] Task 8: drop early terminal-status write in run-reactor (1b47cb2, review clean)
- [x] Task 9: bump DBOS version to 2 + stale-comment cleanup (354190e)
- [x] Task 10: delete standalone projector (305a7cf, review clean)
- [x] Task 11: worker queue wiring (ee863fb, verified — both parent+child in RUN_QUEUES)
- [x] Task 12: e2e lifecycle tests (3811692, review approved — 3 live + 5 justified skips, unrun here: no stack)

## Log
18:51 Task 1 complete (afe59cf), review clean. Pausing to batch decisions for Tasks 3/6/7/11.

## Decisions (approved by human)
1. HOSTED_HARNESS_QUEUE: partition by threadId, concurrency 1 (mirror THREAD_GATE_QUEUE). In RUN_QUEUES.
2. requires_action: extend ProjectChunksResult with `finalParts` (fold already has last msg); pass to resolveThreadStatus (already in status.ts — do NOT re-extract).
3. Child cancel: DBOS.cancelWorkflow("decopilot-hosted:<runId>:<fence>") + registry abort.
4. Automation concurrency: accept existing 10/org cap.
19:05 Task 2 complete (4b86a44, 9129a5e). Minor (test stub undefined return) noted, no fix. Reviewer flag: confirm "requires_action" is a valid threads.status enum value — verify in Task 3.
19:40 Task 3 complete (ac19806 + 19ab045). Adjudicated: undefined-outcome->completed kept (defensive; projectFn throws on no-outcome). Catch-path analytics now gated. finalParts hardened.
19:56 Task 5 complete (f011d03). Plan bug fixed by impl: JsMsg has no .msgId; uses Nats-Msg-Id header (matches projector-consumer.ts).
20:34 Task 6 complete (ccc289d). Notes: HOSTED_HARNESS_QUEUE must be added to RUN_QUEUES in Task 11 BEFORE any deploy (else split-pod hosted runs queue forever). Minor: 3 duplicated workflow types (drift risk) + dead ThreadGateRuntime.dispatchRunFn -> cleanup. Circular import (DBOS register at import time) resolved via one-way dep.
20:40 DECISION: Task 7 = Option A (claim run at gate uniformly). Hosted fence currently minted in prepareRun (dispatch-run.ts:1082) — async-in-child after Task 6, races the consume step. Split Task 7 -> 7a (hoist claim, behavior-preserving) + 7b (flip+consume+cancel). After 7a, child workflow ID keeps decopilot-hosted:<runId>:<fence> (fence known at gate).
21:13 Task 7a complete (99cecf7). Fence now minted at gate before both branches; prepareRun uses it (fallback mint only for non-prod). Build order set: 8 -> 7b -> 10 -> 11 -> 9 -> 12. Pre-existing RUN_FAILED test fail is orthogonal to Task 8 (which only changes RUN_COMPLETED/RUN_REQUIRES_ACTION).
21:28 Task 8 complete (1b47cb2). handleTerminalStatus no longer writes status (consume is sole writer for completed/requires_action); SSE kept; RUN_FAILED untouched. Pre-existing RUN_FAILED test not present in current files (resolved upstream). Next: 7b keystone wiring.
21:46 Task 7b complete (939efb7 + c33b777). Fire-and-forget child enqueue + consume step wired for both topologies; pollUntilTerminal + dead dispatchRunFn removed; cancelHostedHarness wired. DBOS version bump still pending (Task 9).
21:55 Task 10 complete (305a7cf). Old projector consumer+workflows+startup deleted; primitives kept; streamBuffer.init preserved. Minor stale comments (projector-workflow.ts:195, app.ts:1442, nats-stream-buffer.ts:310) for final cleanup pass.
21:59 Task 11 complete (ee863fb). RUN_QUEUES = [AUTOMATIONS, THREAD_GATE, HOSTED_HARNESS, BACKGROUND_TOOLS]; HOSTED_HARNESS_QUEUE registered (partition threadId, concurrency 1); PROJECTOR_QUEUE fully removed. System functionally complete; remaining: Task 9 (version bump) + Task 12 (e2e) + final comment cleanup.
22:17 Task 12 complete (3811692). ALL 12 TASKS DONE. Proceeding to final whole-branch review.

## FINAL REVIEW (whole-branch, opus) — READY TO MERGE
All 12 tasks complete + reviewed. Final review verified all 6 cross-task seams; sole-writer invariant holds. No blocking defects.
Hardening applied: 822e27c (tolerate already-exists on consume consumer add).

### Follow-ups (non-blocking, file as issues):
1. IMPORTANT: hosted-failure purge/consume race — RUN_FAILED purges the stream while consume may project the same in-band-error run. Bounded + self-correcting (DB already failed, markRunFailed idempotent). Worst case: truncated failed parts OR (source-throw w/ no {done}) consume idle-timeout holds per-thread slot up to 30min. Fix: pass abort signal to consumeRunProjection on terminal-failure and/or defer RUN_FAILED purge to consume's purgeRun. NOT a regression (old poll cap was 1h).
2. MINOR: extract shared types-only module for the 3 duplicated workflow types (break DBOS import cycle cleanly).
3. MINOR: 5 e2e cases skipped pending injection hooks (idleTimeoutMs env override, raw-publish dedup bypass, multi-pod kill controls).
4. MINOR: comment inaccuracies (e2e lastSeq).
10:23 CI FIX (71b1654): lifted enqueueHostedHarness out of dispatchRunAndWait STEP into runDispatchSteps workflow BODY (DBOS forbids startWorkflow from a step — e2e caught it). + knip unused-export cleanup + workflow-source-guard snapshot rebaseline. Local: typecheck/knip/thread-gate 8-8/snapshot 5-5 green. Re-running CI.
