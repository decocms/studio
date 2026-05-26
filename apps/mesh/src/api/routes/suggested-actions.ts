/**
 * Suggested Actions
 *
 * `GET /api/:org/suggested-actions?limit=8&mine=true|false`
 *
 * Returns up to N threads to render as cards on the Tasks panel. Primary
 * set is conversations the AI left hanging (assistant wrote last); when
 * fewer than N of those exist, the response is topped up with threads
 * where the user wrote last (in-flight conversations).
 *
 * Studio Pack agents are NOT surfaced here — their onboarding hints come
 * from `/api/:org/studio-pack-checklists`, which derives state from the
 * org rather than from a stale thread.
 *
 * Authorization is implicit: `resolveOrgFromPath` already verified the
 * principal is a member of the resolved org. Scope is either the current
 * user's threads (`mine=true`, matches the panel's default member filter)
 * or the whole org.
 */

import { Hono } from "hono";
import { isBrandContextSetup, isDecopilot } from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import { DEFAULT_THREAD_TITLE } from "@/api/routes/decopilot/constants";
import { STUDIO_PACK_AGENTS } from "@/tools/virtual/studio-pack";

type Variables = {
  meshContext: MeshContext;
};

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const EXCERPT_MAX_LENGTH = 200;

export function createSuggestedActionsRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/suggested-actions", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    const userId = mesh.auth.user?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);
    if (!userId) return c.json({ error: "Authentication required" }, 401);

    const limitParam = c.req.query("limit");
    const parsedLimit = limitParam ? Number(limitParam) : DEFAULT_LIMIT;
    const limit =
      Number.isFinite(parsedLimit) && parsedLimit > 0
        ? Math.min(Math.floor(parsedLimit), MAX_LIMIT)
        : DEFAULT_LIMIT;

    const mine = c.req.query("mine") !== "false";

    const studioPackAgentIds = STUDIO_PACK_AGENTS.map((a) => a.getId(orgId));
    const existingStudioPack = await mesh.storage.virtualMcps.listByIds(
      orgId,
      studioPackAgentIds,
    );
    const existingStudioPackIds = new Set(existingStudioPack.map((a) => a.id));
    const isHandledByChecklist = (virtualMcpId: string | null | undefined) =>
      !!virtualMcpId && existingStudioPackIds.has(virtualMcpId);

    // Over-fetch so we still hit `limit` real rows after dropping Studio
    // Pack threads (handled by the checklist endpoint). Storage layer
    // already orders by last-message created_at DESC.
    const assistantLast = await mesh.storage.threads.listWithLastMessage({
      limit: limit * 5,
      createdBy: mine ? userId : undefined,
      lastMessageRole: "assistant",
    });
    // Primary set: AI spoke last AND (not an automation run, OR the run is
    // blocked on the user). Automation runs (cron OR manual fire) only belong
    // here when blocked on the user — trigger_id alone misses manual fires
    // (they pass null), so we key off the title prefix written by both
    // createAutomationRunThread and createToolCallRunThread.
    const primary = assistantLast
      .filter((r) => !isHandledByChecklist(r.thread.virtual_mcp_id))
      .map((r) => ({
        ...r,
        fromState: describeFromThreadState(r.lastMessage.parts),
      }))
      .filter(
        (r) =>
          !r.thread.title?.startsWith("Automation: ") || r.fromState !== null,
      );

    // Fallback: when the primary set is short, top up with threads where the
    // user wrote last (in-flight conversations, not blocked on the user).
    let rows = primary;
    if (primary.length < limit) {
      const userLast = await mesh.storage.threads.listWithLastMessage({
        limit: (limit - primary.length) * 5,
        createdBy: mine ? userId : undefined,
        lastMessageRole: "user",
      });
      const fallback = userLast
        .filter((r) => !isHandledByChecklist(r.thread.virtual_mcp_id))
        .map((r) => ({ ...r, fromState: null as string | null }));
      rows = [...primary, ...fallback.slice(0, limit - primary.length)];
    }

    const agentIds = Array.from(
      new Set(rows.map((r) => r.thread.virtual_mcp_id).filter(Boolean)),
    ) as string[];
    // Synthetic well-known agents (Decopilot, Brand Context Setup) aren't
    // backed by a DB row — resolve them via findById, which short-circuits.
    // Real ids batch through `listByIds`, which filters by organization_id
    // at the DB level so cross-org rows silently drop out (no leak).
    const syntheticIds: string[] = [];
    const realIds: string[] = [];
    for (const id of agentIds) {
      if (isDecopilot(id) || isBrandContextSetup(id)) {
        syntheticIds.push(id);
      } else {
        realIds.push(id);
      }
    }
    const [realAgents, syntheticAgents] = await Promise.all([
      mesh.storage.virtualMcps.listByIds(orgId, realIds),
      Promise.all(
        syntheticIds.map((id) => mesh.storage.virtualMcps.findById(id, orgId)),
      ),
    ]);
    const agentById = new Map<string, (typeof realAgents)[number]>();
    for (const a of realAgents) agentById.set(a.id, a);
    syntheticAgents.forEach((a, i) => {
      const id = syntheticIds[i];
      if (a && id) agentById.set(id, a);
    });

    const suggestions = rows
      .slice(0, limit)
      .map(({ thread, lastMessage, fromState }) => {
        const agent = thread.virtual_mcp_id
          ? agentById.get(thread.virtual_mcp_id)
          : null;

        let description = fromState ?? "";

        if (!description) {
          const trimmedTitle = thread.title?.trim() ?? "";
          const hasRealTitle =
            trimmedTitle.length > 0 &&
            trimmedTitle !== DEFAULT_THREAD_TITLE &&
            trimmedTitle !== agent?.title;
          if (hasRealTitle) {
            description = trimmedTitle;
          } else {
            const taskDescription =
              agent && typeof agent.metadata === "object" && agent.metadata
                ? ((agent.metadata as { taskDescription?: unknown })
                    .taskDescription ?? null)
                : null;
            description =
              typeof taskDescription === "string" && taskDescription.length > 0
                ? taskDescription
                : agent
                  ? `Reply to ${agent.title}`
                  : "";
          }
        }

        return {
          thread: {
            id: thread.id,
            title: thread.title,
            virtual_mcp_id: thread.virtual_mcp_id || null,
            created_by: thread.created_by,
            created_at: thread.created_at,
            updated_at: thread.updated_at,
            trigger_id: thread.trigger_id,
          },
          agent: agent
            ? { id: agent.id, name: agent.title, icon: agent.icon }
            : null,
          icon: agent?.icon ?? null,
          description,
          excerpt: extractExcerpt(lastMessage.parts),
          last_message_at: lastMessage.created_at,
        };
      });

    // Short private cache absorbs rapid window-focus refetches. Thread
    // mutations invalidate the React Query key, so the user still sees
    // their own actions reflected immediately.
    c.header("Cache-Control", "private, max-age=10");
    return c.json({ suggestions });
  });

  return app;
}

function describeFromThreadState(parts: unknown): string | null {
  if (!Array.isArray(parts)) return null;
  for (const p of parts) {
    if (!p || typeof p !== "object") continue;
    const part = p as { type?: string; state?: string };
    if (part.state === "approval-requested") return "Approve pending action";
    if (part.type === "tool-user_ask" && part.state !== "output-available") {
      return "Reply with input";
    }
    if (
      part.type === "tool-propose_plan" &&
      part.state !== "output-available"
    ) {
      return "Review proposed plan";
    }
  }
  return null;
}

function extractExcerpt(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  const text = parts
    .filter(
      (p): p is { type: string; text?: string } =>
        typeof p === "object" &&
        p !== null &&
        (p as { type?: unknown }).type === "text",
    )
    .map((p) => (typeof p.text === "string" ? p.text : ""))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length <= EXCERPT_MAX_LENGTH) return text;
  return `${text.slice(0, EXCERPT_MAX_LENGTH - 1).trimEnd()}…`;
}
