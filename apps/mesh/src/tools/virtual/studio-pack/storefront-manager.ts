/**
 * Storefront Manager
 *
 * Sixth Studio Pack agent — unlike the other five, it isn't installed as a
 * virtual MCP. It only exists as a derived checklist surfaced on the home
 * Tasks panel. State flips ("Connect GitHub" → "Add a storefront" → "Wire
 * up GitHub automations") are computed live from org data; click actions
 * open client-side flows rather than a chat thread.
 */

import type { VirtualMCPEntity } from "@decocms/mesh-sdk";
import type { MeshContext } from "@/core/mesh-context";
import { STOREFRONT_GITHUB_AUTOMATIONS } from "@/tools/virtual/storefront-github-automations";
import type { ChecklistContext, ResolvedChecklistItem } from "./types";

const GITHUB_MCP_HOST = "api.githubcopilot.com";
const GITHUB_MCP_APP_NAME = "mcp-github";

export const storefrontManagerAgent = {
  getId: (orgId: string) => `storefront-manager_${orgId}`,
  title: "Storefront Manager",
  icon: "icon://Globe02?color=sky" as VirtualMCPEntity["icon"],
} as const;

function isGithubMcpConnection(c: {
  app_name?: string | null;
  connection_url?: string | null;
}): boolean {
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
  // Push the GitHub-MCP filter down to SQL so we don't decrypt every other
  // connection's token + env vars just to discard them. `app_name` covers
  // registry-installed rows; the `connection_url` LIKE catches hand-rolled
  // rows that match the canonical GitHub MCP URL.
  const { items } = await mesh.storage.connections.list(orgId, {
    where: {
      operator: "or",
      conditions: [
        {
          field: ["app_name"],
          operator: "eq",
          value: GITHUB_MCP_APP_NAME,
        },
        {
          field: ["connection_url"],
          operator: "like",
          value: `%${GITHUB_MCP_HOST}/mcp%`,
        },
      ],
    },
  });
  return items.filter(isGithubMcpConnection).map((c) => c.id);
}

async function resolveStorefrontState(
  mesh: MeshContext,
  orgId: string,
): Promise<{
  githubConnected: boolean;
  storefrontWithRepoExists: boolean;
  githubAutomationsConfigured: boolean;
}> {
  const [githubConnIds, vmcps] = await Promise.all([
    getGithubMcpConnectionIds(mesh, orgId),
    mesh.storage.virtualMcps.list(orgId),
  ]);
  const githubConnected = githubConnIds.length > 0;

  const storefronts = vmcps.filter(
    (vm) =>
      (vm.metadata as { type?: unknown } | null | undefined)?.type ===
      "storefront-manager",
  );
  const storefrontWithRepoExists = storefronts.some((vm) =>
    Boolean((vm.metadata as { githubRepo?: unknown } | null)?.githubRepo),
  );

  // Early exit: a configured automation requires both a GitHub connection
  // (target of the trigger) and at least one storefront (parent of the
  // automation). Skip the automations + triggers fetch when either side
  // is empty — `githubAutomationsConfigured` can't be true.
  if (!githubConnected || storefronts.length === 0) {
    return {
      githubConnected,
      storefrontWithRepoExists,
      githubAutomationsConfigured: false,
    };
  }

  // "Any storefront has any github automation trigger wired up" — derived
  // from automation_triggers rows (event_type + connection_id) so we don't
  // need a marker column on automations.
  const storefrontIds = new Set(storefronts.map((vm) => vm.id));
  const storefrontAutomations = (
    await mesh.storage.automations.list(orgId)
  ).filter(
    (a) => a.virtual_mcp_id !== null && storefrontIds.has(a.virtual_mcp_id),
  );
  if (storefrontAutomations.length === 0) {
    return {
      githubConnected,
      storefrontWithRepoExists,
      githubAutomationsConfigured: false,
    };
  }
  const triggers = await mesh.storage.automations.listTriggersForAutomations(
    storefrontAutomations.map((a) => a.id),
  );
  const githubConnIdSet = new Set(githubConnIds);
  const knownEventTypes = new Set(
    STOREFRONT_GITHUB_AUTOMATIONS.map((s) => s.triggerType),
  );
  const githubAutomationsConfigured = triggers.some(
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
  };
}

export async function resolveStorefrontManagerChecklist(
  c: ChecklistContext,
): Promise<ResolvedChecklistItem[]> {
  const state = await resolveStorefrontState(c.ctx, c.orgId);

  return [
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
  ];
}
