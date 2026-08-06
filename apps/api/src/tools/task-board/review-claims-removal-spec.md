# Spec: remove `task_board_review_claims`

## Context

`task_board_review_claims` (migration `155`) exists to do two unrelated jobs at
once, and the coupling is what makes it a table:

1. **Idempotent dispatch.** Its PK `(task_board_item_id, reviewer, cycle_at)`
   makes reviewer enqueue an atomic `INSERT … ON CONFLICT DO NOTHING`, so the
   three trigger paths (60s sweeper, the task dialog's 10s poll, the dead
   projector hook) can race and still spawn exactly one QA / Code Reviewer run
   per review cycle.
2. **Reviewer-identity binding.** Each claim mints a random `rtok_<uuid>` handed
   to that reviewer's run in its prompt. `TASK_BOARD_REVIEW_DECISION` resolves
   the token back to a claim to confirm the caller really is the reviewer it
   says it is — without it, `reviewer` is self-asserted and one agent could
   forge the "both reviewers approved" gate and trigger auto-merge.

Job 1 is a hand-rolled deterministic idempotency key — exactly what a DBOS
workflow ID already is. The repo solves the identical problem 200 lines away in
the same directory (`stall-recovery.ts:144`, `stall-nudge:${item.id}:${thread.threadId}`),
and that call site's comment ends: *"That is also why there's no separate
'already nudged' marker."* Same idiom at `install-studio-pack:${VERSION}:${orgId}`
and `hostedChildWorkflowId(runId, fenceToken)`.

Job 2 is a signed capability, not workflow state — the token goes to an LLM in a
sandbox and returns over HTTP minutes later. DBOS has no way to authenticate an
inbound caller as a run it spawned, and the two jobs **cannot share one string**:
dedup needs the key deterministic, auth needs it unguessable. `review:<item>:<kind>:<cycle>`
is guessable by any reviewer run (its own task id is in its prompt, `cycle_at` is
readable from the activity log). But job 2 doesn't need a table either — an HMAC
over the same tuple verifies statelessly.

**Outcome:** the table, its migration, and three storage methods go away; the
fence becomes a workflow ID and the token becomes a signature. Net deletion, and
one durability bug (below) disappears with it.

## The bug this also fixes

`releaseReviewerClaim` (`storage/task-board.ts:1017`) exists only because the
current fence is not durable: the claim commits, then the dispatch throws, and
the slot is poisoned for the rest of the cycle with no thread behind it — so that
reviewer never runs. It needs a compensating delete. A DBOS workflow ID has no
such window: the workflow *is* the durable unit and DBOS retries it. The method
and its `.catch()` call site (`enqueue-reviewer.ts:117`) are deleted, not ported.

## Changes

### 1. Fence → workflow ID

`apps/api/src/tools/task-board/enqueue-reviewer.ts`

- Delete the `claimReviewer` call (`:101`) and the `releaseReviewerClaim`
  compensation (`:117`). `enqueueEnabledReviewers` keeps its flag filter and its
  `reviewerHandledThisCycle` check (`:135`) — that's a cheap pre-filter, not the
  fence.
- Pass a deterministic workflow ID through `enqueueAgentRunForTask` →
  `enqueueThreadRun`, matching `stall-recovery.ts:144`:

  ```ts
  { workflowID: `review:${item.id}:${kind}:${cycleAt.toISOString()}` }
  ```

  `enqueueThreadRun` already accepts `opts?: { workflowID?: string }`
  (`dispatch-queue/thread-gate-workflow.ts:441`); `enqueueAgentRunForTask`
  (`enqueue-task-run.ts:21`) needs the option threaded through.
- `cycleAt.toISOString()` must be the **only** serialization used — a formatting
  difference between two trigger paths silently breaks the fence.

**Precondition (already met, keep it true):** `DBOS.startWorkflow` is illegal
inside a step. Both live triggers are outside one — the sweeper's `setInterval`
(`review-sweeper.ts:189`) and the `prs-get.ts:729` tool handler.

**This does not delete the sweeper.** `review-sweeper.ts:1-40` exists because the
DBOS projector run-finish hook cannot call `startWorkflow` from a step; moving
the fence into a workflow ID does not change that.

### 2. Token → HMAC

New: `apps/api/src/tools/task-board/review-token.ts`, modelled directly on
`apps/api/src/file-storage/share-password.ts:61-108` (same signing key, same
`createHmac("sha256", …)`, same `timingSafeEqual` compare).

```ts
// key: settings.studioJwtSecret ?? settings.betterAuthSecret, cached, as share-password.ts:61
export function mintReviewToken(
  itemId: string, reviewer: ReviewerKind, cycleAt: Date,
): string {
  const mac = createHmac("sha256", getSigningKey())
    .update(`${itemId}:${reviewer}:${cycleAt.toISOString()}`)
    .digest("base64url");
  return `rtok_${mac}`;
}

export function verifyReviewToken(
  token: string, itemId: string, reviewer: ReviewerKind, cycleAt: Date,
): boolean {
  const a = Buffer.from(token);
  const b = Buffer.from(mintReviewToken(itemId, reviewer, cycleAt));
  return a.length === b.length && timingSafeEqual(a, b);
}
```

Keep the `rtok_` prefix — it is quoted verbatim in prompts and tests.

`apps/api/src/tools/task-board/review-decision.ts`

- Replace `resolveReviewClaimByToken` (`:120-126`) with `verifyReviewToken`. The
  handler must derive `cycleAt` itself via the existing `lastInReviewTime`
  helper (`enqueue-reviewer.ts:148`) — export it or move it to a shared module.
  This is the one bit of work the token lookup used to do for free.
- Preserve the current semantics exactly (`:23`, `:116-126`): a missing or wrong
  token still **records** the decision, it just sets `verified: false` and so
  never counts toward `allEnabledReviewersVerifiedApproved` (`:29`). Fail open on
  recording, fail closed on merging.

### 3. Storage + schema removal

- `apps/api/src/storage/task-board.ts` — delete `claimReviewer` (`:979`),
  `releaseReviewerClaim` (`:1017`), `resolveReviewClaimByToken` (`:1033`).
- `apps/api/src/storage/types.ts` — delete `TaskBoardReviewClaimTable`
  (`:1670`) and its registration (`:1935`).
- New migration `apps/api/migrations/166-drop-task-board-review-claims.ts` —
  drops the index then the table; `down()` recreates both (copy `155`'s `up`).
- Run `knip` after: the removals will orphan helpers.

### 4. Rollout (do not skip)

Dropping the table in one deploy breaks review cycles that are mid-flight — a run
dispatched before the deploy carries a `rtok_<uuid>` that no longer resolves, so
its approval silently stops counting toward auto-merge. Two steps:

1. **Deploy A** — mint HMAC tokens, and in `review-decision.ts` accept *either*
   an HMAC match *or* a legacy claim lookup. Fence moves to the workflow ID.
   Table still present, no longer written.
2. **Deploy B** — after the longest plausible review cycle has drained (a day is
   ample), delete the legacy branch and run migration `166`.

## Deliberately unchanged

- **Token revocability.** HMAC tokens can't be revoked. Neither can today's —
  nothing deletes a claim row. A re-review pushes a new `cycle_at`, which mints a
  new token either way. No regression.
- **One-decision-per-cycle.** Not enforced by the claim table today (the
  `reviewCycleVerdicts` reducer in `packages/shared/src/task-board.ts` takes the
  latest per reviewer). Out of scope.
- **The web ship button.** `review-status.ts:30` deliberately ignores token
  verification because a human is clicking. Server auto-merge requires
  `verified`. Keep the asymmetry — it is intentional, and unifying it by accident
  is the main risk in this change.
- `ReviewerKind`, `REVIEWER_LABEL`, the thread-title-prefix identity hack, the
  org flags, and the reviewer prompts. All untouched.

## Verification

1. `bun test apps/api/src/tools/task-board/` — `enqueue-reviewer.test.ts` and
   `review-sweeper.test.ts` assert the dedup behavior. **Invert, don't append:**
   any test asserting `claimed: false` on the second call now asserts one
   workflow ID collapse. Add a `review-token.test.ts` round-trip plus a
   wrong-`reviewer` / wrong-`cycleAt` / tampered-MAC rejection.
2. `bun test apps/api/src/storage/task-board-pending-review.integration.test.ts`
   — real Postgres; confirms the sweeper's query still works without the table
   (an in-memory fake would not catch a dropped column).
3. `packages/e2e` — grep for `rtok_`, `review_claims`, and
   `TASK_BOARD_REVIEW_DECISION` across **both** tiers before declaring done.
4. End-to-end on a real task: move a card to In Review with a ready PR, confirm
   from the activity timeline that exactly **one** `review_requested` per enabled
   reviewer lands (the sweeper and the dialog poll both fire within 60s, so this
   is a live race, not a hypothetical), then that `review_approved` carries
   `verified: true` and auto-merge fires only after both.
5. `bun run check && bun run lint && bun run fmt && knip`.
