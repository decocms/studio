/**
 * Manually-maintained DBOS application version. Pins recovery compatibility so
 * deploys stop stranding in-flight workflows. DBOS's default is an MD5 of every
 * registered workflow's source, which churns on every bundled deploy — a new
 * hash means in-flight workflows of the old version have no executor able to
 * recover them, so they strand (the thread-gate "accepted and queued" wedge).
 * See docs/superpowers/specs/2026-06-25-dbos-app-version-pinning-design.md.
 *
 * NOTE: under DBOS Cloud (process.env.DBOS__CLOUD === "true") the SDK ignores
 * applicationVersion and uses its own env-supplied version instead. This repo
 * self-hosts and sets neither DBOS__CLOUD nor DBOS__APPVERSION, so the pin
 * takes full effect — but be aware of this if the deploy target ever changes.
 *
 * GLOBAL: one value for ALL registered workflows in the process. Fed to
 * DBOS.setConfig({ applicationVersion }) via buildDbosConfig().
 *
 * BUMP this (e.g. "1" -> "2") ONLY when a registered workflow changes such that
 * an in-flight instance becomes unrecoverable against the new code:
 *   - add / remove / reorder a step (DBOS.runStep / a registered step) in a workflow
 *   - change the recorded input/output contract of an existing step
 *   - change control flow so the step SEQUENCE differs on replay
 *   - an AI-SDK / library upgrade that alters any of the above
 *
 * Do NOT bump for recovery-compatible changes:
 *   - editing logic INSIDE a step (its recorded output is replayed, not re-run)
 *   - non-workflow code, comments, formatting, renames that don't change step order
 *
 * Bumping deliberately strands whatever is mid-flight on the prior version (a
 * one-time cost) — correct, because those instances ARE incompatible.
 *
 * EXEMPLAR — "3" -> "4" (unified-control-plane T3, `threadGateWorkflow`):
 * the gate's hosted-dispatch branch used to `await enqueueHostedHarness(...)`
 * — start the hosted child AND block until `handle.getResult()` resolved —
 * before proceeding to its `consumeRunProjection` step. That became
 * `startHostedHarness(...)`: start the child, do NOT await its result, fall
 * straight through to `consumeRunProjection`. Two things make this
 * version-bump-worthy rather than recovery-compatible:
 *   1. Dropping the `getResult()` wait removes a whole recorded parent-
 *      workflow operation from `threadGateWorkflow`'s journal — an in-flight
 *      v3 instance recovered against v4 code would replay dispatch, then look
 *      for a recorded "await the child" operation that the new code path
 *      never issues, and diverge.
 *   2. The step immediately after — `consumeRunProjection` — now runs at a
 *      structurally different point in time for the hosted topology: before,
 *      it always ran AFTER the child (and everything it published) had
 *      already finished; now it runs concurrently with the child, live-
 *      tailing the stream exactly like the desktop topology already did (see
 *      `consume-run-projection.ts`'s T3 comment). That's a genuine step-
 *      sequence/timing contract change on a durably-recorded step, not an
 *      edit confined to logic inside one step.
 * Deploy consequence: any v3 gate workflow still mid-flight at deploy time
 * (a message queued or a run in progress when the new pods roll out) strands
 * — no v4 executor can recover it, by design (see "Bumping deliberately
 * strands..." above). The existing Stop-button cancel path
 * (`cancelThreadGateHead` + `cancelHostedHarness`, `routes.ts`) is the
 * user-facing recovery: cancel the stranded gate/child and re-send.
 *
 * Version 6 makes the hosted runtime explicit in automation dispatch-step
 * output; replaying a version-5 request with no harness would be ambiguous
 * after coding-agent execution moved exclusively into the native app. It also
 * adds `validateHostedThread` as the first background-tool workflow step so
 * durable jobs from the retired desktop transport fail before doing work.
 *
 * Version 7 removes request-selected agent, harness, and sandbox fields from
 * every hosted workflow input, including the background-tool snapshot, and
 * removes the background reaction-target step's redundant agent output.
 * In-flight version-6 journals contain the old recorded shapes, so replaying
 * them against the thread-authoritative contract would diverge.
 */
export const DBOS_WORKFLOW_VERSION = "7";
