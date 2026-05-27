/**
 * Home Next-Actions
 *
 * `GET /api/:org/home-next-actions`
 *
 * Returns the still-incomplete onboarding actions for the `/$org` home
 * page. Two shapes coexist:
 * - `prompts`: each opens a new thread with the named agent and autosends
 *   the resolved MCP prompt as the first user message.
 * - `dialogs`: each opens a client-side modal (storefront / GitHub / site
 *   monitoring). No thread is created.
 *
 * Server-side `isCompleted` filters out finished items so the home stays
 * pared down as the user makes progress.
 */

import { Hono } from "hono";
import type { Prompt } from "@modelcontextprotocol/sdk/types.js";
import type { MeshContext } from "@/core/mesh-context";
import { getPrompts } from "@/tools/guides";
import {
  STUDIO_PACK_AGENTS,
  resolveStorefrontManagerChecklist,
  resolveStudioPackChecklist,
  storefrontManagerAgent,
} from "@/tools/virtual/studio-pack";

type Variables = {
  meshContext: MeshContext;
};

type DialogKind =
  | "install-github-mcp"
  | "add-storefront"
  | "configure-github-automations"
  | "setup-site-monitoring"
  | "github-import";

interface PromptEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  promptName: string;
  title: string;
  description: string;
  hasArguments: boolean;
  arguments: Prompt["arguments"];
}

interface DialogEntry {
  agentId: string;
  agentName: string;
  agentIcon: string | null;
  label: string;
  kind: DialogKind;
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

    const [storefrontItems, perAgent] = await Promise.all([
      resolveStorefrontManagerChecklist({ orgId, ctx: mesh }),
      Promise.all(
        STUDIO_PACK_AGENTS.map(async (agent) => ({
          agent,
          items: await resolveStudioPackChecklist(agent, {
            orgId,
            ctx: mesh,
          }),
        })),
      ),
    ]);

    const prompts: PromptEntry[] = [];
    for (const { agent, items } of perAgent) {
      for (const item of items) {
        if (item.completed) continue;
        if (item.action.kind !== "open-agent-thread") continue;
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
          promptName: meta.name,
          title: meta.title,
          description: meta.description,
          hasArguments: (args?.length ?? 0) > 0,
          arguments: args,
        });
      }
    }

    const dialogs: DialogEntry[] = [];
    for (const item of storefrontItems) {
      if (item.completed) continue;
      if (item.action.kind === "open-agent-thread") continue;
      dialogs.push({
        agentId: storefrontManagerAgent.getId(orgId),
        agentName: storefrontManagerAgent.title,
        agentIcon: storefrontManagerAgent.icon,
        label: item.label,
        kind: item.action.kind,
      });
    }

    c.header("Cache-Control", "private, max-age=10");
    return c.json({ prompts, dialogs });
  });

  return app;
}
