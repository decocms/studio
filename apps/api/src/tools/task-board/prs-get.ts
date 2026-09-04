import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import {
  GitProviderError,
  changeRequestClientForOrigin,
  type ChangeRequest,
  type ChangeRequestClient,
  type ChangeRequestDetail,
  type CheckRun,
  type ChecksSummary,
} from "@/git-providers";
import type { TaskBoardItemPrRef } from "@/storage/types";
import {
  LANES,
  shippedLane,
  SUPER_AGENT_ASSIGNEE_ID,
} from "@decocms/shared/task-board";
import { repoIdentityKey } from "@decocms/shared/git-providers";
import { retry, RetryError } from "@decocms/shared/std";
import { TaskBoardItemPrSchema } from "./schema";
import { cardWorkLanded } from "./archive-merged";
import { recordTaskActivity } from "./activity";
import { originOf } from "./change-request-extract";
import { inReviewPhase, movesForward } from "./lanes";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueEnabledReviewers } from "./enqueue-reviewer";
import { reactToApprovedPrConflict } from "./conflict-reaction";
import { readPrStateThrottled } from "./dbos-github-read";
import { getPrCardCache, getPrReadCache } from "./pr-cache";

export type { ChecksSummary as ChecksStatus };

/**
 * The provider answered "too many requests" — the primary or (more often here)
 * the SECONDARY rate limit, which punishes bursts of concurrent calls rather
 * than a raw hourly count. Retrying that is not a retry, it's the burst: it
 * triples the very thing being limited, and the retried calls are what keep
 * the limit shut. So a rate-limit answer ends the attempt immediately and the
 * cache below serves the last good value instead.
 *
 * A provider client raises `GitProviderError`, which says so outright. The
 * message match is the fallback for the paths that don't (GraphQL's transport
 * throws a plain `Error`). Exported for the unit test.
 */
export function isRateLimitError(err: unknown): boolean {
  if (err instanceof GitProviderError && err.isRateLimited) return true;
  const message = err instanceof Error ? err.message : String(err);
  // Scrub the request URL first: a `429` in `…/pulls/429/merge` is not a status.
  const withoutUrls = message.replace(/https?:\/\/\S+/gi, " ");
  return /too many requests|rate limit|\b429\b/i.test(withoutUrls);
}

/**
 * Drop this repository's cached reads. Call it after WRITING to the provider
 * (a merge), so the next poll sees the new state instead of serving the
 * pre-merge one for the rest of the revalidate window — the card only moves to
 * Done once a poll observes a merge, and a minute of "did my ship button
 * work?" is exactly the confusion this cache must not introduce.
 */
export function invalidatePrReads(namespace: string): Promise<void> {
  return getPrReadCache().invalidate(namespace);
}

/**
 * Drop an org's cached PR CARDS. Called after a write that changes what a card
 * shows (a merge), so the next poll rebuilds it instead of serving the
 * pre-merge card for the rest of the revalidate window.
 *
 * Org-wide rather than per task: a merge is rare, the rebuild is one poll's
 * work, and a card keyed to the wrong task is worse than a cold one.
 */
export function invalidatePrCards(organizationId: string): Promise<void> {
  return getPrCardCache().invalidate(organizationId);
}

/** `owner/repo#number`, for log lines. */
const prLabel = (pr: TaskBoardItemPrRef) =>
  `${pr.repoOwner}/${pr.repoName}#${pr.number}`;

/**
 * The cache namespace for one repository's reads. The repository, not the
 * credential: two agents in an org reading the same change request must share
 * one entry, and the answer does not depend on which of the org's credentials
 * asked.
 */
export const readNamespace = (pr: TaskBoardItemPrRef) =>
  repoIdentityKey(originOf(pr).repo);

/**
 * One cached, best-effort provider read. Best-effort in the same sense as the
 * rest of this file: `null` on any failure, so the card still renders.
 *
 * The value stored is the NEUTRAL shape, not the provider's payload — which is
 * both smaller (a provider's change-request JSON runs past the cache's value
 * cap on a busy repository, and a rejected put means that change request
 * misses forever) and the only thing that could be shared between two
 * providers' answers.
 */
async function cachedRead<T>(
  namespace: string,
  key: string,
  describe: string,
  fetchLive: () => Promise<T>,
): Promise<T | null> {
  try {
    const raw = await getPrReadCache().fetch({
      namespace,
      key,
      fetchLive: () =>
        retry(fetchLive, {
          maxAttempts: 3,
          minTimeout: 300,
          maxTimeout: 3000,
          jitter: 1,
          isRetriable: (err) => !isRateLimitError(err),
        }),
      /**
       * Nothing to hold open: the provider clients are stateless HTTP, so a
       * background revalidation needs no resource kept alive for it — which is
       * what the MCP path had to arrange, and got wrong twice.
       */
      onRevalidation: () => {},
    });
    return (raw ?? null) as T | null;
  } catch (err) {
    const cause = err instanceof RetryError ? err.cause : err;
    console.error(`[task-board] ${key} failed for ${describe}:`, cause);
    return null;
  }
}

/**
 * The client that can read `pr`, or null when this org has no credential for
 * its repository. Logged at each call site, because "we asked the wrong
 * provider" and "the provider said no" have to stay distinguishable — a card
 * whose repository lost its credential must look broken, not empty.
 */
function clientFor(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<ChangeRequestClient | null> {
  return changeRequestClientForOrigin(ctx, orgId, originOf(pr)).catch(
    (err: unknown) => {
      console.error(`[task-board] no client for ${prLabel(pr)}:`, err);
      return null;
    },
  );
}

/** Whether `url`'s HOST is a known preview-deploy host — a strict hostname
 *  check, NOT a substring match. The preview is lifted from comments, which
 *  external contributors can write, and the result is shown as a trusted
 *  "Open preview" button AND handed to the autonomous QA reviewer to
 *  navigate. So a decoy like `https://evil.example.com/x?y=.decocdn.com` must
 *  be rejected. Exported for the unit test. */
export function isTrustedPreviewHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return (
    hostname === "deco.site" ||
    hostname.endsWith(".decocdn.com") ||
    hostname.endsWith(".deco-cx.workers.dev") ||
    hostname.endsWith(".deco.site") ||
    hostname.endsWith(".vercel.app") ||
    hostname.endsWith(".vtex.app")
  );
}

/** deco's Cloudflare account subdomain — the middle label of every
 *  `*.workers.dev` preview host these sites deploy to.
 *  ponytail: hardcoded; make it configurable if sites land in another account. */
const WORKERS_DEV_SUBDOMAIN = "deco-cx";

/**
 * The preview URL a CI run points at. Two shapes, both real:
 *
 * - Cloudflare's "Workers Builds: <worker>" run reports the deployed version
 *   in its own summary, which is exact and present even when its comment omits
 *   the preview column;
 * - every other provider just links the deploy from the run (a check run's
 *   details URL, a commit status's target URL).
 *
 * Exported for the pure-logic unit test.
 */
export function previewUrlFromChecks(runs: CheckRun[]): string | null {
  for (const run of runs) {
    const worker = /^Workers Builds:\s*([a-z0-9][a-z0-9-]*)\s*$/i.exec(
      run.name,
    )?.[1];
    const version = run.summary
      ? /Version ID:\s*([0-9a-f]{8})/i.exec(run.summary)?.[1]
      : null;
    if (!worker || !version) continue;
    const url = `https://${version}-${worker}.${WORKERS_DEV_SUBDOMAIN}.workers.dev`;
    if (isTrustedPreviewHost(url)) return url;
  }
  // A successful run's own link, preferred over an in-flight one's.
  const linked = runs.filter(
    (run) => run.url !== null && isTrustedPreviewHost(run.url),
  );
  const success = linked.find((run) => run.conclusion === "success");
  return success?.url ?? linked[0]?.url ?? null;
}

/**
 * Pull the preview URL out of the change request's comments — where the deploy
 * bot actually posts it. Known shapes: Cloudflare Workers'
 * `cloudflare-workers-and-pages[bot]` (a table with a "Commit Preview URL" AND
 * a "Branch Preview URL" — prefer the branch one, stable across the change
 * request's commits), deco.cx's `decobot` (a single "Visit Preview" markdown
 * link), and Vercel's `[Preview](url)` markdown link.
 *
 * Sorted newest-first by `updatedAt` (falling back to `createdAt`, then array
 * order), so a stale early comment can't win over a later re-deploy. By
 * `updatedAt` rather than `createdAt` because Vercel and Cloudflare edit ONE
 * sticky comment in place on each push: `createdAt` stays frozen at its first
 * post, so ranking by it could let an unrelated later human comment (that
 * happens to mention a matching host) outrank the bot's freshly edited one.
 * Exported for the pure-logic unit test.
 */
export function previewUrlFromComments(
  comments: { body: string; createdAt?: string; updatedAt?: string }[],
): string | null {
  const recency = (c: { createdAt?: string; updatedAt?: string }): number =>
    Date.parse(c.updatedAt ?? "") || Date.parse(c.createdAt ?? "");
  const sorted = comments
    .map((c, index) => ({ c, index }))
    .sort((a, b) => {
      const aTime = recency(a.c);
      const bTime = recency(b.c);
      if (Number.isNaN(aTime) || Number.isNaN(bTime)) return a.index - b.index;
      return bTime - aTime;
    })
    .map(({ c }) => c);
  for (const comment of sorted) {
    const body = comment.body;
    if (!body) continue;
    // Cloudflare's comment carries both a per-commit and a per-branch preview —
    // prefer the branch URL, which stays valid as the branch gets new commits.
    const branch = body.match(/href=['"]([^'"]+)['"][^>]*>\s*Branch Preview/i);
    if (branch?.[1] && isTrustedPreviewHost(branch[1])) return branch[1];
    const url = (body.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).find((u) =>
      isTrustedPreviewHost(u),
    );
    if (url) return url;
  }
  return null;
}

/** A git commit sha, validated 7–40 hex — also what keeps a malformed value
 *  from reaching the deployment lookup built from it. */
export function asHeadSha(sha: unknown): string | null {
  return typeof sha === "string" && /^[0-9a-fA-F]{7,40}$/.test(sha)
    ? sha
    : null;
}

/** One linked change request, as the card renders it. */
type PrLiveState = {
  title: string | null;
  body: string | null;
  state: "open" | "closed" | null;
  draft: boolean | null;
  merged: boolean | null;
  /** false = conflicts with base, true = clean, null = not computed yet. */
  mergeable: boolean | null;
  checksStatus: ChecksSummary;
  checks: PrCheck[];
  previewUrl: string | null;
};

/** One CI check on the change request, for the card's expandable footer.
 *  `summary` is the run's own report, fetched only for FAILING runs (the ones
 *  worth reading); null otherwise. */
export type PrCheck = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  summary: string | null;
};

/** The live fields before the provider has answered — also what the card cache
 *  serves as its placeholder while the real read runs. */
const NO_LIVE_STATE: PrLiveState = {
  title: null,
  body: null,
  state: null,
  draft: null,
  merged: null,
  mergeable: null,
  checksStatus: null,
  checks: [],
  previewUrl: null,
};

/**
 * The card's `state`/`merged` pair, from the neutral three-value state.
 *
 * The wire shape keeps them separate because `merged` alone cannot answer
 * `cardWorkLanded`: a closed-unmerged change request and an open one both
 * report false, and only the first is settled.
 */
export function cardLifecycle(state: ChangeRequest["state"]): {
  state: "open" | "closed" | null;
  merged: boolean;
} {
  if (state === "merged") return { state: "closed", merged: true };
  return { state, merged: false };
}

/** The card's per-check rows, with a report only where one is worth reading. */
async function checkRows(
  client: ChangeRequestClient,
  namespace: string,
  pr: TaskBoardItemPrRef,
  runs: CheckRun[],
): Promise<PrCheck[]> {
  const failing = (run: CheckRun) =>
    run.state === "completed" &&
    run.conclusion !== null &&
    run.conclusion !== "success" &&
    run.conclusion !== "skipped" &&
    run.conclusion !== "neutral";
  return await Promise.all(
    runs.map(
      async (run): Promise<PrCheck> => ({
        name: run.name,
        status: run.state,
        conclusion: run.conclusion,
        detailsUrl: run.url,
        summary:
          run.summary ??
          (failing(run) && run.id !== null
            ? await cachedRead(
                namespace,
                `check-log:${run.id}`,
                `${prLabel(pr)} check ${run.id}`,
                () => client.readCheckLog(run.id as string),
              )
            : null),
      }),
    ),
  );
}

/**
 * Everything the card shows for one linked change request. Best-effort: any
 * failure yields nulls so the modal still shows the link.
 *
 * ONE detailed read covers the lifecycle, the mergeability, every CI run and
 * every comment — where the MCP path made four to six calls whose answers
 * described four to six different moments. The deployment lookup is the only
 * extra, and only on the miss path.
 */
async function fetchPrLiveState(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<PrLiveState> {
  const client = await clientFor(ctx, orgId, pr);
  if (!client) return NO_LIVE_STATE;
  const namespace = readNamespace(pr);
  const detail = await cachedRead<ChangeRequestDetail | null>(
    namespace,
    `detail:${pr.number}`,
    prLabel(pr),
    () => client.readDetailed({ number: pr.number }),
  );
  if (!detail) return NO_LIVE_STATE;

  const { state, merged } = cardLifecycle(detail.state);
  const isOpen = state === "open";
  if (!isOpen) {
    return {
      ...NO_LIVE_STATE,
      title: detail.title,
      body: detail.body,
      state,
      draft: detail.draft,
      merged,
    };
  }

  let previewUrl =
    previewUrlFromChecks(detail.checkRuns) ??
    previewUrlFromComments(detail.comments);
  if (!previewUrl) {
    /**
     * Last resort: a deployment's own environment URL. Some hosts (VTEX
     * FastStore WebOps) publish the preview ONLY there — not as a run's link
     * and not as a bot comment — so it is the third and last source tried,
     * and only once the head sha is known.
     */
    const headSha = asHeadSha(detail.headSha);
    const deployed = headSha
      ? await cachedRead<string | null>(
          namespace,
          `deployed:${headSha}`,
          `${prLabel(pr)} (deployment preview)`,
          () => client.readDeployedUrl(headSha),
        )
      : null;
    previewUrl = deployed && isTrustedPreviewHost(deployed) ? deployed : null;
  }

  return {
    title: detail.title,
    body: detail.body,
    state,
    draft: detail.draft,
    merged,
    // Same field the conflict gate reads, so the two can't drift.
    mergeable: detail.conflicting === null ? null : !detail.conflicting,
    checksStatus: detail.checks,
    checks: await checkRows(client, namespace, pr, detail.checkRuns),
    previewUrl,
  };
}

/**
 * ONE cheap read, the whole call. Deliberately NOT the detailed one, which
 * also fetches every CI run and comment: the sweeps read every candidate in
 * one go, and that multiplier is exactly what took out the GitHub App's rate
 * limit once already (see `review-sweeper.ts`).
 *
 * Null on any failure, and never read as an answer by callers — an unreachable
 * provider means "we could not ask", not "no".
 */
async function readChangeRequest(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
  label: string,
): Promise<ChangeRequest | null> {
  const client = await clientFor(ctx, orgId, pr);
  if (!client) return null;
  return cachedRead<ChangeRequest | null>(
    readNamespace(pr),
    `read:${pr.number}`,
    `${prLabel(pr)} (${label})`,
    () => client.read(pr.number),
  );
}

/** Just the checks summary — used to gate the merge (don't ship on red or
 *  pending CI). Best-effort: null when it can't be determined, which does NOT
 *  block the merge — only a definite failing/pending does. */
export async function fetchPrChecksStatus(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<ChecksSummary> {
  const client = await clientFor(ctx, orgId, pr);
  if (!client) return null;
  const detail = await cachedRead<ChangeRequestDetail | null>(
    readNamespace(pr),
    `detail:${pr.number}`,
    prLabel(pr),
    () => client.readDetailed({ number: pr.number }),
  );
  return detail?.checks ?? null;
}

/** Whether the change request conflicts with its base branch — the definite
 *  "can't merge" signal used to gate conflict auto-resolution. Best-effort
 *  (null on any failure). */
export async function fetchPrConflict(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<boolean | null> {
  const cr = await readChangeRequest(ctx, orgId, pr, "conflict");
  return cr?.conflicting ?? null;
}

/** Just "is this merged?", for the archive sweep. */
export async function fetchPrLanding(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<{ state: "open" | "closed" | null; merged: boolean | null }> {
  const cr = await readChangeRequest(ctx, orgId, pr, "landing");
  if (!cr) return { state: null, merged: null };
  return cardLifecycle(cr.state);
}

/**
 * Exactly what {@link prReadyForReview} reads, and nothing else.
 *
 * The review sweep used to call the detailed read here — four provider calls
 * per change request plus one per failing check — for two booleans. It paid
 * that since before the check gate was dropped from the dispatch decision, and
 * a red one parked In Review is swept forever, so it paid the per-failure
 * reports on every pass in perpetuity.
 */
export async function fetchPrCandidateState(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<{
  state: "open" | "closed" | null;
  merged: boolean | null;
  checksStatus: ChecksSummary;
  conflict: boolean | null;
}> {
  const cr = await readChangeRequest(ctx, orgId, pr, "candidate");
  if (!cr) {
    return { state: null, merged: null, checksStatus: null, conflict: null };
  }
  return {
    ...cardLifecycle(cr.state),
    // Both ride the same read — the sweep's CI and conflict signals cost nothing extra.
    checksStatus: cr.checks,
    conflict: cr.conflicting,
  };
}

/**
 * The head branch name, or null when the provider can't be reached.
 *
 * Read live rather than stored on the row deliberately: `task_board_item_prs`
 * is written from three places (the provider tool hook, a bash-output scan,
 * and the sweeper's closing-message scan) and only one of them ever knows the
 * branch. The provider always does. Null is a first-class answer — the caller
 * falls back to today's fresh-branch behaviour rather than guessing a ref and
 * pushing work somewhere nobody is looking.
 */
export async function fetchPrHeadRef(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<string | null> {
  const cr = await readChangeRequest(ctx, orgId, pr, "head ref");
  /**
   * Only an OPEN change request's branch is worth reusing: pushing to a merged
   * or closed one's branch updates nothing anyone will look at, and the
   * re-run's work would be invisible.
   */
  if (!cr || cr.state !== "open") return null;
  return cr.head.length > 0 ? cr.head : null;
}

/**
 * Is there a change request to dispatch a reviewer at? One we positively know
 * is closed or merged is done with; anything else — open, or unknown because
 * the provider was quiet — is a candidate.
 *
 * Check status does NOT gate this: the reviewer runs WITHOUT waiting for CI.
 * It reads the diff and exercises the deploy preview, so we start it as soon
 * as there is something to review rather than sitting on a slow or stuck
 * check. Shipping stays safe — the MERGE is gated on green checks separately
 * (`mergeLinkedPr` → `fetchPrChecksStatus`), so nothing merges on red no
 * matter what a reviewer decided.
 *
 * The live read is best-effort: every field comes back `null` when the
 * provider call fails, which must read as "we could not ask", not "nothing
 * there" — a version that required `state === "open"` answered "not ready" for
 * EVERY card the moment GitHub went quiet and silently froze dispatch. Shared
 * with `review-sweeper.ts` so both dispatch paths agree.
 */
export const prReadyForReview = (
  prs: {
    state: string | null;
    merged: boolean | null;
  }[],
): boolean => reviewCandidates(prs).length > 0;

/** The change requests a reviewer would be dispatched at: one is a candidate
 *  unless we positively know it's finished with. One definition, so the
 *  readiness gate and the preview-freshness gate below can't disagree about
 *  which one is in play. */
const reviewCandidates = <
  T extends { state: string | null; merged: boolean | null },
>(
  prs: T[],
): T[] => prs.filter((p) => p.state !== "closed" && p.merged !== true);

/**
 * Does the deploy preview show the head commit? Pure — unit-tested.
 *
 * Only a definite `failing`/`pending` holds QA back. Everything else — no CI
 * configured, the provider unreadable, or a field a mid-deploy DBOS replay
 * recorded before it existed — is trusted, the same way every other read here
 * treats "we could not ask" as "do not block".
 *
 * It matters because a preview URL outlives the build that produced it. The
 * URL is lifted from a CI run or the deploy bot's comment, and the hostname is
 * per-change-request (`pr336-<site>.workers.dev`), not per-commit — so when a
 * deploy fails, that URL keeps serving the last build that SUCCEEDED, with a
 * cheerful 200. QA then exercises code the author didn't write, finds the
 * behaviour absent, and requests changes. The verdict looks exactly like a
 * real one, and the Super Agent cannot fix it by changing the code.
 *
 * That is not hypothetical: a site's Workers build broke account-wide for
 * everything after 16:30 one afternoon, and six cards were on course to spend
 * a second five-bounce budget being rejected against the previous night's
 * bytes.
 *
 * Checks are the signal because both providers attach them to a COMMIT: head's
 * deploy being green is what makes the preview head's.
 */
export function previewMatchesHead(
  prs: {
    state: string | null;
    merged: boolean | null;
    checksStatus: ChecksSummary;
  }[],
): boolean {
  return reviewCandidates(prs).every(
    (p) => p.checksStatus !== "failing" && p.checksStatus !== "pending",
  );
}

/**
 * Index of the change request the automation should act on, given each linked
 * one's live state in `listPrs` order (newest first): the newest not
 * definitively closed, falling back to the newest.
 *
 * `null` (the provider unreadable) counts as usable — a blip must not silently
 * redirect a merge to an older one. `states` may be shorter than the list,
 * since {@link pickActivePr} stops reading at the first usable one.
 */
export function pickActivePrIndex(
  states: readonly ("open" | "closed" | null)[],
): number {
  const i = states.findIndex((state) => state !== "closed");
  // Every one read closed — the newest is still the best guess, and the merged
  // ones are handled by the reconcile-to-Done path.
  return i === -1 ? 0 : i;
}

/**
 * Which of a task's linked change requests the automation should act on.
 *
 * `listPrs` is newest-first, and taking `[0]` blindly is wrong once a task has
 * more than one — a bounce that opens a fresh one instead of pushing to the
 * reviewed one leaves the newest link pointing at an abandoned branch, so the
 * merge gate reads ITS red checks and reports `checks_failing` forever while
 * the approved, green one sits unmerged.
 *
 * `ctx` is unused here on purpose — kept so callers don't need a special case
 * — the read goes through `readPrStateThrottled`, the same rate-limited DBOS
 * queue the review sweep's own candidate pass uses. This runs on every merge
 * attempt and every review decision, not just the sweep's own timer tick, so
 * calling `fetchPrCandidateState` straight at the provider here would reopen
 * the exact unbounded-reads problem the queue exists to cap.
 */
export async function pickActivePr(
  _ctx: StudioContext,
  orgId: string,
  prs: TaskBoardItemPrRef[],
): Promise<TaskBoardItemPrRef | undefined> {
  if (prs.length <= 1) return prs[0];
  const states: ("open" | "closed" | null)[] = [];
  for (const pr of prs) {
    const { state } = await readPrStateThrottled(orgId, pr);
    states.push(state);
    /**
     * Stop at the first usable one: the common case is one extra read, not one
     * per link, which is what a provider's rate limit cares about.
     */
    if (state !== "closed") break;
  }
  return prs[pickActivePrIndex(states)];
}

export const TASK_BOARD_ITEM_PRS_GET = defineTool({
  name: "TASK_BOARD_ITEM_PRS_GET",
  description:
    "Get the change requests (GitHub pull requests, GitLab merge requests) " +
    "linked to a task board item, each enriched with live state (title, " +
    "open/closed, draft, merged) fetched from its provider.",
  annotations: {
    title: "Get Task Board Item Pull Requests",
    // Not read-only: as a side effect it moves a task to Done when it observes a
    // merge (see the reconcile below). Idempotent — converges to Done.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    // Reaches out to the provider for live state.
    openWorldHint: true,
  },
  inputSchema: z.object({ taskBoardItemId: z.string() }),
  outputSchema: z.object({ prs: z.array(TaskBoardItemPrSchema) }),
  handler: async ({ taskBoardItemId }, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error(
        "Organization ID required (no active organization in context)",
      );
    }
    const item = await ctx.storage.taskBoard.getById(
      taskBoardItemId,
      organizationId,
    );

    const linked = await ctx.storage.taskBoard.listPrs(
      taskBoardItemId,
      organizationId,
    );
    // One provider round-trip per linked change request, in parallel, each best-effort.
    const assemble = () =>
      Promise.all(
        linked.map(async (pr) => {
          const live = await fetchPrLiveState(ctx, organizationId, pr);
          return {
            url: pr.url,
            number: pr.number,
            repoOwner: pr.repoOwner,
            repoName: pr.repoName,
            createdAt: pr.createdAt,
            ...live,
          };
        }),
      );

    /**
     * Serve the assembled card, not the reads it was built from. And on a cold
     * card it does NOT block: the database already holds the repo, the number
     * and the link, so that goes back immediately and the provider's half
     * (title, checks, preview) lands in KV for the next poll. Waiting on the
     * provider for what we already have was the ~2s.
     */
    const { value: prs, live } = await getPrCardCache().fetchOrPlaceholder({
      namespace: organizationId,
      key: taskBoardItemId,
      fetchLive: assemble,
      placeholder: linked.map((pr) => ({
        url: pr.url,
        number: pr.number,
        repoOwner: pr.repoOwner,
        repoName: pr.repoName,
        createdAt: pr.createdAt,
        ...NO_LIVE_STATE,
      })),
    });

    /**
     * Everything below reconciles the TASK from what the provider said. On the
     * placeholder we have not asked yet, and all-null does not mean "open,
     * unmerged, no checks" — it means "unknown". Acting on it would hand a
     * card to the reviewer, or move it to Done, on the strength of a database
     * row. The next poll (seconds away) runs them on the real thing.
     */
    if (!live) return { prs };

    /**
     * Auto-hand-off to the reviewer: once the Super Agent's change request is
     * In Review and its checks are green — OR it has none at all — delegate to
     * the reviewer, if the org has it turned on. Only a pending or failing run
     * blocks the hand-off. Like the merge→done reconcile below this is
     * reconcile-on-view (no provider webhook), driven by the modal's 10s poll.
     * Gated on assignee === Super Agent so it never fires for a human's manual
     * review; `enqueueEnabledReviewers` is itself idempotent per reviewer per
     * review cycle, so re-polling won't spawn duplicate reviewer runs.
     */
    const reviewLane = LANES.review;
    const openPr = prs.find((p) => p.state === "open" && !p.merged);
    if (
      item &&
      inReviewPhase(item) &&
      item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
      prReadyForReview(prs)
    ) {
      await enqueueEnabledReviewers(ctx, item, {
        previewMatchesHead: previewMatchesHead(prs),
      }).catch((err) => {
        console.error("[task-board] reviewer auto-handoff failed", err);
      });
    }

    /**
     * Auto-resolve a merge conflict on an approved change request: once every
     * enabled reviewer approved but it can't merge because it conflicts with
     * its base branch, hand it back to the Super Agent to resolve (gated on
     * the org's `auto_merge` flag, checked inside the reaction). This is the
     * poll-driven safety net — a conflict often appears AFTER approval (the
     * base branch moved on), which the merge attempt at approval time can't
     * see. Only an explicit conflict triggers; null/unknown never does. The
     * reaction is idempotent (it bounces the task to In Progress, so the next
     * poll skips).
     */
    if (
      item &&
      item.status === reviewLane &&
      item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
      openPr &&
      openPr.mergeable === false
    ) {
      /**
       * Act on the one the conflict was detected on (`openPr`), not a
       * re-derived "newest" — a task can have more than one linked.
       */
      await reactToApprovedPrConflict(ctx, organizationId, item, {
        pr: { number: openPr.number, url: openPr.url },
        conflict: true,
      }).catch((err) => {
        console.error("[task-board] conflict auto-resolve failed", err);
      });
    }

    /**
     * ponytail: reconcile-on-view — there's no provider webhook, so a merged
     * change request only advances the card when someone opens this modal.
     * Upgrade path: a `pull_request`/`merge_request` webhook calling the same
     * forward move. Best-effort; a failure must never break the read.
     * Forward-only via `movesForward`.
     */
    if (cardWorkLanded(prs)) {
      try {
        // Inside the try: this block is best-effort and must not fail the read.
        const settings =
          await ctx.storage.organizationSettings.get(organizationId);
        const shipped = shippedLane(settings?.flags);
        if (
          item &&
          movesForward(item.status, shipped) &&
          !(await ctx.storage.taskBoard.hasHumanRejectedDone(
            taskBoardItemId,
            organizationId,
          ))
        ) {
          const updated = await ctx.storage.taskBoard.update(
            taskBoardItemId,
            organizationId,
            { status: shipped },
            item.updatedBy,
          );
          // Every other path that moves a card to Done (the review-decision
          // auto-merge, "Ship to production") logs a `status_changed` timeline
          // entry — this reconcile silently skipped it, so a task auto-completed
          // by a human merging directly on the provider left no trace of the
          // move in the Activity feed.
          await recordTaskActivity(ctx, {
            taskBoardItemId,
            action: "status_changed",
            actorId: null,
            data: { from: item.status, to: shipped },
          });
          emitTaskBoardUpdated(organizationId, updated);
        }
      } catch (err) {
        console.error("[task-board] merged-PR reconcile failed", err);
      }
    }

    return { prs };
  },
});
