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
import * as AutomationTools from "./automations";
import * as UserTools from "./user";
import * as AiProvidersTools from "./ai-providers";
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
  ConnectionTools.COLLECTION_CONNECTIONS_LIST_SUMMARY,
  ConnectionTools.COLLECTION_CONNECTIONS_GET,
  ConnectionTools.COLLECTION_CONNECTIONS_UPDATE,
  ConnectionTools.COLLECTION_CONNECTIONS_DELETE,
  ConnectionTools.CONNECTION_TEST,
  ConnectionTools.CONNECTION_INSTALL,
  ConnectionTools.CONNECTION_AUTH_STATUS,
  ConnectionTools.CONNECTION_AUTHENTICATE,

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

const MANAGEMENT_MCP_INSTRUCTIONS = `You are connected to Deco Studio — an MCP control plane that manages connections, credentials, and tools for AI agents.

## What you're talking to

This MCP server (Mesh MCP) is your primary interface to Deco Studio. It exposes **all management tools** as direct MCP tool calls — connections, agents, automations, monitoring, registry, and more. You also get **CODE_EXECUTION** tools for running code against external services connected to the platform.

## Two ways to use tools

**1. Direct tool calls** — for all management/platform tools. These are the tools you see in your tool list. Call them directly by name.

**2. CODE_EXECUTION** — for calling tools from **connected external services** (Gmail, Slack, databases, etc.). These service tools aren't in your tool list — you discover and run them through the code execution sandbox.

**Rule of thumb**: If it's in your tool list, call it directly. If it's a tool from a connected service (e.g. \`gmail_send_message\`, \`slack_post_message\`), use CODE_EXECUTION.

## Your management tools (direct call)

### Connections
- **COLLECTION_CONNECTIONS_LIST_SUMMARY** — lightweight overview of all connections (name, status, tool count). **Start here** when exploring what's connected.
- **COLLECTION_CONNECTIONS_LIST** — full details including tool schemas. Use only when you need the schema.
- **COLLECTION_CONNECTIONS_CREATE/GET/UPDATE/DELETE** — CRUD for connections.
- **CONNECTION_INSTALL** — install a new connection from a URL (e.g. from the registry).
- **CONNECTION_TEST** — check if a connection is healthy and reachable.
- **CONNECTION_AUTH_STATUS** — check if a connection needs authentication.
- **CONNECTION_AUTHENTICATE** — trigger OAuth flow (shows an inline auth card the user can click).

### Agents (Virtual MCPs)
An agent bundles specific connections into a focused chat experience. When a user selects an agent, only that agent's connections and tools are available — reducing noise and keeping the AI focused.

- **COLLECTION_VIRTUAL_MCP_CREATE/GET/UPDATE/DELETE/LIST** — manage agents.
- **COLLECTION_VIRTUAL_TOOLS_CREATE/GET/UPDATE/DELETE/LIST** — add custom JS tools to an agent.

**When to create an agent vs. just run code:**
- **One-off task** ("send this email", "check my calendar") → use \`CODE_EXECUTION_RUN_CODE\` directly
- **Persistent role** ("I want a sales assistant that uses Salesforce + Gmail + Slack") → create an agent with \`COLLECTION_VIRTUAL_MCP_CREATE\`, add the relevant connections

**Custom tools (VIRTUAL_TOOLS_CREATE)** — use these when you want to **compose multiple service tools into a single, reusable tool** attached to an agent. For example, a "create_deal" tool that creates a Salesforce opportunity AND sends a Slack notification. If you're just chaining tools once, use \`CODE_EXECUTION_RUN_CODE\` instead.

### Registry (MCP marketplace)
These tools are part of your Mesh MCP — use them to search and install MCPs from the Deco Store or any configured registry:
- **REGISTRY_ITEM_SEARCH** — search for MCPs by keyword. **This is the primary search tool.**
- **COLLECTION_REGISTRY_APP_GET** — get full details including the MCP URL needed for installation.
- **COLLECTION_REGISTRY_APP_LIST/FILTERS/VERSIONS** — browse and filter the registry.
- **REGISTRY_ITEM_***, **REGISTRY_DISCOVER_TOOLS** — advanced registry management.

### Automations & events
Use automations and events together to build reactive workflows (e.g. "when I get an email, summarize it in Slack"):

- **AUTOMATION_CREATE/GET/UPDATE/DELETE/LIST** — background automations that run code when triggered.
- **AUTOMATION_TRIGGER_ADD/REMOVE** — define what triggers them (event types, webhooks, cron schedules).
- **AUTOMATION_RUN** — manually trigger an automation for testing.
- **EVENT_PUBLISH** — send events between connections. Supports \`deliverAt\` for scheduled delivery and \`cron\` for recurring events.
- **EVENT_SUBSCRIBE/UNSUBSCRIBE** — subscribe a connection to an event type.
- **EVENT_SUBSCRIPTION_LIST** — list active subscriptions.
- **EVENT_CANCEL** — cancel a recurring cron event.
- **EVENT_ACK** — acknowledge event delivery (used in retry flows).

**Common patterns:**
- **React to events**: Create an automation, add a trigger for an event type (e.g. \`email.received\`), and the automation's code runs whenever that event fires.
- **Scheduled tasks**: Use \`EVENT_PUBLISH\` with \`cron\` to create recurring events (e.g. daily digest), then subscribe an automation to process them.
- **One-shot scheduled**: Use \`EVENT_PUBLISH\` with \`deliverAt\` for a single future delivery (e.g. send a reminder in 2 hours).

### Monitoring & debugging
- **MONITORING_LOGS_LIST** — recent tool call logs across all connections. Great for debugging.
- **MONITORING_STATS** — usage statistics (calls, errors, latency).
- **MONITORING_DASHBOARD_***, **MONITORING_WIDGET_PREVIEW** — create and manage dashboards.
- **DATABASES_RUN_SQL** — run SQL against the internal database (audit logs, connection metadata, debugging).

### Organization & workspace
- **ORGANIZATION_CREATE/GET/UPDATE/DELETE/LIST** — manage organizations.
- **ORGANIZATION_MEMBER_ADD/LIST/REMOVE/UPDATE_ROLE** — team management.
- **ORGANIZATION_SETTINGS_GET/UPDATE** — org-level settings.
- **PROJECT_CREATE/GET/UPDATE/DELETE/LIST** — manage projects within organizations.
- **PROJECT_CONNECTION_ADD/LIST/REMOVE** — assign connections to projects.

### Other
- **API_KEY_CREATE/DELETE/LIST/UPDATE** — API keys for programmatic access to the platform.
- **AI_PROVIDERS_LIST/ACTIVE** — configured LLM providers.
- **AI_PROVIDER_KEY_CREATE/DELETE/LIST** — manage provider API keys (Anthropic, OpenRouter, etc.).
- **TAGS_CREATE/DELETE/LIST** — tagging system.
- **USER_GET** — current user info.

## Code execution — for already-installed connection tools

**CODE_EXECUTION tools are for calling tools from connections that are already installed and authenticated.** They are NOT for searching the registry/store — use \`REGISTRY_ITEM_SEARCH\` for that.

Use these three tools in order to interact with installed external services (Gmail, Slack, databases, etc.):

### Step 1: Search for tools from installed connections
\`\`\`
CODE_EXECUTION_SEARCH_TOOLS({ query: "gmail" })
\`\`\`
Searches tools **only from installed, authenticated connections** — not from the registry or store. If this returns empty, the connection may not be installed yet (use \`REGISTRY_ITEM_SEARCH\` + \`CONNECTION_INSTALL\`) or may be unhealthy (use \`CONNECTION_TEST\`).

### Step 2: Get schemas
\`\`\`
CODE_EXECUTION_DESCRIBE_TOOLS({ tools: ["gmail_send_email"] })
\`\`\`
Returns full input/output schemas. Check exact parameter names and types before writing code.

### Step 3: Run code
**CRITICAL**: The \`code\` parameter must be an ES module that \`export default\`s an async function receiving \`tools\` as its argument.

✅ Correct:
\`\`\`
CODE_EXECUTION_RUN_CODE({
  code: "export default async function(tools) {\\n  const result = await tools.gmail_send_email({ to: 'user@example.com', subject: 'Hello', body: 'Hi there' });\\n  return result;\\n}"
})
\`\`\`

❌ Wrong (bare return/await — will fail with syntax error):
\`\`\`
CODE_EXECUTION_RUN_CODE({
  code: "return await tools.gmail_send_email({ ... })"
})
\`\`\`

### Code execution rules

1. **Always \`export default async function(tools)\`** — this is the only accepted format
2. **Always \`return\`** the result so you can see the output
3. **Use \`await\`** for all tool calls — they are async
4. **Use bracket notation** for tool names with hyphens: \`tools["my-tool"](args)\`
5. **Wrap in try/catch** for better error messages:
   \`\`\`
   export default async function(tools) {
     try {
       return await tools.gmail_list_emails({ maxResults: 5 });
     } catch (e) {
       return { error: e.message };
     }
   }
   \`\`\`
6. **Chain multiple tools** in a single run for complex workflows:
   \`\`\`
   export default async function(tools) {
     const emails = await tools.gmail_list_emails({ maxResults: 3 });
     const summaries = emails.map(e => e.subject);
     return { count: emails.length, subjects: summaries };
   }
   \`\`\`

## Finding and installing new connections

When the user asks for capabilities that aren't connected yet (e.g. "can you send emails?"), here's the full flow:

\`\`\`
// 1. Search the registry (direct call — it's a Mesh MCP tool)
REGISTRY_ITEM_SEARCH({ query: "gmail", limit: 5 })

// 2. Get the MCP URL from the result
COLLECTION_REGISTRY_APP_GET({ id: "deco/google-gmail" })
// → returns { server: { remotes: [{ url: "https://..." }] }, ... }

// 3. Install it as a connection
CONNECTION_INSTALL({ title: "Gmail", connection_url: "https://mcp.gmail.example.com/sse", icon: "https://..." })
// → returns { connection_id: "conn_abc123", needs_auth: true }

// 4. ALWAYS call CONNECTION_AUTHENTICATE after install
CONNECTION_AUTHENTICATE({ connection_id: "conn_abc123" })
// → an auth card will appear BELOW your message. STOP here and wait for the user.
// Do NOT proceed or say "ready to use" until the user completes authentication.

// 5. After user authenticates, use the new connection's tools via CODE_EXECUTION
CODE_EXECUTION_SEARCH_TOOLS({ query: "send email" })
CODE_EXECUTION_DESCRIBE_TOOLS({ tools: ["gmail_send_message"] })
CODE_EXECUTION_RUN_CODE({ code: "export default async function(tools) { ... }" })
\`\`\`

**Important**: Always call \`CONNECTION_AUTHENTICATE\` after installing a new connection, even if the install response is ambiguous. Most external services require OAuth. The auth card appears **below your message** (never say "above"). Do NOT tell the user "ready to use" until they've clicked the auth card and authenticated. If auth fails or the user cancels, use \`CONNECTION_AUTH_STATUS\` to check state and offer to retry.

## General guidelines

- **Direct calls for platform tools, CODE_EXECUTION for service tools**: If it's in your tool list, call it directly. If it's from a connected service, use CODE_EXECUTION.
- **Explore first**: Use \`COLLECTION_CONNECTIONS_LIST_SUMMARY\` to see what's connected, \`MONITORING_STATS\` to see usage, \`MONITORING_LOGS_LIST\` to see recent activity.
- **IDs, not names**: Tools reference resources by ID. Always resolve IDs first via list/search.
- **Connections are credentials**: Each connection holds auth tokens for an external service. Service tools from connections are accessed via code execution.
- **On errors**:
  - "Not connected" / "401" → use \`CONNECTION_AUTH_STATUS\` then \`CONNECTION_AUTHENTICATE\`
  - "Tool not found" → search again with different keywords via \`CODE_EXECUTION_SEARCH_TOOLS\`
  - Schema validation errors → re-describe the tool via \`CODE_EXECUTION_DESCRIBE_TOOLS\`
  - Timeout → retry or check \`CONNECTION_TEST\``;

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
    enabledPlugins = [...merged];
  }

  // Filter tools based on enabled plugins
  // Core tools are always included, plugin tools only if their plugin is enabled
  const filteredTools = filterToolsByEnabledPlugins(ALL_TOOLS, enabledPlugins);

  // Sync the self connection's stored tools snapshot (background, fire-and-forget).
  // The self MCP connection stores a tool list at org creation time, which goes stale
  // when plugins are enabled/disabled. This keeps it current so the UI and
  // COLLECTION_CONNECTIONS_LIST show the correct tool count.
  if (ctx.organization) {
    const selfId = `${ctx.organization.id}_self`;
    const toolSnapshot = filteredTools.map((t) => ({
      name: t.name,
      description: t.description ?? "",
      inputSchema: {},
    }));
    ctx.storage.connections
      .update(selfId, { tools: toolSnapshot })
      .catch(() => {});
  }

  // Create MCP server directly
  const server = new McpServer(
    { name: "deco-studio", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: MANAGEMENT_MCP_INSTRUCTIONS,
    },
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

  return server;
};
