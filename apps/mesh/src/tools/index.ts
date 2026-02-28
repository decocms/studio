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
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import * as ApiKeyTools from "./apiKeys";
import * as CodeExecutionTools from "./code-execution";
import * as ConnectionTools from "./connection";
import * as DatabaseTools from "./database";
import * as EventBusTools from "./eventbus";
import * as VirtualMCPTools from "./virtual";
import * as VirtualToolTools from "./virtual-tool";
import * as MonitoringTools from "./monitoring";
import * as MonitoringDashboardTools from "./monitoring-dashboard";
import * as OrganizationTools from "./organization";
import * as ProjectTools from "./projects";
import * as TagTools from "./tags";
import * as ThreadTools from "./thread";
import * as UserTools from "./user";
import * as UIWidgetTools from "./ui-widgets";
import {
  listUIWidgetResources,
  getUIWidgetResource,
} from "./ui-widgets/resources.ts";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps";
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

  // Virtual Tool collection tools
  VirtualToolTools.COLLECTION_VIRTUAL_TOOLS_CREATE,
  VirtualToolTools.COLLECTION_VIRTUAL_TOOLS_LIST,
  VirtualToolTools.COLLECTION_VIRTUAL_TOOLS_GET,
  VirtualToolTools.COLLECTION_VIRTUAL_TOOLS_UPDATE,
  VirtualToolTools.COLLECTION_VIRTUAL_TOOLS_DELETE,

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

  // Code Execution tools
  CodeExecutionTools.CODE_EXECUTION_SEARCH_TOOLS,
  CodeExecutionTools.CODE_EXECUTION_DESCRIBE_TOOLS,
  CodeExecutionTools.CODE_EXECUTION_RUN_CODE,
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

  // Project tools
  ProjectTools.PROJECT_LIST,
  ProjectTools.PROJECT_GET,
  ProjectTools.PROJECT_CREATE,
  ProjectTools.PROJECT_UPDATE,
  ProjectTools.PROJECT_DELETE,
  ProjectTools.PROJECT_PLUGIN_CONFIG_GET,
  ProjectTools.PROJECT_PLUGIN_CONFIG_UPDATE,

  // UI Widget tools (MCP Apps)
  UIWidgetTools.UI_COUNTER,
  UIWidgetTools.UI_METRIC,
  UIWidgetTools.UI_PROGRESS,
  UIWidgetTools.UI_GREETING,
  UIWidgetTools.UI_CHART,
  UIWidgetTools.UI_TIMER,
  UIWidgetTools.UI_STATUS,
  UIWidgetTools.UI_QUOTE,
  UIWidgetTools.UI_SPARKLINE,
  UIWidgetTools.UI_CODE,
  UIWidgetTools.UI_CONFIRMATION,
  UIWidgetTools.UI_JSON_VIEWER,
  UIWidgetTools.UI_TABLE,
  UIWidgetTools.UI_DIFF,
  UIWidgetTools.UI_TODO,
  UIWidgetTools.UI_MARKDOWN,
  UIWidgetTools.UI_IMAGE,
  UIWidgetTools.UI_FORM_RESULT,
  UIWidgetTools.UI_ERROR,
  UIWidgetTools.UI_NOTIFICATION,
  UIWidgetTools.UI_AVATAR,
  UIWidgetTools.UI_SWITCH,
  UIWidgetTools.UI_SLIDER,
  UIWidgetTools.UI_RATING,
  UIWidgetTools.UI_KBD,
  UIWidgetTools.UI_STATS_GRID,
  UIWidgetTools.UI_AREA_CHART,
  UIWidgetTools.UI_CALENDAR,
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
    { name: "mcp-mesh-management", version: "1.0.0" },
    { capabilities: { tools: {}, resources: {} } },
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

  // Register UI widget resources
  const uiResources = listUIWidgetResources();
  for (const r of uiResources) {
    const resource = getUIWidgetResource(r.uri);
    if (resource && (resource.html || resource.path)) {
      const content = resource.html ?? resource.path ?? "";
      server.resource(
        r.name,
        r.uri,
        {
          description: r.description,
          mimeType: RESOURCE_MIME_TYPE,
        },
        async () => ({
          contents: [
            {
              uri: r.uri,
              mimeType: RESOURCE_MIME_TYPE,
              text: content,
            },
          ],
        }),
      );
    }
  }

  return server;
};
