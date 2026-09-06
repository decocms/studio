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
 *      already finished; now it runs concurrently with the child and live-
 *      tails the stream (see `consume-run-projection.ts`). That's a genuine step-
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
 * Version 7 removes the per-seat billing workflows (`syncOrgBenefitsWorkflow`
 * + `benefitsSyncSweep`); in-flight v6 instances strand by design.
 *
 * Version 8 splits `jiraCommentPushWorkflow` from one step into one step per
 * external call — `resolveCommentTarget`, `readOrgSlug`, `attachCommentImage`
 * per screenshot, then `postCommentToJira` (which also gained recorded
 * arguments). Added and reordered steps, so a v7 instance replayed against v8
 * hits `stored.functionName !== funcName` on its first step and throws
 * `DBOSUnexpectedStepError`; those instances strand instead, by design. The
 * one already past its Jira POST is still not re-mirrored by the pull, which
 * cuts the echo by author account as well as by comment link (`sync.ts`).
 *
 * Version 9 turns the notification digest event-triggered:
 * `notificationDigestWorkflow` keeps its name but is now the safety-net sweep
 * (`loadOrphanedNotifications`, and a `claimForEmail` step before each send in
 * place of the old `stampEmailed` after it), and the new per-recipient
 * `notificationUserDigestWorkflow` carries the normal path. Steps were added,
 * removed and reordered, so a v8 digest instance replayed against v9 diverges.
 * Cheap to strand: the workflow was a five-minute tick that finishes in
 * milliseconds and holds nothing a user is waiting on.
 *
 * Version 10 adds `conflict` to `SweptPrState`, the recorded output of
 * `taskBoardGithubReadWorkflow`'s `readPrState` step. Same step sequence and
 * same GitHub call — only the recorded output contract widened, which is still
 * a v9 instance replaying against a shape it never wrote. Cheap to strand: one
 * throttled PR read the sweep re-issues on its next pass.
 *
 * Version 11 removes the Jira mirror's five workflows (`jiraSyncWorkflow` and
 * the comment, status, sprint and remote-link pushes) along with their
 * `jira-push` queue; in-flight v10 instances strand by design, the same way v7
 * stranded the billing sweeps. Nothing a person is waiting on: the pushes
 * mirrored board edits onto issues the board no longer copies.
 */
export const DBOS_WORKFLOW_VERSION = "11";
