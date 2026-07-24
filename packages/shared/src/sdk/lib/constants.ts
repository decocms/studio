/**
 * Well-known MCP Constants
 *
 * Single source of truth for well-known MCP IDs and connection definitions.
 * This module provides constants and factory functions for creating standard MCP connections.
 */

import type {
  ConnectionCreateData,
  ConnectionEntity,
} from "../types/connection";
import type {
  VirtualMCPCreateData,
  VirtualMCPEntity,
} from "../types/virtual-mcp";

/**
 * Well-known MCP connection ID generators (org-scoped)
 *
 * These generate org-prefixed connection IDs for well-known MCPs.
 * Example: WellKnownOrgMCPId.SELF("my-org") => "my-org_self"
 */
export const WellKnownOrgMCPId = {
  /** Self/management MCP - used for management tools (monitoring, organization, user, collections) */
  SELF: (org: string) => `${org}_self`,
  /** Deco Store registry */
  REGISTRY: (org: string) => `${org}_registry`,
  /** Community MCP registry */
  COMMUNITY_REGISTRY: (org: string) => `${org}_community-registry`,
  /** Dev Assets MCP - local file storage for development */
  DEV_ASSETS: (org: string) => `${org}_dev-assets`,
  /** Site Diagnostics agent (note: prefix-first format, not org-first) */
  SITE_DIAGNOSTICS: (org: string) => `site-diagnostics_${org}`,
  /** Commerce Discovery MCP */
  COMMERCE_DISCOVERY: (org: string) => `${org}_commerce-discovery`,
};

// Public origin for the Commerce Discovery (reports) service. Deliberately the
// stable custom domain, NOT the Cloudflare `workers.dev` URL, so the service can
// move off Workers later by just repointing DNS — no code change or data
// migration. This is only the prod default: both the write/claim path
// (auth-client.ts's .origin) and the read-path "Store Report" connection URL
// (getWellKnownCommerceDiscoveryConnection below, via its connectionUrl param)
// are overridable per-deploy through COMMERCE_DISCOVERY_INTERNAL_API_URL, so
// staging derives both from reports-stg.decocms.com instead.
export const COMMERCE_DISCOVERY_MCP_URL =
  "https://reports.decocms.com/api/v2/mcp";
export const COMMERCE_DISCOVERY_REPORT_TOOL_NAME = "get_my_diagnostic";
export const COMMERCE_DISCOVERY_ICON = "https://github.com/decocms.png";

/**
 * Frontend connection ID for the self/management MCP endpoint.
 * Use this constant when calling the builtin management tools from the frontend.
 * The endpoint is exposed at /mcp/self.
 */
export const SELF_MCP_ALIAS_ID = "self";

/**
 * Frontend connection ID for the dev-assets MCP endpoint.
 * Use this constant when calling object storage tools from the frontend in dev mode.
 * The endpoint is exposed at /mcp/dev-assets.
 */
export const DEV_ASSETS_MCP_ALIAS_ID = "dev-assets";

/**
 * Get well-known connection definition for the Deco Store registry.
 * This can be used by both frontend and backend to create registry connections.
 *
 * @returns ConnectionCreateData for the Deco Store registry
 */
export function getWellKnownRegistryConnection(
  orgId: string,
): ConnectionCreateData {
  return {
    id: WellKnownOrgMCPId.REGISTRY(orgId),
    title: "Deco Store",
    description: "Official deco MCP registry with curated integrations",
    connection_type: "HTTP",
    connection_url: "https://studio.decocms.com/org/deco/registry/mcp",
    icon: "https://assets.decocache.com/decocms/00ccf6c3-9e13-4517-83b0-75ab84554bb9/596364c63320075ca58483660156b6d9de9b526e.png",
    app_name: "deco-registry",
    app_id: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "registry",
    },
  };
}

/**
 * Get well-known connection definition for the Community Registry.
 * Community MCP registry with thousands of handy MCPs.
 *
 * @returns ConnectionCreateData for the Community Registry
 */
export function getWellKnownCommunityRegistryConnection(): ConnectionCreateData {
  return {
    id: "community-registry",
    title: "MCP Registry",
    description: "Community MCP registry with thousands of handy MCPs",
    connection_type: "HTTP",
    connection_url: "https://sites-registry.deco.site/mcp",
    icon: "https://assets.decocache.com/decocms/cd7ca472-0f72-463a-b0de-6e44bdd0f9b4/mcp.png",
    app_name: "mcp-registry",
    app_id: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "registry",
    },
  };
}

/**
 * Get well-known connection definition for the Management MCP (SELF).
 * The connection URL is dynamic based on the base URL, so this is a function.
 *
 * @param baseUrl - The base URL for the MCP server (e.g., "http://localhost:3000" or "https://studio.example.com")
 * @returns ConnectionCreateData for the Management MCP
 */
export function getWellKnownSelfConnection(
  baseUrl: string,
  orgId: string,
): ConnectionCreateData {
  return {
    id: WellKnownOrgMCPId.SELF(orgId),
    title: "Deco CMS",
    description: "The MCP for the CMS API",
    connection_type: "HTTP",
    // Custom url for targeting this mcp. It's a standalone endpoint that exposes all management tools.
    connection_url: `${baseUrl}/mcp/${SELF_MCP_ALIAS_ID}`,
    icon: "https://assets.decocache.com/mcp/09e44283-f47d-4046-955f-816d227c626f/app.png",
    app_name: "@deco/management-mcp",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "self",
    },
  };
}

/**
 * Get well-known connection definition for Dev Assets MCP.
 * This is a dev-only MCP that provides local file storage at /data/assets/<org_id>/.
 * It implements the OBJECT_STORAGE_BINDING interface.
 *
 * @param baseUrl - The base URL for the MCP server (e.g., "http://localhost:3000")
 * @param orgId - The organization ID
 * @returns ConnectionCreateData for the Dev Assets MCP
 */
export function getWellKnownDevAssetsConnection(
  baseUrl: string,
  orgId: string,
): ConnectionCreateData {
  return {
    id: WellKnownOrgMCPId.DEV_ASSETS(orgId),
    title: "Local Files",
    description:
      "Local file storage for development. Files are stored in /data/assets/.",
    connection_type: "HTTP",
    connection_url: `${baseUrl}/mcp/${DEV_ASSETS_MCP_ALIAS_ID}`,
    // Folder icon
    icon: "https://api.iconify.design/lucide:folder.svg?color=%23888",
    app_name: "@deco/dev-assets-mcp",
    app_id: null,
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isFixed: true,
      devOnly: true,
      type: "dev-assets",
    },
  };
}

/**
 * Build a paired `{ is, get }` helper for an org-scoped well-known agent id
 * of shape `${prefix}${orgId}`. Centralizes the trivial check/slice/format
 * logic that every well-known agent used to hand-roll.
 *
 * `is(id)` returns the orgId when `id` matches the prefix; `null` otherwise.
 * `get(orgId)` mints the well-known id.
 */
function createWellKnownAgentPrefix(prefix: string): {
  is: (id: string | null | undefined) => string | null;
  get: (organizationId: string) => string;
} {
  return {
    is(id) {
      if (!id) return null;
      if (!id.startsWith(prefix)) return null;
      return id.slice(prefix.length) || null;
    },
    get(organizationId) {
      return `${prefix}${organizationId}`;
    },
  };
}

/**
 * Build a well-known agent VirtualMCPEntity with sensible defaults
 * (status active, system creator, empty connections, etc.). Only the
 * id/title/description/icon and optional instructions vary across agents.
 */
function defineWellKnownAgentVMCP(opts: {
  id: string;
  organizationId: string;
  title: string;
  description: string;
  icon: string;
  instructions?: string | null;
  ui?: VirtualMCPEntity["metadata"] extends { ui?: infer U } ? U : never;
}): VirtualMCPEntity {
  return {
    id: opts.id,
    organization_id: opts.organizationId,
    title: opts.title,
    description: opts.description,
    icon: opts.icon,
    status: "active",
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    created_by: "system",
    updated_by: undefined,
    metadata: {
      instructions: opts.instructions ?? null,
      ...(opts.ui ? { ui: opts.ui } : {}),
    },
    pinned: false,
    connections: [],
  };
}

// ---- Decopilot ----
// Default agent that aggregates ALL org connections. Gateway populates
// the connections array at lookup time.
const decopilotPrefix = createWellKnownAgentPrefix("decopilot_");
export const isDecopilot = decopilotPrefix.is;
export const getDecopilotId = decopilotPrefix.get;

// ---- Dev connection (ephemeral sandbox dev-server) ----
// Synthetic, never-persisted connection id pointing at an agent's running
// sandbox dev server: `dev_<virtualMcpId>`. Resolved per-acting-user at request
// time (see apps/api/src/api/routes/dev-connection.ts). Mirrors the `_self`
// synthetic-id bypass in the proxy. `dev_` doesn't collide with other
// well-known ids (`*_self`, `*_dev-assets` uses a hyphen).
const devConnectionPrefix = createWellKnownAgentPrefix("dev_");
/** Mint the synthetic dev-connection id for an agent (virtual MCP) id. */
export const getDevConnectionId = devConnectionPrefix.get;
/** Returns the agent id when `id` is a `dev_<agentId>` connection id; else null. */
export const parseDevConnectionId = devConnectionPrefix.is;

/** The Super Agent (Decopilot) brand glyph — the capybara. */
export const SUPER_AGENT_ICON_URL =
  "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png";

export function getWellKnownDecopilotVirtualMCP(
  organizationId: string,
): VirtualMCPEntity {
  return defineWellKnownAgentVMCP({
    id: getDecopilotId(organizationId),
    organizationId,
    title: "Super Agent",
    description: "Default agent that aggregates all organization connections",
    icon: SUPER_AGENT_ICON_URL,
    // The org landing IS the Super Agent — it opens on the built-in Overview
    // view (recent team activity) with chat alongside. No bespoke home screen;
    // this is just an agent with a default view, like any other.
    ui: {
      layout: {
        defaultMainView: { type: "overview" },
        chatDefaultOpen: true,
      },
    },
  });
}

// ---- Brand-Context Setup ----
// Guided-onboarding agent for the brand-context preset task. The
// `brand_context_setup` built-in is injected by `dispatchRun` when this
// id is seen; the system prompt lives in `metadata.instructions`.
const brandContextSetupPrefix = createWellKnownAgentPrefix(
  "brand-context-setup_",
);
export const isBrandContextSetup = brandContextSetupPrefix.is;
export const getBrandContextSetupId = brandContextSetupPrefix.get;

const BRAND_CONTEXT_SETUP_INSTRUCTIONS = `
You are running the brand-context onboarding for the user's organization. Your only job in this thread is to set up the organization's brand context:

1. If the user hasn't already given you a website URL, ask for it in one short message. Accept whatever URL they give — don't quibble about format.
2. As soon as you have a URL, call the \`brand_context_setup\` tool exactly once with that URL.
3. After the tool returns success, briefly confirm to the user what was captured (brand name + domain) in one or two sentences. Do not list every color or font.
4. Do NOT call any other tools in this thread. Do NOT call \`brand_context_setup\` more than once.

If the tool returns an error, surface the error message to the user and ask whether they want to try a different URL.
`.trim();

export function getWellKnownBrandContextSetupVirtualMCP(
  organizationId: string,
): VirtualMCPEntity {
  return defineWellKnownAgentVMCP({
    id: getBrandContextSetupId(organizationId),
    organizationId,
    title: "Brand context setup",
    description:
      "Guided onboarding agent that extracts brand context from a website URL.",
    icon: "https://assets.decocache.com/decocms/fd07a578-6b1c-40f1-bc05-88a3b981695d/f7fc4ffa81aec04e37ae670c3cd4936643a7b269.png",
    instructions: BRAND_CONTEXT_SETUP_INSTRUCTIONS,
  });
}

// ---- Site Diagnostics ----
const siteDiagnosticsPrefix = createWellKnownAgentPrefix("site-diagnostics_");
export const isSiteDiagnostics = siteDiagnosticsPrefix.is;
export const getSiteDiagnosticsId = siteDiagnosticsPrefix.get;

// ---- Commerce Discovery ----
const commerceDiscoveryPrefix = createWellKnownAgentPrefix(
  "commerce-discovery_",
);
export const isCommerceDiscoveryAgentId = commerceDiscoveryPrefix.is;
export const getCommerceDiscoveryAgentId = commerceDiscoveryPrefix.get;

export function getWellKnownCommerceDiscoveryConnection(
  orgId: string,
  authorizationToken: string,
  connectionUrl = COMMERCE_DISCOVERY_MCP_URL,
): ConnectionCreateData {
  return {
    id: WellKnownOrgMCPId.COMMERCE_DISCOVERY(orgId),
    title: "Store Report",
    description: "Your store's report and diagnostics",
    connection_type: "HTTP",
    connection_url: connectionUrl,
    icon: COMMERCE_DISCOVERY_ICON,
    app_name: "commerce-discovery",
    app_id: null,
    connection_token: authorizationToken,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: false,
      type: "commerce-discovery",
    },
  };
}

export function getWellKnownCommerceDiscoveryVirtualMCP(
  orgId: string,
  connectionId = WellKnownOrgMCPId.COMMERCE_DISCOVERY(orgId),
): VirtualMCPCreateData {
  return {
    title: "Report Agent",
    description: "Ask anything about your store's report",
    icon: COMMERCE_DISCOVERY_ICON,
    status: "active",
    pinned: true,
    metadata: {
      type: "commerce-discovery",
      isDefault: false,
      ui: {
        pinnedViews: [
          {
            connectionId,
            toolName: COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
            label: "Report",
            icon: COMMERCE_DISCOVERY_ICON,
          },
        ],
        layout: {
          defaultMainView: {
            type: "ext-apps",
            id: connectionId,
            toolName: COMMERCE_DISCOVERY_REPORT_TOOL_NAME,
          },
          chatDefaultOpen: true,
        },
      },
    },
    connections: [
      {
        connection_id: connectionId,
        selected_tools: [COMMERCE_DISCOVERY_REPORT_TOOL_NAME],
        selected_resources: null,
        selected_prompts: null,
      },
    ],
  };
}

/**
 * Studio Pack agent ID prefixes (org-scoped), keyed the same as StudioPackAgentId below.
 */
const studioPackAgentPrefixes = {
  AGENT_MANAGER: createWellKnownAgentPrefix("studio-agent-manager_"),
  AUTOMATION_MANAGER: createWellKnownAgentPrefix("studio-automation-manager_"),
  CONNECTION_MANAGER: createWellKnownAgentPrefix("studio-connection-manager_"),
  API_KEY_MANAGER: createWellKnownAgentPrefix("studio-api-key-manager_"),
  STORE_MANAGER: createWellKnownAgentPrefix("studio-store-manager_"),
  BRAND_MANAGER: createWellKnownAgentPrefix("studio-brand-manager_"),
  TASK_MANAGER: createWellKnownAgentPrefix("studio-task-manager_"),
  USAGE_MANAGER: createWellKnownAgentPrefix("studio-usage-manager_"),
} as const;

/**
 * Studio Pack agent ID generators (org-scoped)
 */
export const StudioPackAgentId = {
  AGENT_MANAGER: studioPackAgentPrefixes.AGENT_MANAGER.get,
  AUTOMATION_MANAGER: studioPackAgentPrefixes.AUTOMATION_MANAGER.get,
  CONNECTION_MANAGER: studioPackAgentPrefixes.CONNECTION_MANAGER.get,
  API_KEY_MANAGER: studioPackAgentPrefixes.API_KEY_MANAGER.get,
  STORE_MANAGER: studioPackAgentPrefixes.STORE_MANAGER.get,
  BRAND_MANAGER: studioPackAgentPrefixes.BRAND_MANAGER.get,
  TASK_MANAGER: studioPackAgentPrefixes.TASK_MANAGER.get,
  USAGE_MANAGER: studioPackAgentPrefixes.USAGE_MANAGER.get,
} as const;

/**
 * Check if a connection or virtual MCP ID is a Studio Pack agent.
 */
export function isStudioPackAgent(id: string | null | undefined): boolean {
  if (!id) return false;
  return Object.values(studioPackAgentPrefixes).some(
    (prefix) => prefix.is(id) !== null,
  );
}

export function getWellKnownDecopilotConnection(
  organizationId: string,
): ConnectionEntity {
  const virtual = getWellKnownDecopilotVirtualMCP(organizationId);

  return {
    ...virtual,
    id: virtual.id!,
    connection_type: "VIRTUAL",
    connection_url: `virtual://${virtual.id}`,
    app_name: "decopilot",
    app_id: "decopilot",
    connection_token: null,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: {
      isDefault: true,
      type: "decopilot",
    },
    tools: [],
    bindings: [],
  };
}
