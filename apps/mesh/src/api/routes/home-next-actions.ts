/**
 * Home Next-Actions
 *
 * `GET /api/:org/home-next-actions`
 *
 * Returns the still-incomplete onboarding `prompts` for the `/$org` home
 * page. Each opens a new thread with the named agent and autosends the
 * resolved MCP prompt as the first user message.
 *
 * Server-side `isCompleted` filters out finished items so the home stays
 * pared down as the user makes progress.
 */

import { Hono } from "hono";
import { slugify } from "@decocms/mcp-utils/aggregate";
import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "@/core/mesh-context";
import { getPrompts } from "@/tools/guides";
import {
  STUDIO_PACK_AGENTS,
  resolveStudioPackChecklist,
} from "@/tools/virtual/studio-pack";

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
   * the slash-command flow (enables click-to-edit on the chip).
   */
  promptName: string;
  title: string;
  description: string;
  hasArguments: boolean;
  arguments: Prompt["arguments"];
  _meta: Prompt["_meta"];
}

function indexPromptsByName() {
  const all = getPrompts();
  const byName = new Map<string, (typeof all)[number]>();
  for (const p of all) byName.set(p.name, p);
  return byName;
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

    c.header("Cache-Control", "private, max-age=10");
    return c.json({ prompts });
  });

  return app;
}
