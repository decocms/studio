/**
 * Tool Registry
 *
 * Central export for all MCP Mesh management tools
 * Types are inferred from ALL_TOOLS - this is the source of truth.
 *
 * Plugin tools are collected at startup and combined with core tools.
 */

import type { ToolAnnotations } from "@/core/define-tool";
import { MeshContext } from "@/core/mesh-context";
import {
  collectPluginTools,
  filterToolsByEnabledPlugins,
} from "@/core/plugin-loader";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Tool as McpTool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import * as ApiKeyTools from "./apiKeys";
import * as ConnectionTools from "./connection";
import * as DatabaseTools from "./database";
import * as EventBusTools from "./eventbus";
import * as VirtualMCPTools from "./virtual";
import * as MonitoringTools from "./monitoring";
import * as MonitoringDashboardTools from "./monitoring-dashboard";
import * as OrganizationTools from "./organization";
import * as ProjectTools from "./projects";
import * as TagTools from "./tags";
import * as ThreadTools from "./thread";
import * as AutomationTools from "./automations";
import * as UserTools from "./user";
import * as AiProvidersTools from "./ai-providers";
import * as ContextRepoTools from "./context-repo";
import { getPrompts, getResources } from "./guides";
import { ToolName } from "./registry";
// Core tools - always available
const CORE_TOOLS = [
  OrganizationTools.ORGANIZATION_CREATE,
  OrganizationTools.ORGANIZATION_LIST,
  OrganizationTools.ORGANIZATION_GET,
  OrganizationTools.ORGANIZATION_UPDATE,
  OrganizationTools.ORGANIZATION_DELETE,
  OrganizationTools.ORGANIZATION_SETTINGS_GET,
  OrganizationTools.ORGANIZATION_SETTINGS_UPDATE,
  OrganizationTools.ORGANIZATION_MEMBER_ADD,
  OrganizationTools.ORGANIZATION_MEMBER_REMOVE,
  OrganizationTools.ORGANIZATION_MEMBER_LIST,
  OrganizationTools.ORGANIZATION_MEMBER_UPDATE_ROLE,

  // Connection collection tools
  ConnectionTools.COLLECTION_CONNECTIONS_CREATE,
  ConnectionTools.COLLECTION_CONNECTIONS_LIST,
  ConnectionTools.COLLECTION_CONNECTIONS_GET,
  ConnectionTools.COLLECTION_CONNECTIONS_UPDATE,
  ConnectionTools.COLLECTION_CONNECTIONS_DELETE,
  ConnectionTools.CONNECTION_TEST,

  // Virtual MCP collection tools
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_CREATE,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_LIST,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_GET,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_UPDATE,
  VirtualMCPTools.COLLECTION_VIRTUAL_MCP_DELETE,

  // Database tools
  DatabaseTools.DATABASES_RUN_SQL,

  // Monitoring tools
  MonitoringTools.MONITORING_LOGS_LIST,
  MonitoringTools.MONITORING_STATS,

  // Monitoring Dashboard tools
  MonitoringDashboardTools.MONITORING_DASHBOARD_CREATE,
  MonitoringDashboardTools.MONITORING_DASHBOARD_GET,
  MonitoringDashboardTools.MONITORING_DASHBOARD_LIST,
  MonitoringDashboardTools.MONITORING_DASHBOARD_UPDATE,
  MonitoringDashboardTools.MONITORING_DASHBOARD_DELETE,
  MonitoringDashboardTools.MONITORING_DASHBOARD_QUERY,
  MonitoringDashboardTools.MONITORING_WIDGET_PREVIEW,

  // API Key tools
  ApiKeyTools.API_KEY_CREATE,
  ApiKeyTools.API_KEY_LIST,
  ApiKeyTools.API_KEY_UPDATE,
  ApiKeyTools.API_KEY_DELETE,

  // Event Bus tools
  EventBusTools.EVENT_PUBLISH,
  EventBusTools.EVENT_SUBSCRIBE,
  EventBusTools.EVENT_UNSUBSCRIBE,
  EventBusTools.EVENT_CANCEL,
  EventBusTools.EVENT_ACK,
  EventBusTools.EVENT_SUBSCRIPTION_LIST,
  EventBusTools.EVENT_SYNC_SUBSCRIPTIONS,

  // User tools
  UserTools.USER_GET,

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
  AutomationTools.AUTOMATION_RUN,

  // Project tools
  ProjectTools.PROJECT_LIST,
  ProjectTools.PROJECT_GET,
  ProjectTools.PROJECT_CREATE,
  ProjectTools.PROJECT_UPDATE,
  ProjectTools.PROJECT_DELETE,
  ProjectTools.PROJECT_PLUGIN_CONFIG_GET,
  ProjectTools.PROJECT_PLUGIN_CONFIG_UPDATE,
  ProjectTools.PROJECT_CONNECTION_LIST,
  ProjectTools.PROJECT_CONNECTION_ADD,
  ProjectTools.PROJECT_CONNECTION_REMOVE,
  ProjectTools.PROJECT_PINNED_VIEWS_UPDATE,

  // Ai providers tools
  AiProvidersTools.AI_PROVIDERS_LIST,
  AiProvidersTools.AI_PROVIDERS_LIST_MODELS,
  AiProvidersTools.AI_PROVIDERS_ACTIVE,
  AiProvidersTools.AI_PROVIDER_KEY_CREATE,
  AiProvidersTools.AI_PROVIDER_KEY_DELETE,
  AiProvidersTools.AI_PROVIDER_KEY_LIST,
  AiProvidersTools.AI_PROVIDER_OAUTH_URL,
  AiProvidersTools.AI_PROVIDER_OAUTH_EXCHANGE,
  AiProvidersTools.AI_PROVIDER_TOPUP_URL,
  AiProvidersTools.AI_PROVIDER_CREDITS,

  // Context repo tools
  ContextRepoTools.CONTEXT_REPO_STATUS,
  ContextRepoTools.CONTEXT_REPO_SETUP,
  ContextRepoTools.CONTEXT_REPO_UPDATE_FOLDERS,
  ContextRepoTools.CONTEXT_REPO_SYNC,
  ContextRepoTools.CONTEXT_REPO_SEARCH,
  ContextRepoTools.CONTEXT_REPO_READ,
  ContextRepoTools.CONTEXT_REPO_LIST_SKILLS,
  ContextRepoTools.CONTEXT_ISSUE_CREATE,
  ContextRepoTools.CONTEXT_ISSUE_LIST,
  ContextRepoTools.CONTEXT_ISSUE_GET,
  ContextRepoTools.CONTEXT_ISSUE_COMMENT,
  ContextRepoTools.CONTEXT_AGENT_SAVE,
] as const satisfies { name: ToolName }[];

// Plugin tools - collected at startup, gated by org settings at runtime
const PLUGIN_TOOLS = collectPluginTools();

// Tool type for combined core + plugin tools
interface CombinedTool {
  name: string;
  description: string;
  inputSchema: unknown;
  outputSchema: unknown;
  annotations?: ToolAnnotations;
  _meta?: Record<string, unknown>;
  handler: (input: unknown, ctx: MeshContext) => Promise<unknown>;
  execute: (input: unknown, ctx: MeshContext) => Promise<unknown>;
}

// All available tools - core + plugin tools
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const ALL_TOOLS: CombinedTool[] = [
  ...(CORE_TOOLS as unknown as CombinedTool[]),
  ...(PLUGIN_TOOLS as unknown as CombinedTool[]),
];

export type MCPMeshTools = typeof ALL_TOOLS;

// Derive tool name type from ALL_TOOLS
export type ToolNameFromTools = (typeof ALL_TOOLS)[number]["name"];

export const managementMCP = async (ctx: MeshContext) => {
  // Get enabled plugins for this organization to filter plugin tools
  // Check both org settings (legacy) and all projects (current UI saves to projects table)
  let enabledPlugins: string[] | null = null;
  if (ctx.organization) {
    const settings = await ctx.storage.organizationSettings.get(
      ctx.organization.id,
    );
    const projects = await ctx.storage.projects.list(ctx.organization.id);
    // Merge enabled plugins from org settings + all projects
    const merged = new Set<string>(settings?.enabled_plugins ?? []);
    for (const project of projects) {
      if (project.enabledPlugins) {
        for (const pluginId of project.enabledPlugins) {
          merged.add(pluginId);
        }
      }
    }
    enabledPlugins = merged.size > 0 ? [...merged] : null;
  }

  // Filter tools based on enabled plugins
  // Core tools are always included, plugin tools only if their plugin is enabled
  const filteredTools = filterToolsByEnabledPlugins(ALL_TOOLS, enabledPlugins);

  // Create MCP server directly
  const server = new McpServer(
    { name: "mcp-cms-management", version: "1.0.0" },
    { capabilities: { tools: {}, prompts: {}, resources: {} } },
  );

  // Register each tool with the server
  for (const tool of filteredTools) {
    const inputSchema =
      tool.inputSchema &&
      typeof tool.inputSchema === "object" &&
      "shape" in tool.inputSchema
        ? (tool.inputSchema as z.ZodObject<z.ZodRawShape>)
        : z.object({});
    const outputSchema =
      tool.outputSchema &&
      typeof tool.outputSchema === "object" &&
      "shape" in tool.outputSchema
        ? (tool.outputSchema as z.ZodObject<z.ZodRawShape>)
        : undefined;

    const inputShape = inputSchema.shape;
    const outputShape = outputSchema?.shape;

    server.registerTool(
      tool.name,
      {
        description: tool.description ?? "",
        inputSchema: inputShape,
        outputSchema: outputShape,
        annotations: tool.annotations,
        _meta: tool._meta,
      },
      async (args) => {
        ctx.access.setToolName(tool.name);
        try {
          const result = await tool.execute(args, ctx);
          return {
            content: [{ type: "text" as const, text: JSON.stringify(result) }],
            structuredContent: result as { [x: string]: unknown },
          };
        } catch (error) {
          const err = error as Error;
          return {
            content: [{ type: "text" as const, text: `Error: ${err.message}` }],
            isError: true,
          };
        }
      },
    );
  }

  // Register action prompts
  const prompts = getPrompts();
  for (const prompt of prompts) {
    server.prompt(prompt.name, prompt.description, () => ({
      messages: [
        {
          role: "user" as const,
          content: { type: "text" as const, text: prompt.text },
        },
      ],
    }));
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
  ctx: MeshContext,
): Promise<McpTool[]> {
  const server = await managementMCP(ctx);
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "tools-hydration", version: "1.0.0" });
  try {
    await client.connect(clientTransport);
    const result = await client.listTools();
    return result.tools;
  } finally {
    await client.close().catch(() => {});
  }
}
