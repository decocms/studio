/**
 * Home Next-Actions
 *
 * `GET /api/:org/home-next-actions`
 *
 * Returns the still-pending next actions for the `/$org` home page:
 * - `prompts`: onboarding/icebreaker prompts from the Studio Pack agents and
 *   the org's configured default home agents. Each opens a new thread with the
 *   named agent and autosends the resolved MCP prompt as the first message.
 * - `threads`: the caller's threads in `requires_action` status (an agent
 *   asked a question or a tool needs approval). Each reopens that thread.
 *
 * Server-side filtering keeps the row pared down as the user makes progress.
 */

import { Hono } from "hono";
import { slugify } from "@decocms/mcp-utils/aggregate";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "@/core/mesh-context";
import { createVirtualClientFrom } from "@/mcp-clients/virtual-mcp";
import { getPrompts } from "@/tools/guides";
import {
  STUDIO_PACK_AGENTS,
  resolveStudioPackChecklist,
} from "@/tools/virtual/studio-pack";

/** Per default-home agent, cap prompts so a chatty agent can't flood the row. */
const MAX_PROMPTS_PER_AGENT = 10;
/** Bound a slow/unreachable agent so it can't hang the home request. */
const LIST_PROMPTS_TIMEOUT_MS = 5000;

type Variables = {
  meshContext: MeshContext;
};
interface PromptEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  /**
   * Gateway-namespaced prompt name — matches what `prompts/list` returns for
   * this agent's MCP client so the resulting mention chip's id lines up with
   * the slash-command flow (enables click-to-edit on the chip). Empty string
   * marks an agent-only fallback card (no prompt to autosend — click just
   * opens a fresh thread with the agent).
   */
  promptName: string;
  title: string;
  description: string;
  hasArguments: boolean;
  arguments?: Prompt["arguments"];
  _meta?: Prompt["_meta"];
}

/**
 * Tile UI for a home agent. Rendered as an MCP UI iframe inside the agent's
 * tile on `/$org`. The frontend opens an MCP client to `connectionId` (the
 * connection that owns the resource, not the virtual MCP gateway) so the
 * iframe can call tools by their bare names.
 */
interface TileEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  connectionId: string;
  resourceUri: string;
  minHeight?: number;
  maxHeight?: number;
}

function indexPromptsByName() {
  const all = getPrompts();
  const byName = new Map<string, (typeof all)[number]>();
  for (const p of all) byName.set(p.name, p);
  return byName;
}

/**
 * Prompts + tile UIs from the org's configured default home agents (custom
 * virtual MCPs). Prompts are listed live from each agent's gateway; tile UIs
 * come from `metadata.ui.homeTile` on the virtual MCP and are surfaced as a
 * separate `tiles` array so the frontend can render iframes independently of
 * the prompt row. Studio Pack agent ids are skipped (prompts surfaced via the
 * static path; Studio Pack agents don't declare tile UIs today). Agents with
 * no prompts (or an unreachable gateway) still get one fallback card so every
 * configured default home agent shows up on the home row.
 */
async function defaultHomeAgentNextActions(
  orgId: string,
  ctx: MeshContext,
  skipAgentIds: Set<string>,
): Promise<{ prompts: PromptEntry[]; tiles: TileEntry[] }> {
  const settings = await ctx.storage.organizationSettings.get(orgId);
  const ids = settings?.default_home_agents?.ids ?? [];
  const uniqueIds = [...new Set(ids)].filter((id) => !skipAgentIds.has(id));

  const perId = await Promise.all(
    uniqueIds.map(
      async (
        id,
      ): Promise<{ prompts: PromptEntry[]; tile: TileEntry | null }> => {
        const virtualMcp = await ctx.storage.virtualMcps.findById(id);
        if (!virtualMcp) return { prompts: [], tile: null };

        const homeTile = virtualMcp.metadata?.ui?.homeTile;
        const tile: TileEntry | null =
          homeTile?.resourceUri && homeTile.connectionId
            ? {
                agentId: id,
                agentName: virtualMcp.title,
                agentIcon: virtualMcp.icon,
                connectionId: homeTile.connectionId,
                resourceUri: homeTile.resourceUri,
                minHeight: homeTile.minHeight,
                maxHeight: homeTile.maxHeight,
              }
            : null;

        const fallback = (): PromptEntry => ({
          agentId: id,
          agentName: virtualMcp.title,
          agentIcon: virtualMcp.icon,
          promptName: "",
          title: virtualMcp.description || "Start a new chat",
          description: "",
          hasArguments: false,
        });

        try {
          const client = await createVirtualClientFrom(
            virtualMcp,
            ctx,
            "passthrough",
            false,
            { listTimeoutMs: LIST_PROMPTS_TIMEOUT_MS },
          );
          try {
            const { prompts } = await client.listPrompts();
            const entries = prompts
              .slice(0, MAX_PROMPTS_PER_AGENT)
              .map((prompt) => ({
                agentId: id,
                agentName: virtualMcp.title,
                agentIcon: virtualMcp.icon,
                promptName: prompt.name,
                title: prompt.title ?? prompt.name,
                description: prompt.description ?? "",
                hasArguments: (prompt.arguments?.length ?? 0) > 0,
                arguments: prompt.arguments,
                _meta: prompt._meta,
              }));
            return {
              prompts: entries.length > 0 ? entries : [fallback()],
              tile,
            };
          } finally {
            await client.close();
          }
        } catch (error) {
          console.error("[home-next-actions] failed to list agent prompts", {
            agentId: id,
            error,
          });
          return { prompts: [fallback()], tile };
        }
      },
    ),
  );

  return {
    prompts: perId.flatMap((r) => r.prompts),
    tiles: perId.map((r) => r.tile).filter((t): t is TileEntry => t !== null),
  };
}

export function createHomeNextActionsRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/home-next-actions", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);

    const promptByName = indexPromptsByName();

    const perAgent = await Promise.all(
      STUDIO_PACK_AGENTS.map(async (agent) => ({
        agent,
        items: await resolveStudioPackChecklist(agent, {
          orgId,
          ctx: mesh,
        }),
      })),
    );

    // Studio Pack guide prompts are registered on the org's "self" MCP and
    // surfaced via the agent's passthrough gateway. We mirror the gateway's
    // namespacing here so the client sees the same `name` + `_meta` it would
    // get from `prompts/list` on the agent.
    const selfClientId = WellKnownOrgMCPId.SELF(orgId);
    const namespacePrefix = `${slugify(selfClientId)}_`;

    const prompts: PromptEntry[] = [];
    for (const { agent, items } of perAgent) {
      for (const item of items) {
        if (item.completed) continue;
        const meta = promptByName.get(item.action.promptName);
        if (!meta) continue;
        const args = meta.arguments?.map((a) => ({
          name: a.name,
          description: a.description,
          required: a.required,
        }));
        prompts.push({
          agentId: agent.getId(orgId),
          agentName: agent.title,
          agentIcon: agent.icon,
          promptName: `${namespacePrefix}${meta.name}`,
          title: meta.title,
          description: meta.description,
          hasArguments: (args?.length ?? 0) > 0,
          arguments: args,
          _meta: { gatewayClientId: selfClientId },
        });
      }
    }

    const studioPackAgentIds = new Set(
      STUDIO_PACK_AGENTS.map((agent) => agent.getId(orgId)),
    );
    const { prompts: defaultPrompts, tiles } =
      await defaultHomeAgentNextActions(orgId, mesh, studioPackAgentIds);
    prompts.push(...defaultPrompts);

    c.header("Cache-Control", "private, max-age=10");
    return c.json({ prompts, tiles });
  });

  return app;
}
