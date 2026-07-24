import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { requireAuth } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import type { ConnectionEntity } from "@/tools/connection/schema";
import { clientFromConnection } from "@/mcp-clients";
import type { TaskBoardItemPrRef } from "@/storage/types";
import { TaskBoardItemPrSchema } from "./schema";
import { emitTaskBoardUpdated } from "./run-reactions";

/** Cap a single live PR fetch — the modal shouldn't hang on a slow GitHub. */
const PR_FETCH_TIMEOUT_MS = 8000;

/**
 * The GitHub MCP connection to fetch a PR through: the one that opened it when
 * known (MCP path), else the org's shared `mcp-github` connection (bash path,
 * where no connection was recorded).
 */
async function resolveGithubConnection(
  ctx: StudioContext,
  orgId: string,
  connectionId: string | null,
): Promise<ConnectionEntity | null> {
  if (connectionId) {
    const conn = await ctx.storage.connections.findById(connectionId);
    if (conn && conn.status === "active") return conn;
  }
  const { items } = await ctx.storage.connections.list(orgId, {
    slug: "mcp-github",
  });
  return items.find((c) => c.status === "active") ?? null;
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

type PrLiveState = {
  title: string | null;
  body: string | null;
  state: "open" | "closed" | null;
  draft: boolean | null;
  merged: boolean | null;
};

const NO_LIVE_STATE: PrLiveState = {
  title: null,
  body: null,
  state: null,
  draft: null,
  merged: null,
};

/** Fetch a PR's live state via the GitHub MCP `pull_request_read` tool.
 *  Best-effort: any failure yields nulls so the modal still shows the link. */
async function fetchPrLiveState(
  ctx: StudioContext,
  orgId: string,
  pr: TaskBoardItemPrRef,
): Promise<PrLiveState> {
  const conn = await resolveGithubConnection(ctx, orgId, pr.connectionId);
  if (!conn) return NO_LIVE_STATE;
  const client = await clientFromConnection(conn, ctx, true);
  try {
    const result = await client.callTool(
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
    );
    const obj = toolResultJson(result);
    if (!obj) return NO_LIVE_STATE;
    const rawState = obj.state;
    return {
      title: typeof obj.title === "string" ? obj.title : null,
      body: typeof obj.body === "string" ? obj.body : null,
      state:
        rawState === "closed" ? "closed" : rawState === "open" ? "open" : null,
      draft: typeof obj.draft === "boolean" ? obj.draft : null,
      merged: typeof obj.merged === "boolean" ? obj.merged : null,
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

    // ponytail: reconcile-on-view — there's no GitHub PR webhook, so a merged PR
    // only advances the card to Done when someone opens this modal. Upgrade path:
    // a `pull_request` webhook calling the same forward move. Best-effort; a
    // failure must never break the read. Forward-only (never un-does Done).
    if (prs.some((p) => p.merged)) {
      try {
        const item = await ctx.storage.taskBoard.getById(
          taskBoardItemId,
          organizationId,
        );
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
