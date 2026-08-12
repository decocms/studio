/**
 * The review sweep's GitHub reads, behind a globally rate-limited DBOS queue.
 *
 * Nothing capped how fast the board asked GitHub for PR state. The sweep alone
 * polled ~77 PRs on a 5-minute interval at four-plus calls each, and the load
 * is lopsided — 47 of those PRs live in two repos — so one org's backlog of
 * parked cards spent the whole shared `github-mcp` budget and every other org's
 * reads came back 429. The card that prompted this had both reviewers approved
 * and its merge refused with "too many requests".
 *
 * The existing guards each fix a different multiplier and none of them is a
 * ceiling: `last_swept_at` stops three replicas sweeping the same card, the
 * read cache stops two viewers of one PR costing two calls, and `isRetriable`
 * stops a 429 becoming three. What was missing is a limit on the TOTAL, and a
 * DBOS queue's `rateLimit` is enforced in the system database across every
 * replica — which an in-process token bucket cannot be.
 *
 * Only the READ half runs here. The sweeper's reviewer dispatch bottoms out in
 * `DBOS.startWorkflow`, which DBOS rejects from inside a step, and that is the
 * whole reason the sweeper is a plain timer rather than a workflow. So the
 * caller enqueues this, awaits the state, and dispatches out in its own
 * non-workflow context exactly as before.
 *
 * Throttling makes the sweep SLOWER, deliberately. It is the floor, not the
 * fast path: the dialog's poll and the run's terminal hook still react
 * immediately, `markSwept` claims a card's interval before this call so a slow
 * tick simply visits fewer cards, and the sweeper's `running` flag stops ticks
 * overlapping. A card waits on CI for minutes anyway.
 */

import { DBOS } from "@dbos-inc/dbos-sdk";
import type { Kysely } from "kysely";
import { GITHUB_READS_QUEUE } from "@/dispatch-queue/queue-names";
import type { Database, TaskBoardItemPrRef } from "@/storage/types";
import { buildOrgContext } from "./org-context";
import { fetchPrCandidateState } from "./prs-get";

/**
 * Reads started per minute across ALL replicas.
 *
 * Sized off what the sweep costs at rest: ~77 polled PRs on a 5-minute card
 * interval is ~15 PRs/min, and each is now one workflow and one GitHub call.
 * 20/min leaves headroom for a backlog to drain while staying well inside what
 * the shared gateway answers without 429s — and everything else that talks to
 * GitHub (the dialog poll, the merge, the reviewers' own `gh` calls in their
 * sandboxes) is unthrottled and has to fit alongside it.
 */
const READS_PER_MINUTE = 20;

/**
 * Reads in flight at once, across all replicas.
 *
 * A rate limit alone would let a whole minute's allowance start together, and
 * the limit being hit here is GitHub's SECONDARY one, which punishes exactly
 * that shape — concurrent bursts, not a raw hourly count (see
 * `isRateLimitError`). Four workflows × three calls caps the burst at a dozen.
 *
 * Global rather than per-worker, so it means the same thing however many
 * replicas run. The cost of global is that any PENDING workflow holds a slot,
 * which is what {@link READ_TIMEOUT_MS} exists to bound.
 */
const CONCURRENT_READS = 4;

/**
 * Ceiling on one read, so a wedged workflow can't hold a concurrency slot
 * forever. Generous against the read's own budget — one call at the 8s
 * per-call cap, plus a cold MCP handshake.
 */
const READ_TIMEOUT_MS = 60_000;

export const GITHUB_READS_QUEUE_PARAMS = {
  concurrency: CONCURRENT_READS,
  rateLimit: { limitPerPeriod: READS_PER_MINUTE, periodSec: 60 },
} as const;

export interface TaskBoardGithubReadRuntime {
  db: Kysely<Database>;
}

let runtime: TaskBoardGithubReadRuntime | null = null;

/** Wire deps for the workflow body. Safe to call before `DBOS.launch()`:
 *  it only writes a module-level pointer, no DBOS API calls. */
export function setTaskBoardGithubReadRuntime(
  rt: TaskBoardGithubReadRuntime,
): void {
  runtime = rt;
}

/** What `prReadyForReview` and the sweep's logging consume. Narrow because it
 *  crosses the workflow boundary and is recorded in the DBOS journal — the
 *  dialog's richer `PrLiveState` (checks, preview URL, per-check summaries) is
 *  not fetched on this path at all. */
export type SweptPrState = {
  state: "open" | "closed" | null;
  merged: boolean | null;
};

const UNKNOWN: SweptPrState = { state: null, merged: null };

async function readPrState(
  organizationId: string,
  pr: TaskBoardItemPrRef,
): Promise<SweptPrState> {
  if (!runtime) {
    throw new Error(
      "[task-board-github-read] runtime not initialized — setTaskBoardGithubReadRuntime() must run before the workflow fires",
    );
  }
  const ctx = await buildOrgContext(runtime.db, organizationId);
  if (!ctx) return UNKNOWN;
  return await fetchPrCandidateState(ctx, organizationId, pr);
}

async function githubReadWorkflowFn(
  organizationId: string,
  pr: TaskBoardItemPrRef,
): Promise<SweptPrState> {
  return await DBOS.runStep(() => readPrState(organizationId, pr), {
    name: "readPrState",
  });
}

let registeredWorkflow: typeof githubReadWorkflowFn | null = null;

/**
 * Must run before DBOS.launch(). Guarded so HMR repeats don't re-register.
 *
 * ⚠️ Durable DBOS workflow. Changing its STEP SEQUENCE (add/remove/reorder a
 * step, or change a step's recorded I/O) requires bumping
 * DBOS_WORKFLOW_VERSION — see apps/api/src/dbos/workflow-version.ts.
 */
export function registerTaskBoardGithubReadWorkflow(): void {
  if (registeredWorkflow) return;
  registeredWorkflow = DBOS.registerWorkflow(githubReadWorkflowFn, {
    name: "taskBoardGithubReadWorkflow",
  });
}

/**
 * Read a PR's state through the rate-limited queue, waiting for its turn.
 *
 * Best-effort like every other GitHub read on this path: an unreachable
 * workflow yields all-nulls, which `prReadyForReview` treats as "we could not
 * ask" rather than "no" — the distinction that stopped a quiet GitHub freezing
 * the whole review pipeline once already.
 */
export async function readPrStateThrottled(
  organizationId: string,
  pr: TaskBoardItemPrRef,
): Promise<SweptPrState> {
  if (!registeredWorkflow) return UNKNOWN;
  try {
    const handle = await DBOS.startWorkflow(registeredWorkflow, {
      queueName: GITHUB_READS_QUEUE,
      timeoutMS: READ_TIMEOUT_MS,
    })(organizationId, pr);
    return await handle.getResult();
  } catch (err) {
    console.error("[task-board-github-read] throttled PR read failed", err);
    return UNKNOWN;
  }
}
