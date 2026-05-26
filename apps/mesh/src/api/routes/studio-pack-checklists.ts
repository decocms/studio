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
import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import {
  type ResolvedChecklistItem,
  STUDIO_PACK_AGENTS,
  resolveStudioPackChecklist,
} from "@/tools/virtual/studio-pack";
import { STOREFRONT_GITHUB_AUTOMATIONS } from "@/tools/virtual/storefront-github-automations";

type Variables = {
  meshContext: MeshContext;
};

const GITHUB_MCP_HOST = "api.githubcopilot.com";
const GITHUB_MCP_APP_NAME = "mcp-github";

function isGithubMcpConnection(c: {
  app_name?: string | null;
  connection_url?: string | null;
}): boolean {
  // Registry-installed rows carry the canonical app_name (set by
  // `extractConnectionData` → `getRegistryItemAppName`). Hand-rolled
  // rows might only match by URL.
  if (c.app_name === GITHUB_MCP_APP_NAME) return true;
  const url = c.connection_url;
  if (typeof url !== "string" || url.length === 0) return false;
  try {
    const parsed = new URL(url);
    return (
      parsed.hostname === GITHUB_MCP_HOST &&
      parsed.pathname.replace(/\/+$/, "") === "/mcp"
    );
  } catch {
    return false;
  }
}

async function getGithubMcpConnectionIds(
  mesh: MeshContext,
  orgId: string,
): Promise<string[]> {
  const { items } = await mesh.storage.connections.list(orgId);
  return items.filter(isGithubMcpConnection).map((c) => c.id);
}

type StorefrontState = {
  githubConnected: boolean;
  storefrontWithRepoExists: boolean;
  githubAutomationsConfigured: boolean;
  storefrontFullyMonitored: boolean;
};

async function resolveStorefrontState(
  mesh: MeshContext,
  orgId: string,
): Promise<StorefrontState> {
  const [githubConnIds, vmcps] = await Promise.all([
    getGithubMcpConnectionIds(mesh, orgId),
    mesh.storage.virtualMcps.list(orgId),
  ]);
  const githubConnected = githubConnIds.length > 0;
  const githubConnIdSet = new Set(githubConnIds);

  const storefronts = vmcps.filter(
    (vm) =>
      (vm.metadata as { type?: unknown } | null | undefined)?.type ===
      "storefront-manager",
  );
  const storefrontWithRepoExists = storefronts.some((vm) =>
    Boolean((vm.metadata as { githubRepo?: unknown } | null)?.githubRepo),
  );
  const siteDiagnosticsExists = vmcps.some(
    (vm) =>
      (vm.metadata as { type?: unknown } | null | undefined)?.type ===
      "site-diagnostics",
  );
  const storefrontWithSiteUrlExists = storefronts.some((vm) => {
    const sf = (vm.metadata as { storefront?: { siteUrl?: unknown } } | null)
      ?.storefront;
    return typeof sf?.siteUrl === "string" && sf.siteUrl.length > 0;
  });

  // "Any storefront has any github automation trigger wired up" — derived
  // from automation_triggers rows (event_type + connection_id) so we don't
  // need a marker column on automations.
  const storefrontIds = new Set(storefronts.map((vm) => vm.id));
  const storefrontAutomations = (
    await mesh.storage.automations.list(orgId)
  ).filter(
    (a) => a.virtual_mcp_id !== null && storefrontIds.has(a.virtual_mcp_id),
  );
  const triggerLists = await Promise.all(
    storefrontAutomations.map((a) =>
      mesh.storage.automations.listTriggers(a.id),
    ),
  );
  const knownEventTypes = new Set(
    STOREFRONT_GITHUB_AUTOMATIONS.map((s) => s.triggerType),
  );
  const githubAutomationsConfigured = triggerLists
    .flat()
    .some(
      (t) =>
        t.connection_id !== null &&
        githubConnIdSet.has(t.connection_id) &&
        t.event_type !== null &&
        knownEventTypes.has(t.event_type),
    );

  return {
    githubConnected,
    storefrontWithRepoExists,
    githubAutomationsConfigured,
    storefrontFullyMonitored:
      storefrontWithSiteUrlExists && siteDiagnosticsExists,
  };
}

async function buildStorefrontManagerChecklist(
  mesh: MeshContext,
  orgId: string,
): Promise<{
  agent: { id: string; name: string; icon: VirtualMCPEntity["icon"] };
  items: ResolvedChecklistItem[];
}> {
  const state = await resolveStorefrontState(mesh, orgId);

  return {
    agent: {
      id: `storefront-manager_${orgId}`,
      name: "Storefront Manager",
      icon: "icon://Globe02?color=sky",
    },
    items: [
      {
        label: "Connect GitHub",
        activeForm: "Connecting GitHub",
        action: { kind: "install-github-mcp" },
        completed: state.githubConnected,
      },
      {
        label: "Add a storefront",
        activeForm: "Adding a storefront",
        action: { kind: "add-storefront" },
        completed: state.storefrontWithRepoExists,
      },
      {
        label: "Wire up GitHub automations",
        activeForm: "Wiring up GitHub automations",
        action: { kind: "configure-github-automations" },
        completed: state.githubAutomationsConfigured,
      },
      {
        label: "Set up site monitoring",
        activeForm: "Setting up site monitoring",
        action: { kind: "setup-site-monitoring" },
        completed: state.storefrontFullyMonitored,
      },
    ],
  };
}

export function createStudioPackChecklistsRoutes() {
  const app = new Hono<{ Variables: Variables }>();

  app.get("/studio-pack-checklists", async (c) => {
    const mesh = c.get("meshContext");
    const orgId = mesh.organization?.id;
    if (!orgId) return c.json({ error: "Organization required" }, 400);

    const [storefront, studioPack] = await Promise.all([
      buildStorefrontManagerChecklist(mesh, orgId),
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

    return c.json({ checklists: [storefront, ...studioPack] });
  });

  return app;
}
