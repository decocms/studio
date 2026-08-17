# Super Agent run failures & continuation — findings (2026-08-11)

Handoff for a fresh session. Investigation started from a prod card whose Re-run
button answered **"This task reached its limit"**: a task assigned to the Super
Agent that a human could no longer run at all.

- Card: `board_pA_7SsIEhMmcStEcAidCs` — "Reduzir o Speed Index no post de 17.9s
  para abaixo de 3.4s"
- Org: `yAdMUAsdpXrhJtjInQj3x59Znqew5C0c` (deco-studio)
- URL seen: `https://studio.decocms.com/deco-studio/52e94ac4-…?…&main=board`
  (that UUID is the chat thread the board was opened from, NOT the run)

## 1. What actually happened — the five runs

`task_quota_claims.run_count = 5`, `maxRunsPerTask = 5` (default,
`STUDIO_MAX_RUNS_PER_TASK`), `state = 'released'`. All five dispatches:

| # | thread | when (UTC) | outcome |
|---|--------|-----------|---------|
| 1 | `thrd_POgX5SJ_LBMcyKDQxJyx9` | 08-05 21:10 | error part: `The socket connection was closed unexpectedly` (then marked `superseded` by the user's re-run) |
| 2 | `thrd_0uGonRTH39mE5n-xn3fQt` | 08-05 21:10 | same socket close, `failure_kind=error` |
| 3 | `thrd_CxaWnQ8gx81aIQz9eEf8Z` | 08-06 13:14 | daemon terminal `cancelled: run cancelled`, 78s in, mid-reasoning |
| 4 | `thrd_WyzUVuyb4rFn6wagfV-5f` | 08-11 16:31 | the user's own Re-run superseded it (101 tool calls in) |
| 5 | `thrd_BylTOm0VxijYWoFFptQAI` | 08-11 16:47 | 13 min / 94 tool calls, then `failed` / `kind=error` with **no error part at all** |

Then: 08-11 20:26 and 21:43 Re-runs were **rejected by the per-task cap** —
`task_board_activity` shows the `rerun` status row (written before the throw) but
no new thread was created. Between them, the sweeper's own retry
(`retry 1 of 1` at 20:27 → `todo, retriesSpent 1` at 20:39) also spent budget.

No PRs were ever linked (`task_board_item_prs` empty). The card nonetheless sat
in **In Review** from 08-06 13:15:59 until the 08-11 re-run — writer of that
transition not identified (`shouldAdvanceToReview` should have refused: no
`completed` thread). **Open question, worth 10 minutes.**

### Causes

- **#1/#2 — the transport.** One HTTP request per run, held open for the whole
  turn, tunneled over a **kube apiserver port-forward WebSocket**
  (`packages/sandbox/server/provider/agent-sandbox/runner.ts:2463` `openForwarder`,
  `:2510` `handleForwardedConnection`). Any break in that chain closes the
  response body mid-stream; Bun reports it verbatim. Candidates: apiserver
  connection recycling / control-plane roll, a WS-level error (`ws.on("error")` →
  `invalidateRecord` + `socket.destroy()` kills the body even when the pod is
  healthy), pod eviction. NOT idle timeout — the daemon keepalives every 15s.
  Already mitigated by **#5780** (`9ead44f7e`, merged 08-05 **19:45 -03**, i.e.
  ~3h AFTER these two failures): a mid-stream break is now
  `SandboxUnreachableError` → re-provision and continue once
  (`isTransientStreamError` in `sandbox-dispatch-client.ts:638`).
- **#3 — a displaced dispatch reporting `cancelled`.** The daemon writes that
  terminal when its request ctx is cancelled and its registry does not consider
  the run displaced (`packages/sandbox/daemon-go/internal/dispatch/dispatch.go:440-460`).
  The takeover case (worker dies → DBOS recovers the workflow elsewhere → the
  successor's dispatch displaces this one → the displaced handler settles the
  live thread as `Error: cancelled: run cancelled`) is exactly what **#5859**
  (`ae21b8000`, 08-07 14:52) fixed by reporting `superseded` instead — **one day
  after** this run. Would be silent today. Confirming log line
  (`dispatch cancelled` vs `dispatch superseded by takeover`) is gone.
- **#4 — expected.** The user superseded their own run.
- **#5 — unknown, and unknowable from the data**: `failure_kind=error` with zero
  `kind='error'` parts. Also note `last_progress_at` (17:00:36) is *after* the
  `failed` write (`updated_at` 16:59:05) — the stream kept appending for ~90s
  past the terminal. Logs for 16:59 UTC are gone (API pods are younger) and I had
  no Grafana/VictoriaLogs token.

## 2. Shipped

- **PR #5931** `fix/failed-run-error-text` — `failedRunInfo`'s error-part
  subquery was **uncorrelated**: its `LIMIT 1` applied to the whole
  `thread_message_parts` table, so the join matched only when the thread being
  reacted to happened to own the newest error part in the deployment. Verified in
  prod: three threads that each *have* an error part all read `NULL`.
  Consequences: `isTransientRunFailure` sees no text →
  `TRANSIENT_ERROR_PATTERNS` (`sandbox did not become ready`,
  `too many clients`, 429/503, `harness_crashed: unexpected eof`) was
  effectively **dead in production**, so recognized infra got the 1-attempt
  unknown budget instead of 3; and the card's timeline recorded a bare `"error"`
  with no reason. Fixed with a LATERAL. New real-PG test fails on the old query.
- **PR #5932** `fix/user-rerun-not-capped` — a user-initiated re-run no longer
  claims against `maxRunsPerTask` (that cap bounds *automatic* re-dispatch, and
  the sweeper's retries spend the same tally). The org's period bucket still
  gates it; every automatic path keeps the cap. Also pre-checks quota **before**
  the status write, because the refused re-run had already flipped the card to In
  Progress → the sweeper read that as a stalled run and re-dispatched into the
  same rejection (two such loops on this card's timeline).
  New helper: `userInitiatedTaskQuotaConfig()` in `apps/api/src/billing/task-quota.ts`.
  Marked ceiling (`ponytail:`): a still-`held` claim now funds unlimited *manual*
  re-runs.

## 3. The real gap — a failed claude-code run cannot be continued, only restarted

This is the highest-value follow-up and the reason one task burned five runs on
~15 minutes of real work each.

Two continuation mechanisms exist; neither reaches a failed claude-code Super
Agent run.

**In-run continuation** — `dispatchWithContinuation`
(`apps/api/src/harnesses/sandbox-dispatch-client.ts:401`): capped at
`MAX_DISPATCH_ATTEMPTS = 2`, fires only for `SandboxUnreachableError`. Run #5 was
a plain error, so it got nothing. And it is **not** session resume:

- `resume: { reason }` is a **text preamble appended to the original prompt**
  (`packages/harness-runner/claude-code.ts:63-103`, `promptForRun` /
  `resumeInstruction`) telling the model its conversation is gone, to read
  `git status` / `git diff` / `git log` / `gh pr list --head <branch>`, continue
  rather than restart, and never open a second PR.
- A continuation resends **only the original user prompt text + that note** — no
  prior assistant messages, no tool calls, no tool results
  (`promptFromUserMessage`, `claude-code.ts:106-121`; Studio side
  `dispatch-run.ts:1242`, `:1309`).
- The Agent SDK session id is persisted **only to the pod's own disk**
  (`~/.claude/deco-sessions/<threadId>`, `claude-code.ts:133-137`), written only
  **after a successful turn** (`:399`), applied as the SDK `resume` option
  (`:218`). The pod is `cloneOnly` and shut down at run end (`releaseAfter`), so
  it never survives the failure that would need it. The wire has
  `harness.sessionId` (`packages/sandbox/dispatch/schemas.ts:122`) and Studio
  always sends `undefined` (`dispatch-run.ts:1310`).
- The daemon keeps **no frame buffer and no seq cursor** on dispatch (grep for
  `fromSeq`/`replay` in `daemon-go/internal/dispatch/` — nothing), so a broken
  socket can never resume at a chunk offset; it can only restart the turn.
  Studio's `run_acked_seq` / `resumeFromSeq` (`dispatch-run.ts:1366`) is an
  append-dedup floor, not a replay cursor.

**Board-level continuation** — the nudge in
`apps/api/src/tools/task-board/stall-recovery.ts` re-prompts **the same thread**
with `NUDGE_PROMPT` ("Don't start over and don't redo work you already committed
or pushed"). It is gated by `decideStallAction` → `isHostedDecopilotRuntime`
(`apps/api/src/harnesses/decopilot/hosted-runtime.ts`), which requires
`harnessId === "decopilot"`. **Every Super Agent run on an org with a repo
imported is `claude-code`** (`resolveTaskRepoChoice` in
`enqueue-super-agent.ts`). So `decideStallAction` returns `"none"` for every one
of this card's failures, and the only recovery the product exposes is
`TASK_BOARD_ITEM_RERUN` → new thread, new sandbox, new `sandbox/thread-<id>`
branch, prompt from scratch.

### Proposed, cheapest first

1. **Let a failed claude-code thread be nudged.** Widen the runtime predicate to
   accept `harnessId === "claude-code" && sandboxProviderKind === "agent-sandbox"`
   (v2 threads only, as today). Same thread → same branch → the dead run's
   commits are already there, and the transcript is in `thread_message_parts`.
   Verify the nudge's `enqueueThreadRun` path is valid for the claude-code
   harness (it should be — `dispatch-run.ts` serves both). Small, and it is the
   fix that would have saved this card.
2. **Make the automatic retry a continuation, not a restart.**
   `reactToFailedTaskRun` (`run-reactions.ts`) re-dispatches through
   `enqueueSuperAgentForTask`, which mints a fresh thread. When the failed thread
   has work (parts, or commits on its branch) it should re-prompt *that* thread
   with the existing resume preamble instead — saves a sandbox boot per retry
   and keeps one branch/PR per task.
3. **Only then, real session continuity.** Persist the SDK session id where it
   outlives the pod and write it after every turn, not only successful ones. Low
   value on its own: the id is useless unless the SDK's session *store* is also
   durable, and it lives in the pod's `~/.claude`.
4. **Structural, bigger:** a resumable pull — the daemon numbers frames, Studio
   already tracks `run_acked_seq`; a `fromSeq` on dispatch would let a broken
   socket resume mid-turn instead of restarting it. Fixes the #1 and #5 classes
   together.

Prerequisite for all of it: you can only continue what you can classify, and #5
recorded no error text. PR #5931 fixes the half where the text exists but the
reaction read the wrong row; **the half where the harness dies without writing an
error part is still open.**

## 4. Other open items found on the way

- `enqueueSuperAgentForTask` rolls the quota tally back only for a `"claimed"`
  outcome, so a `"rerun"` claim whose dispatch throws spends a run that never
  started (`enqueue-super-agent.ts`, the `catch` at the end).
- `review-sweeper.ts` `dispatchDueRetries` re-arms `retry_at` with the SAME
  `attempts` when a retry dispatch throws — a `TaskQuotaError` there re-arms
  indefinitely (budget never terminates for that failure mode).
- The card reached **In Review with no PR and a cancelled run** (08-06 13:15:59,
  `actor_id: null`). Writer unidentified; `shouldAdvanceToReview` should have
  refused.
- `threads.run_started_at` is NULL even for actively streaming claude-code runs —
  worth checking whether `failNeverStartedLinkedThreads`
  (`t.run_started_at IS NULL`, storage/task-board.ts:717) can force-fail a live
  run. It is guarded by a stale `last_progress_at` too, so probably safe, but the
  discriminator's premise no longer holds for this harness.
- `thread_messages` has had no writes since **2026-06-19** (all threads are
  `message_storage_version = 2`). The `hasMessages` check in `attachThreads`
  correctly ORs in `thread_message_parts` — but anything else still keyed on
  `thread_messages` alone is dead. Worth a grep.

## 5. Reproducing the prod queries

Use the `query-prod-postgres` skill (READ-ONLY; `eks-serverless` /
`deco-studio`, container `studio-api-0`, helper at `/app/apps/api/q.ts`).

⚠️ **Never `select *` (or `state`) from `sandbox_runner_state`** — the `state`
jsonb holds live GitHub clone tokens (`ghu_…`) and daemon tokens. I hit this and
had to delete the dump.

Useful ones:

```sql
-- the card's timeline
select action, actor_id, occurred_at, data::text from task_board_activity
where task_board_item_id='board_pA_7SsIEhMmcStEcAidCs' order by occurred_at;

-- its runs
select thread_id, created_at from task_board_item_threads
where task_board_item_id='board_pA_7SsIEhMmcStEcAidCs' order by created_at;

select id, status, failure_kind, left(failure_reason,200), run_started_at,
       last_progress_at, updated_at, harness_id, sandbox_provider_kind
from threads where id in (...);

-- why a run died
select seq, kind, left(payload::text,400) from thread_message_parts
where thread_id='thrd_…' order by seq;

-- the quota ledger
select * from task_quota_claims where task_board_item_id='board_…';
select status, free_task_executions, monthly_task_executions
from organization_billing where organization_id='yAdM…';

-- proof of the #5931 bug (payload comes back NULL for threads that HAVE one)
select t.id, err.payload is null as errortext_lost from threads t
left join (select p.thread_id, p.payload from thread_message_parts p
           where p.kind='error' order by p.created_at desc limit 1) err
  on err.thread_id = t.id
where t.id in ('thrd_0uGonRTH39mE5n-xn3fQt','thrd_CxaWnQ8gx81aIQz9eEf8Z');
```

Local real-PG tests (no Docker needed, homebrew `postgresql@14` is running):

```bash
psql -p 5432 -d postgres -c "create database mesh_test"
export DATABASE_URL="postgresql://$USER@localhost:5432/mesh_test"
bun run --cwd=apps/api migrate
bun test apps/api/src/storage/task-board-advance-review.integration.test.ts
bun test apps/api/src/billing/task-quota.integration.test.ts
```
