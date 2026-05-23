/**
 * Suggested Actions
 *
 * `GET /api/:org/suggested-actions?limit=5&mine=true|false`
 *
 * Returns the last N threads where the most recent message is from the
 * assistant — i.e. conversations the AI left hanging that the user might
 * want to pick back up. Rendered as the "new" cards on the Tasks panel.
 *
 * Authorization is implicit: `resolveOrgFromPath` already verified the
 * principal is a member of the resolved org. Scope is either the current
 * user's threads (`mine=true`, matches the panel's default member filter)
 * or the whole org.
 */

import { Hono } from "hono";
import type { MeshContext } from "@/core/mesh-context";
import {
  findStudioPackAgentByMcpId,
  resolveStudioPackTaskDescription,
} from "@/tools/virtual/studio-pack";

type Variables = {
  meshContext: MeshContext;
};

const DEFAULT_LIMIT = 5;
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

    // Over-fetch then keep one card per agent (most recent first, since the
    // storage layer already orders by last-message created_at DESC). Threads
    // without a virtual_mcp_id (ephemeral / no-agent conversations) stay
    // unique per thread.
    const rawRows = await mesh.storage.threads.listWithAssistantLastMessage({
      limit: limit * 5,
      createdBy: mine ? userId : undefined,
    });
    const seenAgents = new Set<string>();
    const rows: typeof rawRows = [];
    for (const r of rawRows) {
      const key = r.thread.virtual_mcp_id || `__t:${r.thread.id}`;
      if (seenAgents.has(key)) continue;
      seenAgents.add(key);
      rows.push(r);
      if (rows.length >= limit) break;
    }

    const agentIds = Array.from(
      new Set(rows.map((r) => r.thread.virtual_mcp_id).filter(Boolean)),
    ) as string[];
    const agentEntries = await Promise.all(
      agentIds.map(async (id) => {
        const agent = await mesh.storage.virtualMcps.findById(id, orgId);
        // findById does not filter DB rows by organization_id (only the
        // well-known synthetic agents respect the param). Drop any agent
        // whose org doesn't match so cross-org metadata can't leak.
        if (agent && agent.organization_id !== orgId) {
          return [id, null] as const;
        }
        return [id, agent] as const;
      }),
    );
    const agentById = new Map(agentEntries);

    const suggestions = await Promise.all(
      rows.map(async ({ thread, lastMessage }) => {
        const agent = thread.virtual_mcp_id
          ? agentById.get(thread.virtual_mcp_id)
          : null;

        const studioPackAgent = agent
          ? findStudioPackAgentByMcpId(agent.id)
          : null;

        const fromState = describeFromThreadState(lastMessage.parts);
        let description = "";
        if (fromState) {
          description = fromState;
        } else if (studioPackAgent && agent) {
          description =
            (await resolveStudioPackTaskDescription(studioPackAgent, {
              orgId,
              ctx: mesh,
            })) ?? `Reply to ${agent.title}`;
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
          description,
          excerpt: extractExcerpt(lastMessage.parts),
          last_message_at: lastMessage.created_at,
        };
      }),
    );

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
