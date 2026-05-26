/**
 * Studio Pack Checklists
 *
 * `GET /api/:org/studio-pack-checklists`
 *
 * Per-agent onboarding checklists for the Studio Pack agents (Brand,
 * Agent, Automation, Connection, Store) plus a Storefront Manager entry
 * for the GitHub-import setup task. Each item's `completed` flag is
 * derived server-side from current org state — there's no thread or
 * conversation required to surface it. This replaces the studio-pack
 * branch of `suggested-actions`; non-pack stale-thread cards still live
 * there.
 *
 * Items declare an `action` discriminator so the client knows what to do
 * on click. `open-agent-thread` opens the agent's pre-seeded welcome
 * thread and autosends `prompt`. `install-github-mcp`, `add-storefront`,
 * and `setup-site-monitoring` open client-side flows; no thread is
 * created.
 */

import { Hono } from "hono";
import type { MeshContext } from "@/core/mesh-context";
import {
  STUDIO_PACK_AGENTS,
  resolveStorefrontManagerChecklist,
  resolveStudioPackChecklist,
  storefrontManagerAgent,
} from "@/tools/virtual/studio-pack";

type Variables = {
  meshContext: MeshContext;
};

export function createStudioPackChecklistsRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/studio-pack-checklists", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);

    const [storefrontItems, studioPack] = await Promise.all([
      resolveStorefrontManagerChecklist({ orgId, ctx: mesh }),
      Promise.all(
        STUDIO_PACK_AGENTS.map(async (agent) => {
          const items = await resolveStudioPackChecklist(agent, {
            orgId,
            ctx: mesh,
          });
          return {
            agent: {
              id: agent.getId(orgId),
              name: agent.title,
              icon: agent.icon,
            },
            items,
          };
        }),
      ),
    ]);

    const storefront = {
      agent: {
        id: storefrontManagerAgent.getId(orgId),
        name: storefrontManagerAgent.title,
        icon: storefrontManagerAgent.icon,
      },
      items: storefrontItems,
    };

    // Short private cache absorbs rapid window-focus refetches without
    // re-running the org-state derivation. Mutations on the client side
    // invalidate the React Query key, so users still see fresh state on
    // their own actions; only same-state revisits get the cached body.
    c.header("Cache-Control", "private, max-age=10");
    return c.json({ checklists: [storefront, ...studioPack] });
  });

  return app;
}
