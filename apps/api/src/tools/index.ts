/**
 * Tool Registry
 *
 * Central export for all Studio management tools.
 * Types are inferred from CORE_TOOLS — this is the source of truth.
 */

import { StudioContext } from "@/core/studio-context";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { sharedJsonSchemaValidator } from "@decocms/mcp-utils";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as ApiKeyTools from "./apiKeys";
import * as CommerceDiscoveryTools from "./reports";
import * as ConnectionTools from "./connection";
import * as DatabaseTools from "./database";
import * as VirtualMCPTools from "./virtual";
import * as MonitoringTools from "./monitoring";
import * as OrganizationTools from "./organization";
import * as TaskBoardTools from "./task-board";
import * as TagTools from "./tags";
import * as ThreadTools from "./thread";
import * as AutomationTools from "./automations";
import * as UserTools from "./user";
import * as AiProvidersTools from "./ai-providers";
import * as ClaudeSubscriptionTools from "./claude-subscription";
import * as SecretsTools from "./secrets";
import * as FileConfigTools from "./file-configs";
import { ORG_FS_PUBLIC_SETS_SYNC } from "./org-fs/sync-public-sets";
import { getPrompts, getResources } from "./guides";
import {
  getToolRegistration,
  type RegistrableTool,
} from "./management-registration";
export { managementContextStore } from "./management-registration";
import * as ObjectStorageTools from "./object-storage";
import * as RegistryTools from "./registry/index";
import * as SandboxTools from "./sandbox";
import * as GitHubTools from "./github";
import * as SearchTools from "./search";
import type { ToolName } from "@decocms/shared/tools/registry-metadata";
// Core tools - always available
export const CORE_TOOLS = [
  OrganizationTools.ORGANIZATION_CREATE,
  OrganizationTools.ORGANIZATION_LIST,
  OrganizationTools.ORGANIZATION_GET,
  OrganizationTools.ORGANIZATION_UPDATE,
  OrganizationTools.ORGANIZATION_DELETE,
  OrganizationTools.ORGANIZATION_SETTINGS_GET,
  OrganizationTools.ORGANIZATION_SETTINGS_UPDATE,
  TaskBoardTools.TASK_BOARD_ITEM_CREATE,
  TaskBoardTools.TASK_BOARD_ITEM_LIST,
  TaskBoardTools.TASK_BOARD_ITEM_UPDATE,
  TaskBoardTools.TASK_BOARD_ITEM_DELETE,
  TaskBoardTools.TASK_BOARD_ITEM_PRS_GET,
  TaskBoardTools.TASK_BOARD_REVIEW_DECISION,
  TaskBoardTools.TASK_BOARD_PROMOTE_TO_PRODUCTION,
  TaskBoardTools.TASK_BOARD_ACTIVITY_LIST,
  TaskBoardTools.TASK_BOARD_COMMENT_LIST,
  TaskBoardTools.TASK_BOARD_COMMENT_CREATE,
  TaskBoardTools.TASK_BOARD_COMMENT_UPDATE,
  TaskBoardTools.TASK_BOARD_COMMENT_DELETE,
  TaskBoardTools.TASK_ADD_REPO,
  OrganizationTools.BRAND_CONTEXT_LIST,
  OrganizationTools.BRAND_CONTEXT_GET,
  OrganizationTools.BRAND_CONTEXT_CREATE,
  OrganizationTools.BRAND_CONTEXT_UPDATE,
  OrganizationTools.BRAND_CONTEXT_DELETE,
  OrganizationTools.BRAND_CONTEXT_EXTRACT,
  OrganizationTools.BRAND_GET,
  OrganizationTools.BRAND_LIST,
  OrganizationTools.ORGANIZATION_DOMAIN_LIST,
  OrganizationTools.ORGANIZATION_DOMAIN_ADD,
  OrganizationTools.ORGANIZATION_DOMAIN_UPDATE,
  OrganizationTools.ORGANIZATION_DOMAIN_VERIFY,
  OrganizationTools.ORGANIZATION_DOMAIN_REMOVE,
  OrganizationTools.ORGANIZATION_JOIN_REQUEST_LIST,
  OrganizationTools.ORGANIZATION_JOIN_REQUEST_APPROVE,
  OrganizationTools.ORGANIZATION_JOIN_REQUEST_DENY,
  OrganizationTools.ORGANIZATION_MEMBER_ADD,
  OrganizationTools.ORGANIZATION_MEMBER_REMOVE,
  OrganizationTools.ORGANIZATION_MEMBER_LIST,
  OrganizationTools.ORGANIZATION_MEMBER_UPDATE_ROLE,
  OrganizationTools.ORGANIZATION_BILLING_CHECKOUT_START,
  OrganizationTools.ORGANIZATION_BILLING_PORTAL,

  // Connection collection tools
  ConnectionTools.COLLECTION_CONNECTIONS_CREATE,
  ConnectionTools.COLLECTION_CONNECTIONS_LIST,
  ConnectionTools.COLLECTION_CONNECTIONS_GET,
  ConnectionTools.COLLECTION_CONNECTIONS_UPDATE,
  ConnectionTools.COLLECTION_CONNECTIONS_DELETE,
  ConnectionTools.CONNECTION_TEST,
  CommerceDiscoveryTools.COMMERCE_DISCOVERY_SETUP,
  CommerceDiscoveryTools.COMMERCE_DISCOVERY_RUN,
  CommerceDiscoveryTools.COMMERCE_DISCOVERY_BIND,
  CommerceDiscoveryTools.COMMERCE_DISCOVERY_CONNECTION_STATUS,

  // Virtual MCP collection tools
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_CREATE,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_LIST,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_GET,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_UPDATE,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_DELETE,

  // Database tools
  DatabaseTools.DATABASES_RUN_SQL,

  // Monitoring tools
  MonitoringTools.MONITORING_LOG_GET,
  MonitoringTools.MONITORING_LOGS_LIST,
  MonitoringTools.MONITORING_STATS,
  MonitoringTools.MONITORING_THREAD_USAGE,

  // API Key tools
  ApiKeyTools.API_KEY_CREATE,
  ApiKeyTools.API_KEY_LIST,
  ApiKeyTools.API_KEY_UPDATE,
  ApiKeyTools.API_KEY_DELETE,

  // User tools
  UserTools.USER_GET,
  UserTools.USER_MODEL_PREFERENCES_GET,
  UserTools.USER_MODEL_PREFERENCES_UPDATE,

  // Thread collection tools
  ThreadTools.COLLECTION_THREADS_CREATE,
  ThreadTools.COLLECTION_THREADS_LIST,
  ThreadTools.COLLECTION_THREADS_GET,
  ThreadTools.COLLECTION_THREADS_UPDATE,
  ThreadTools.COLLECTION_THREADS_DELETE,
  ThreadTools.COLLECTION_THREAD_MESSAGES_LIST,

  // Tag tools
  TagTools.TAGS_LIST,
  TagTools.TAGS_CREATE,
  TagTools.TAGS_DELETE,
  TagTools.MEMBER_TAGS_GET,
  TagTools.MEMBER_TAGS_SET,

  // Automation tools
  AutomationTools.AUTOMATION_CREATE,
  AutomationTools.AUTOMATION_GET,
  AutomationTools.AUTOMATION_LIST,
  AutomationTools.AUTOMATION_UPDATE,
  AutomationTools.AUTOMATION_DELETE,
  AutomationTools.AUTOMATION_TRIGGER_ADD,
  AutomationTools.AUTOMATION_TRIGGER_REMOVE,
  AutomationTools.AUTOMATION_TRIGGER_ROTATE_TOKEN,
  AutomationTools.AUTOMATION_RUN,
  AutomationTools.AUTOMATION_RUN_STATS,

  // Virtual MCP plugin config tools
  VirtualMCPTools.VIRTUAL_MCP_PLUGIN_CONFIG_GET,
  VirtualMCPTools.VIRTUAL_MCP_PLUGIN_CONFIG_UPDATE,
  VirtualMCPTools.VIRTUAL_MCP_PINNED_VIEWS_UPDATE,
  VirtualMCPTools.VIRTUAL_MCP_LAST_USED_LIST,

  // Ai providers tools
  AiProvidersTools.AI_PROVIDERS_LIST,
  AiProvidersTools.AI_PROVIDERS_LIST_MODELS,
  AiProvidersTools.AI_PROVIDERS_ACTIVE,
  AiProvidersTools.AI_PROVIDER_KEY_CREATE,
  AiProvidersTools.AI_PROVIDER_KEY_DELETE,
  AiProvidersTools.AI_PROVIDER_KEY_UPDATE,
  AiProvidersTools.AI_PROVIDER_KEY_PREVIEW,
  AiProvidersTools.AI_PROVIDER_KEY_LIST,
  AiProvidersTools.AI_PROVIDER_OAUTH_URL,
  AiProvidersTools.AI_PROVIDER_OAUTH_EXCHANGE,
  AiProvidersTools.AI_PROVIDER_PROVISION_KEY,
  AiProvidersTools.AI_PROVIDER_TOPUP_URL,
  AiProvidersTools.AI_PROVIDER_CREDITS,
  // Claude subscription (per-user OAuth credential for the claude-code harness)
  ClaudeSubscriptionTools.CLAUDE_SUBSCRIPTION_LOGIN_URL,
  ClaudeSubscriptionTools.CLAUDE_SUBSCRIPTION_CONNECT,
  ClaudeSubscriptionTools.CLAUDE_SUBSCRIPTION_STATUS,
  ClaudeSubscriptionTools.CLAUDE_SUBSCRIPTION_DISCONNECT,
  // Secrets tools
  SecretsTools.SECRET_CREATE,
  SecretsTools.SECRET_LIST,

  // File config tools (org-scoped S3 bucket configurations)
  FileConfigTools.FILE_CONFIG_CREATE,
  FileConfigTools.FILE_CONFIG_LIST,
  FileConfigTools.FILE_CONFIG_UPDATE,
  FileConfigTools.FILE_CONFIG_DELETE,
  FileConfigTools.FILE_OBJECTS_LIST,

  // Org filesystem (shared public skill sets)
  ORG_FS_PUBLIC_SETS_SYNC,

  // Object Storage tools
  ObjectStorageTools.LIST_OBJECTS,
  ObjectStorageTools.GET_OBJECT_METADATA,
  ObjectStorageTools.GET_PRESIGNED_URL,
  ObjectStorageTools.PUT_PRESIGNED_URL,
  ObjectStorageTools.DELETE_OBJECT,
  ObjectStorageTools.DELETE_OBJECTS,

  // Registry tools
  ...RegistryTools.tools,

  // VM tools (app-only)
  SandboxTools.SANDBOX_START,
  SandboxTools.SANDBOX_DELETE,

  // GitHub tools (app-only)
  GitHubTools.GITHUB_LIST_USER_ORGS,

  // Link tools

  // Search tools
  SearchTools.GLOBAL_SEARCH,
] as const satisfies { name: ToolName }[];

/**
 * Tuple type of the core tools, preserving each tool's concrete Zod
 * input/output schema types (unlike the widened `RegistrableTool`). Type-only
 * consumers derive per-tool input/output types from this — see `./io-types`.
 * Import as `import type` only; importing as a value would pull the entire
 * server tool graph into a bundle.
 */
export type CoreTools = typeof CORE_TOOLS;

/**
 * Static name→tool map over the (static) tool set, built once at module load.
 * Shared by the REST dispatch/list endpoints and the MCP server.
 *
 * Values are widened to `RegistrableTool` (a uniform shape with
 * `execute(unknown, ctx)`) — the concrete per-tool tuple types form a union of
 * functions with incompatible parameters that can't be called generically. This
 * map is the single boundary where that widening happens.
 */
export const TOOL_BY_NAME: Map<string, RegistrableTool> = new Map(
  (CORE_TOOLS as unknown as RegistrableTool[]).map((tool) => [tool.name, tool]),
);

/**
 * An MCP server exposing just the named management tools — no prompts, no brand
 * prompts, no resources.
 *
 * For a machine consumer that needs a handful of tools and pays for the rest in
 * context: the whole management surface is ~200 tools, and a harness handed all
 * of them has to find the two it was told to call inside that list. Unknown
 * names are skipped rather than thrown on, so a renamed tool degrades to a
 * missing tool instead of a dead endpoint.
 */
export const toolSubsetMCP = (
  name: string,
  toolNames: readonly string[],
): McpServer => {
  const server = new McpServer(
    { name, version: "1.0.0" },
    {
      capabilities: { tools: {} },
      jsonSchemaValidator: sharedJsonSchemaValidator,
    },
  );
  for (const toolName of toolNames) {
    const tool = TOOL_BY_NAME.get(toolName);
    if (!tool) {
      console.warn(`[${name}] unknown tool "${toolName}" — not registered`);
      continue;
    }
    const { config, handler } = getToolRegistration(tool);
    server.registerTool(tool.name, config, handler);
  }
  return server;
};

export const managementMCP = async (ctx: StudioContext) => {
  // Create MCP server directly
  const server = new McpServer(
    { name: "mcp-cms-management", version: "1.0.0" },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      jsonSchemaValidator: sharedJsonSchemaValidator,
    },
  );

  // Register each tool from its shared, prebuilt registration (config carries
  // the prebuilt Zod schemas; the handler reads ctx from the ALS store at call
  // time rather than capturing it). Only the map insertion is per-request.
  for (const tool of TOOL_BY_NAME.values()) {
    const { config, handler } = getToolRegistration(tool);
    server.registerTool(tool.name, config, handler);
  }

  // Register action prompts
  const prompts = getPrompts();
  for (const prompt of prompts) {
    const argsSchema = prompt.arguments?.length
      ? Object.fromEntries(
          prompt.arguments.map((a) => {
            const base = a.required ? z.string() : z.string().optional();
            return [
              a.name,
              a.description ? base.describe(a.description) : base,
            ];
          }),
        )
      : undefined;

    server.registerPrompt(
      prompt.name,
      {
        title: prompt.title,
        description: prompt.description,
        ...(argsSchema ? { argsSchema } : {}),
      },
      (args) => {
        const text =
          typeof prompt.text === "function"
            ? prompt.text((args ?? {}) as Record<string, string | undefined>)
            : prompt.text;
        return {
          messages: [
            {
              role: "user" as const,
              content: { type: "text" as const, text },
            },
          ],
        };
      },
    );
  }

  // Register one prompt per brand context (e.g. /brand-acme-corp)
  if (ctx.organization?.id) {
    const brands = await ctx.storage.brandContext.list(ctx.organization.id);

    const registeredPromptNames = new Set<string>();
    for (const brand of brands) {
      const slug = brand.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "");
      let promptName = slug ? `brand-${slug}` : `brand-${brand.id}`;
      // Deduplicate — append ID suffix on collision
      if (registeredPromptNames.has(promptName)) {
        promptName = `${promptName}-${brand.id.slice(0, 8)}`;
      }
      registeredPromptNames.add(promptName);

      const lines: string[] = [
        `# Brand: ${brand.name}`,
        "",
        `**Domain:** ${brand.domain}`,
        "",
        "## Overview",
        brand.overview,
      ];

      if (brand.colors) {
        const colorEntries = Object.entries(brand.colors).filter(([, v]) => v);
        if (colorEntries.length > 0) {
          lines.push("", "## Colors");
          for (const [role, value] of colorEntries) {
            lines.push(`- **${role}:** ${value}`);
          }
        }
      }

      if (brand.fonts) {
        const fontEntries = Object.entries(brand.fonts).filter(([, v]) => v);
        if (fontEntries.length > 0) {
          lines.push("", "## Fonts");
          for (const [role, family] of fontEntries) {
            lines.push(`- ${family} (${role})`);
          }
        }
      }

      if (brand.logo) {
        lines.push("", `**Logo:** ${brand.logo}`);
      }
      if (brand.favicon) {
        lines.push(`**Favicon:** ${brand.favicon}`);
      }
      if (brand.ogImage) {
        lines.push(`**OG Image:** ${brand.ogImage}`);
      }

      if (brand.images && brand.images.length > 0) {
        lines.push("", "## Images");
        for (const img of brand.images) {
          const parts = Object.entries(img)
            .map(([k, v]) => `${k}: ${v}`)
            .join(", ");
          lines.push(`- ${parts}`);
        }
      }

      const text = lines.join("\n");

      server.prompt(promptName, `Brand context for ${brand.name}`, () => ({
        messages: [
          {
            role: "user" as const,
            content: { type: "text" as const, text },
          },
        ],
      }));
    }
  }

  // Register reference resources
  const resources = getResources();
  for (const resource of resources) {
    server.resource(
      resource.name,
      resource.uri,
      {
        description: resource.description,
        mimeType: resource.mimeType ?? "text/markdown",
      },
      async (uri) => {
        const resourceUri = typeof uri === "string" ? uri : uri.href;
        return {
          contents: [
            {
              uri: resourceUri,
              mimeType: resource.mimeType ?? "text/markdown",
              text: resource.text,
            },
          ],
        };
      },
    );
  }

  return server;
};

/**
 * List management MCP tools in-process (no HTTP round-trip).
 * The self MCP endpoint requires session auth, so hydrating its tool list
 * via HTTP fails on a cold NATS cache. This bypasses HTTP entirely by
 * connecting a client to the management server over InMemoryTransport.
 */
export async function listManagementTools(
  ctx: StudioContext,
): Promise<McpTool[]> {
  const server = await managementMCP(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client(
    { name: "tools-hydration", version: "1.0.0" },
    { jsonSchemaValidator: sharedJsonSchemaValidator },
  );
  try {
    await client.connect(clientTransport);
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close().catch(() => {});
    await server.close().catch(() => {});
  }
}
