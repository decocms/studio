import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { clientFromConnection } from "@/mcp-clients";
import type { TaskBoardItemPrRef } from "@/storage/types";
import { getRepoScope } from "@decocms/shared/github-repo-scope";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { TaskBoardItemPrSchema } from "./schema";
import { emitTaskBoardUpdated } from "./run-reactions";
import { enqueueEnabledReviewers } from "./enqueue-reviewer";
import { reactToApprovedPrConflict } from "./conflict-reaction";
import { extractPrFromText } from "./pr-extract";

/** Cap a single live PR fetch — the modal shouldn't hang on a slow GitHub. */
const PR_FETCH_TIMEOUT_MS = 8000;

/**
 * The GitHub MCP connection to fetch/merge a PR through: the one that opened it
 * when known (MCP path), else pick from the org's `mcp-github` connections
 * (bash path, where no connection was recorded).
 *
 * The pick matters once an org has repo-scoped connections (imported repos /
 * Code Agents): a repo-scoped child's installation only reaches ITS repo, so
 * using it for a different repo's PR fails (empty live state → the card loses
 * its open/checks/preview and the ship button). So prefer, in order: a
 * repo-scoped connection matching THIS PR's repo (guaranteed access), then the
 * broad org-level connection (no `repoScope`, user OAuth over every repo), then
 * any active one.
 */
export async function resolveGithubConnection(
  ctx: StudioContext,
  orgId: string,
  connectionId: string | null,
  repo?: { owner: string; name: string },
): Promise<ConnectionEntity | null> {
  if (connectionId) {
    // Org-scope the lookup: this connection's GitHub installation is used to
    // MERGE PRs, so never resolve one from another org (defense-in-depth against
    // a foreign/colliding connectionId reaching a write path).
    const conn = await ctx.storage.connections.findById(connectionId, orgId);
    if (conn && conn.status === "active") return conn;
  }
  const { items } = await ctx.storage.connections.list(orgId, {
    slug: "mcp-github",
  });
  const active = items.filter((c) => c.status === "active");
  if (repo) {
    const matching = active.find((c) => {
      const scope = getRepoScope(c);
      return scope?.owner === repo.owner && scope?.repo === repo.name;
    });
    if (matching) return matching;
  }
  return active.find((c) => getRepoScope(c) === null) ?? active[0] ?? null;
}

/** Normalize a CallToolResult to its JSON object (structuredContent, else the
 *  text content parsed as JSON). Null on error/empty — inlined so a tool never
 *  imports web helpers. */
function toolResultJson(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== "object") return null;
  const r = result as {
    isError?: boolean;
    structuredContent?: unknown;
    content?: Array<{ type?: string; text?: string }>;
  };
  if (r.isError) return null;
  if (
    r.structuredContent &&
    typeof r.structuredContent === "object" &&
    Object.keys(r.structuredContent).length > 0
  ) {
    return r.structuredContent as Record<string, unknown>;
  }
  const text = r.content?.find((c) => c.type === "text")?.text;
  if (!text) return null;
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export type ChecksStatus = "pending" | "passing" | "failing" | null;

/** One CI check on the PR, for the card's expandable checks footer. `summary`
 *  is the check-run's output markdown, fetched only for FAILING runs (the ones
 *  worth reading) via `GET_CHECK_RUN`; null otherwise. */
export type PrCheck = {
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
  summary: string | null;
};

type PrLiveState = {
  title: string | null;
  body: string | null;
  state: "open" | "closed" | null;
  draft: boolean | null;
  merged: boolean | null;
  /** GitHub's `mergeable`: false = conflicts with base, true = clean, null =
   *  not computed yet / unknown. */
  mergeable: boolean | null;
  checksStatus: ChecksStatus;
  checks: PrCheck[];
  previewUrl: string | null;
};

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

/** Whether `url`'s HOST is a deco.cx preview host — a strict hostname check,
 *  NOT a substring match. The preview is lifted from PR comments, which
 *  external contributors can write, and the result is shown as a trusted
 *  "Open preview" button AND handed to the autonomous QA reviewer to navigate.
 *  So a decoy like `https://evil.example.com/x?y=.decocdn.com` must be rejected.
 *  Exported for the unit test. */
export function isDecoPreviewHost(url: string): boolean {
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
    hostname.endsWith(".deco.site")
  );
}

/** Pull the deco preview URL out of a combined-status response's `statuses[]`
 *  (a status whose `target_url` is a deco preview host). Kept as a cheap
 *  fallback — deco posts the preview in a comment, not a status, so this
 *  usually finds nothing. `null` when none is posted. */
export function extractPreviewUrl(
  obj: Record<string, unknown> | null,
): string | null {
  if (!obj || !Array.isArray(obj.statuses)) return null;
  const previews = obj.statuses
    .map((s) =>
      s && typeof s === "object"
        ? (s as { target_url?: unknown; state?: unknown })
        : null,
    )
    .filter(
      (s): s is { target_url: string; state?: unknown } =>
        !!s &&
        typeof s.target_url === "string" &&
        isDecoPreviewHost(s.target_url),
    );
  if (previews.length === 0) return null;
  return (
    previews.find((s) => s.state === "success")?.target_url ??
    previews[0]!.target_url
  );
}

/**
 * Pull the deco preview URL out of a PR's comments — where the deploy bot
 * actually posts it. Two shapes: Cloudflare Workers'
 * `cloudflare-workers-and-pages[bot]` (a table with a "Commit Preview URL" AND a
 * "Branch Preview URL" — prefer the branch one, stable across the PR's commits),
 * and deco.cx's `decobot` (a single "Visit Preview" markdown link). Accepts the
 * raw `get_comments` result (an array, or `{ comments }`/`{ items }`) and scans
 * each body. `null` when none is found. Exported for the pure-logic unit test.
 */
export function extractPreviewUrlFromComments(raw: unknown): string | null {
  const list = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { comments?: unknown })?.comments)
      ? (raw as { comments: unknown[] }).comments
      : Array.isArray((raw as { items?: unknown })?.items)
        ? (raw as { items: unknown[] }).items
        : [];
  for (const c of list) {
    const body =
      c && typeof (c as { body?: unknown }).body === "string"
        ? (c as { body: string }).body
        : "";
    if (!body) continue;
    // Cloudflare's comment carries both a per-commit and a per-branch preview —
    // prefer the branch URL, which stays valid as the PR gets new commits.
    const branch = body.match(/href=['"]([^'"]+)['"][^>]*>\s*Branch Preview/i);
    if (branch?.[1] && isDecoPreviewHost(branch[1])) return branch[1];
    const url = (body.match(/https?:\/\/[^\s"'<>)\]]+/g) ?? []).find((u) =>
      isDecoPreviewHost(u),
    );
    if (url) return url;
  }
  return null;
}

/** Map a GitHub combined-status `state` to our three-value checks summary.
 *  A response with no statuses (`total_count === 0`) reads as "no checks",
 *  not "pending" — a PR without CI shouldn't look stuck. Exported for the
 *  pure-logic unit test. */
export function toChecksStatus(
  obj: Record<string, unknown> | null,
): ChecksStatus {
  if (!obj) return null;
  const total = typeof obj.total_count === "number" ? obj.total_count : null;
  if (total === 0) return null;
  switch (obj.state) {
    case "success":
      return "passing";
    case "failure":
    case "error":
      return "failing";
    case "pending":
      return "pending";
    default:
      return null;
  }
}

/** Check-run conclusions that mean the run failed. */
const FAILED_CHECK_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
  "stale",
]);

/** Map GitHub check-runs (Checks API) to our three-value summary. Repos on
 *  GitHub Actions post check-runs, NOT legacy commit statuses (which
 *  `toChecksStatus` reads), so this is often the only signal — e.g. a deco site
 *  whose combined status is empty but whose "Deco / QA" check-run failed.
 *  Accepts the raw `get_check_runs` result (`{ check_runs }` or an array).
 *  `null` when there are no check-runs. Exported for the unit test. */
export function toCheckRunsStatus(raw: unknown): ChecksStatus {
  const runs = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { check_runs?: unknown })?.check_runs)
      ? (raw as { check_runs: unknown[] }).check_runs
      : [];
  if (runs.length === 0) return null;
  let failing = false;
  let pending = false;
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const status = (r as { status?: unknown }).status;
    const conclusion = (r as { conclusion?: unknown }).conclusion;
    if (status !== "completed") {
      pending = true;
    } else if (
      typeof conclusion === "string" &&
      FAILED_CHECK_CONCLUSIONS.has(conclusion)
    ) {
      failing = true;
    }
  }
  if (failing) return "failing";
  if (pending) return "pending";
  return "passing";
}

/** Combine two checks summaries, worst-first: failing > pending > passing >
 *  null. A PR's CI can live in BOTH the legacy Status API and the Checks API
 *  (e.g. a Cloudflare deploy status + a GitHub Actions check-run), so we read
 *  both and merge. Exported for the unit test. */
export function mergeChecksStatus(
  a: ChecksStatus,
  b: ChecksStatus,
): ChecksStatus {
  if (a === "failing" || b === "failing") return "failing";
  if (a === "pending" || b === "pending") return "pending";
  if (a === "passing" || b === "passing") return "passing";
  return null;
}

type RawCheckRun = {
  id: number | null;
  name: string;
  status: string;
  conclusion: string | null;
  detailsUrl: string | null;
};

/** Parse a `get_check_runs` result into a flat list. Exported for the test. */
export function parseCheckRuns(raw: unknown): RawCheckRun[] {
  const runs = Array.isArray(raw)
    ? raw
    : Array.isArray((raw as { check_runs?: unknown })?.check_runs)
      ? (raw as { check_runs: unknown[] }).check_runs
      : [];
  const out: RawCheckRun[] = [];
  for (const r of runs) {
    if (!r || typeof r !== "object") continue;
    const o = r as Record<string, unknown>;
    out.push({
      id: typeof o.id === "number" ? o.id : null,
      name: typeof o.name === "string" ? o.name : "",
      status: typeof o.status === "string" ? o.status : "completed",
      conclusion: typeof o.conclusion === "string" ? o.conclusion : null,
      detailsUrl:
        typeof o.html_url === "string"
          ? o.html_url
          : typeof o.details_url === "string"
            ? o.details_url
            : null,
    });
  }
  return out;
}

/** True when a check-run finished in a failing state. */
function isFailingRun(r: RawCheckRun): boolean {
  return (
    r.status === "completed" &&
    r.conclusion != null &&
    FAILED_CHECK_CONCLUSIONS.has(r.conclusion)
  );
}

/** Fetch a check-run's output markdown via the github MCP `GET_CHECK_RUN` tool
 *  (the list tool omits `output`). Best-effort: null on any failure. */
async function fetchCheckRunSummary(
  client: Awaited<ReturnType<typeof clientFromConnection>>,
  pr: TaskBoardItemPrRef,
  checkRunId: number,
): Promise<string | null> {
  try {
    const obj = toolResultJson(
      await client.callTool(
        {
          name: "GET_CHECK_RUN",
          arguments: {
            owner: pr.repoOwner,
            repo: pr.repoName,
            checkRunId,
          },
        },
        undefined,
        { timeout: PR_FETCH_TIMEOUT_MS },
      ),
    );
    const output = obj?.output as
      | { summary?: unknown; text?: unknown }
      | undefined;
    const summary = typeof output?.summary === "string" ? output.summary : null;
    const text = typeof output?.text === "string" ? output.text : null;
    return summary ?? text ?? null;
  } catch {
    return null;
  }
}

/** Just the PR's checks summary (combined status ∪ check-runs) — used to gate
 *  the merge (don't ship on red/pending CI). Best-effort: null when it can't be
 *  determined (which does NOT block the merge — only a definite failing/pending
 *  does). */
export async function fetchPrChecksStatus(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<ChecksStatus> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return null;
  const client = await clientFromConnection(conn, ctx, true);
  const read = async (method: "get_status" | "get_check_runs") =>
    toolResultJson(
      await client.callTool(
        {
          name: "pull_request_read",
          arguments: {
            method,
            owner: pr.repoOwner,
            repo: pr.repoName,
            pullNumber: pr.number,
          },
        },
        undefined,
        { timeout: PR_FETCH_TIMEOUT_MS },
      ),
    );
  try {
    let status: ChecksStatus = null;
    try {
      status = toChecksStatus(await read("get_status"));
    } catch {
      // best-effort
    }
    try {
      status = mergeChecksStatus(
        status,
        toCheckRunsStatus(await read("get_check_runs")),
      );
    } catch {
      // best-effort
    }
    return status;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Map a `pull_request_read get` response to whether the PR conflicts with its
 *  base branch. `true` = conflicts (`mergeable === false`); `false` = mergeable,
 *  OR the PR is not open (a merged/closed PR reports `mergeable: null` but is
 *  never "conflicting"); `null` = GitHub hasn't computed mergeability yet (it's
 *  async) or the read gave nothing — an unknown must NEVER read as a conflict,
 *  so the caller only acts on an explicit `true`. Pure — unit-tested; the single
 *  home for the `mergeable` polarity, so the two callers can't drift. */
export function conflictFromPrGet(
  obj: Record<string, unknown> | null,
): boolean | null {
  if (!obj) return null;
  if (obj.state !== "open") return false;
  return typeof obj.mergeable === "boolean" ? !obj.mergeable : null;
}

/** Whether the PR conflicts with its base branch — the definite "can't merge"
 *  signal used to gate conflict auto-resolution. Reads the same `get` the
 *  live-state fetch uses; best-effort (null on any failure). */
export async function fetchPrConflict(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<boolean | null> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return null;
  const client = await clientFromConnection(conn, ctx, true);
  try {
    return conflictFromPrGet(
      toolResultJson(
        await client.callTool(
          {
            name: "pull_request_read",
            arguments: {
              method: "get",
              owner: pr.repoOwner,
              repo: pr.repoName,
              pullNumber: pr.number,
            },
          },
          undefined,
          { timeout: PR_FETCH_TIMEOUT_MS },
        ),
      ),
    );
  } catch {
    return null;
  } finally {
    await client.close().catch(() => {});
  }
}

/** Fetch the PR's live CI + preview extras via the GitHub MCP
 *  `pull_request_read` tool: the combined Status API AND the Checks API (repos
 *  differ in which they post to), merged into one checks summary, plus the deco
 *  deploy preview URL. Best-effort: any failure yields nulls. */
async function fetchPrStatusExtras(
  client: Awaited<ReturnType<typeof clientFromConnection>>,
  pr: TaskBoardItemPrRef,
): Promise<{
  checksStatus: ChecksStatus;
  checks: PrCheck[];
  previewUrl: string | null;
}> {
  const read = async (
    method: "get_status" | "get_check_runs" | "get_comments",
  ): Promise<Record<string, unknown> | null> => {
    try {
      return toolResultJson(
        await client.callTool(
          {
            name: "pull_request_read",
            arguments: {
              method,
              owner: pr.repoOwner,
              repo: pr.repoName,
              pullNumber: pr.number,
            },
          },
          undefined,
          { timeout: PR_FETCH_TIMEOUT_MS },
        ),
      );
    } catch {
      return null;
    }
  };
  // The three reads are independent — run them CONCURRENTLY. Serial was the
  // slowness (each is a remote MCP → GitHub round-trip, ~1.5-2s; the card made
  // 4-5 of them in a row).
  const [statusObj, runsRaw, commentsRaw] = await Promise.all([
    read("get_status"),
    read("get_check_runs"),
    read("get_comments"),
  ]);
  // Combined Status API ∪ Checks API → one summary.
  const checksStatus = mergeChecksStatus(
    toChecksStatus(statusObj),
    toCheckRunsStatus(runsRaw),
  );
  // Preview: a status `target_url` (rare) else the deploy bot's PR comment.
  const previewUrl =
    extractPreviewUrl(statusObj) ?? extractPreviewUrlFromComments(commentsRaw);
  // Per-check list for the footer; pull the output markdown only for failing
  // runs (bounded, in parallel).
  const checks = await Promise.all(
    parseCheckRuns(runsRaw).map(
      async (r): Promise<PrCheck> => ({
        name: r.name,
        status: r.status,
        conclusion: r.conclusion,
        detailsUrl: r.detailsUrl,
        summary:
          isFailingRun(r) && r.id != null
            ? await fetchCheckRunSummary(client, pr, r.id)
            : null,
      }),
    ),
  );
  return { checksStatus, checks, previewUrl };
}

/** Fetch a PR's live state via the GitHub MCP `pull_request_read` tool.
 *  Best-effort: any failure yields nulls so the modal still shows the link. */
async function fetchPrLiveState(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<PrLiveState> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId, {
    owner: pr.repoOwner,
    name: pr.repoName,
  });
  if (!conn) return NO_LIVE_STATE;
  const client = await clientFromConnection(conn, ctx, true);
  try {
    // Fetch the PR's basic state AND its checks/preview extras CONCURRENTLY.
    // An open PR (the common case in the review dialog) is fully populated in a
    // single round-trip window instead of ~5 serial hops; a merged/closed PR
    // wastes the extras, but that's rare here and best-effort.
    const [liveResult, extras] = await Promise.all([
      client.callTool(
        {
          name: "pull_request_read",
          arguments: {
            method: "get",
            owner: pr.repoOwner,
            repo: pr.repoName,
            pullNumber: pr.number,
          },
        },
        undefined,
        { timeout: PR_FETCH_TIMEOUT_MS },
      ),
      fetchPrStatusExtras(client, pr),
    ]);
    const obj = toolResultJson(liveResult);
    if (!obj) return NO_LIVE_STATE;
    const rawState = obj.state;
    const isOpen = rawState === "open";
    return {
      title: typeof obj.title === "string" ? obj.title : null,
      body: typeof obj.body === "string" ? obj.body : null,
      state: rawState === "closed" ? "closed" : isOpen ? "open" : null,
      draft: typeof obj.draft === "boolean" ? obj.draft : null,
      merged: typeof obj.merged === "boolean" ? obj.merged : null,
      // Mergeability only means something for an open PR (a merged/closed PR
      // reports `mergeable: null`). Anything but a boolean is "unknown".
      mergeable:
        isOpen && typeof obj.mergeable === "boolean" ? obj.mergeable : null,
      // Checks/preview only mean something for an open PR.
      checksStatus: isOpen ? extras.checksStatus : null,
      checks: isOpen ? extras.checks : [],
      previewUrl: isOpen ? extras.previewUrl : null,
    };
  } catch {
    return NO_LIVE_STATE;
  } finally {
    await client.close().catch(() => {});
  }
}

export const TASK_BOARD_ITEM_PRS_GET = defineTool({
  name: "TASK_BOARD_ITEM_PRS_GET",
  description:
    "Get the GitHub pull requests linked to a task board item, each enriched " +
    "with live state (title, open/closed, draft, merged) fetched from GitHub.",
  annotations: {
    title: "Get Task Board Item Pull Requests",
    // Not read-only: as a side effect it moves a task to Done when it observes a
    // merged PR (see the reconcile below). Idempotent — converges to Done.
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    // Reaches out to GitHub for live PR state.
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

    // Recover a PR the create-PR hook missed (shell alias, script wrapper, or a
    // PR opened by any means the heuristic doesn't match) by scanning each
    // linked thread's latest assistant message — the agent's closing summary
    // reliably prints the URL ("Opened PR #309 https://github.com/…/pull/309").
    // linkPr is idempotent per (task, url), so re-linking an already-tracked PR
    // is a no-op. Best-effort; a failure must never break the read.
    // ponytail: scans only the latest assistant message per thread (that's what
    // getById already loads). Widen to more parts if a PR ever lands in an
    // earlier message that the closing summary doesn't repeat.
    for (const thread of item?.threads ?? []) {
      const pr = thread.lastMessage
        ? extractPrFromText(thread.lastMessage)
        : null;
      if (!pr) continue;
      try {
        await ctx.storage.taskBoard.linkPr({
          taskBoardItemId,
          organizationId,
          url: pr.url,
          prNumber: pr.number,
          repoOwner: pr.owner,
          repoName: pr.repo,
          connectionId: null,
        });
      } catch (err) {
        console.error("[task-board] PR recovery from thread text failed", err);
      }
    }

    const linked = await ctx.storage.taskBoard.listPrs(
      taskBoardItemId,
      organizationId,
    );
    // One GitHub round-trip per linked PR, in parallel, each best-effort.
    const prs = await Promise.all(
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

    // Auto-hand-off to the enabled reviewers: once the Super Agent's PR is In
    // Review and its checks are green — OR it has no checks at all — delegate to
    // each reviewer the org turned on (QA Agent / Code Reviewer). Only a pending
    // or failing run blocks the hand-off; a PR without CI (`checksStatus ===
    // null`) shouldn't sit in review forever. Like the merge→done reconcile
    // below this is reconcile-on-view (no PR webhook), driven by the modal's 10s
    // poll. Gated on assignee === Super Agent so it never fires for a human's
    // manual review; `enqueueEnabledReviewers` is itself idempotent per reviewer
    // per review cycle, so re-polling won't spawn duplicate reviewer runs.
    const openPr = prs.find((p) => p.state === "open" && !p.merged);
    const checksReadyForReview =
      openPr != null &&
      openPr.checksStatus !== "pending" &&
      openPr.checksStatus !== "failing";
    if (
      item &&
      item.status === "in_review" &&
      item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
      checksReadyForReview
    ) {
      await enqueueEnabledReviewers(ctx, item).catch((err) => {
        console.error("[task-board] reviewer auto-handoff failed", err);
      });
    }

    // Auto-resolve a merge conflict on an approved PR: once every enabled
    // reviewer approved but the PR can't merge because it conflicts with its
    // base branch, hand it back to the Super Agent to resolve (gated on the
    // org's `auto_merge` flag, checked inside the reaction). This is the
    // poll-driven safety net — a conflict often appears AFTER approval (the base
    // branch moved on), which the merge attempt at approval time can't see. Run
    // the same `conflictFromPrGet` mapping the review-decision path uses (only an
    // explicit conflict triggers; null/unknown never does). The reaction is
    // idempotent (it bounces the task to In Progress, so the next poll skips).
    const openPrConflict = openPr
      ? conflictFromPrGet({ state: openPr.state, mergeable: openPr.mergeable })
      : null;
    if (
      item &&
      item.status === "in_review" &&
      item.assigneeId === SUPER_AGENT_ASSIGNEE_ID &&
      openPr &&
      openPrConflict === true
    ) {
      // Act on the PR the conflict was detected on (`openPr`), not a re-derived
      // "newest" — a task can have more than one linked PR.
      await reactToApprovedPrConflict(ctx, organizationId, item, {
        pr: { number: openPr.number, url: openPr.url },
        conflict: true,
      }).catch((err) => {
        console.error("[task-board] conflict auto-resolve failed", err);
      });
    }

    // ponytail: reconcile-on-view — there's no GitHub PR webhook, so a merged PR
    // only advances the card to Done when someone opens this modal. Upgrade path:
    // a `pull_request` webhook calling the same forward move. Best-effort; a
    // failure must never break the read. Forward-only (never un-does Done).
    if (prs.some((p) => p.merged)) {
      try {
        if (item && item.status !== "done") {
          const updated = await ctx.storage.taskBoard.update(
            taskBoardItemId,
            organizationId,
            { status: "done" },
            item.updatedBy,
          );
          emitTaskBoardUpdated(organizationId, updated);
        }
      } catch (err) {
        console.error("[task-board] merge→done reconcile failed", err);
      }
    }

    return { prs };
  },
});
