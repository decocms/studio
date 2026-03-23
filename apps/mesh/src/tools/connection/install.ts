/**
 * CONNECTION_INSTALL Tool
 *
 * Simplified AI-driven connection install with duplicate checking and needs_auth guidance.
 */

import { WellKnownOrgMCPId } from "@decocms/mesh-sdk";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/mesh-context";
import { getMcpListCache } from "../../mcp-clients/mcp-list-cache";
import { fetchToolsFromMCP } from "./fetch-tools";

const InstallInputSchema = z.object({
  title: z.string().describe("Human-readable name for the connection"),
  connection_url: z.string().describe("URL of the MCP server to connect to"),
  description: z.string().optional().describe("Description of the connection"),
  icon: z.string().optional().describe("Icon URL for the connection"),
  app_name: z.string().optional().describe("Associated app name"),
  app_id: z.string().optional().describe("Associated app ID"),
  connection_type: z
    .enum(["HTTP", "SSE", "Websocket"])
    .optional()
    .default("HTTP")
    .describe("Connection type (defaults to HTTP)"),
  id: z.string().optional().describe("Optional pre-generated connection ID"),
  connection_token: z
    .string()
    .optional()
    .describe("Authentication token for the connection"),
  connection_headers: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Custom headers or connection parameters"),
  oauth_config: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("OAuth configuration"),
  configuration_state: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Configuration state"),
  configuration_scopes: z
    .array(z.string())
    .optional()
    .describe("Configuration scopes"),
  metadata: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Additional metadata for the connection"),
});

const InstallOutputSchema = z.object({
  connection_id: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  connection_url: z.string().nullable(),
  status: z.string(),
  needs_auth: z.boolean(),
  is_existing: z.boolean(),
  message: z.string(),
});

export const CONNECTION_INSTALL = defineTool({
  name: "CONNECTION_INSTALL",
  description:
    "Install a new MCP connection. Checks for duplicates by URL, validates the endpoint, detects auth requirements, and creates the connection. Returns whether authentication is needed.",
  annotations: {
    title: "Install Connection",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: InstallInputSchema,
  outputSchema: InstallOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to install connection");
    }

    // Check for duplicate connections by URL or app_name
    const existing = await ctx.storage.connections.list(organization.id);
    const duplicate = existing.find(
      (c: { connection_url?: string | null; app_name?: string | null }) =>
        c.connection_url === input.connection_url ||
        (input.app_name && c.app_name === input.app_name),
    );
    if (duplicate) {
      const dupConn = duplicate as {
        id: string;
        title: string;
        icon: string | null;
        connection_url: string | null;
        status: string;
        connection_token: string | null;
        oauth_config: unknown;
        configuration_scopes: string[] | null;
        configuration_state: unknown;
        tools: { name: string }[] | null;
      };

      // Check if the existing connection needs auth
      const hasToken = !!dupConn.connection_token;
      const hasOAuth = !!dupConn.oauth_config;
      const hasScopes =
        Array.isArray(dupConn.configuration_scopes) &&
        dupConn.configuration_scopes.length > 0;
      const hasConfigState =
        dupConn.configuration_state != null &&
        typeof dupConn.configuration_state === "object" &&
        Object.keys(dupConn.configuration_state as object).length > 0;
      const hasMcpConfigTool =
        Array.isArray(dupConn.tools) &&
        dupConn.tools.some((t) => t.name === "MCP_CONFIGURATION");

      const needsAuth =
        (hasOAuth && !hasToken) ||
        (hasScopes && !hasConfigState) ||
        hasMcpConfigTool;

      return {
        connection_id: dupConn.id,
        title: dupConn.title,
        icon: dupConn.icon ?? null,
        connection_url: dupConn.connection_url ?? null,
        status: dupConn.status,
        needs_auth: needsAuth,
        is_existing: true,
        message: needsAuth
          ? `Connection "${dupConn.title}" already exists but needs authentication. Please authenticate it.`
          : `Connection "${dupConn.title}" already exists and is ready to use.`,
      };
    }

    // Validate endpoint by fetching tools
    const fetchResult = await fetchToolsFromMCP({
      id: input.id ?? `pending-${Date.now()}`,
      title: input.title,
      connection_type: input.connection_type ?? "HTTP",
      connection_url: input.connection_url,
      connection_token: input.connection_token ?? null,
      connection_headers: (input.connection_headers as never) ?? null,
    }).catch(() => null);

    const tools = fetchResult?.tools?.length ? fetchResult.tools : null;
    const configurationScopes =
      input.configuration_scopes ??
      (fetchResult?.scopes?.length ? fetchResult.scopes : null);

    // Detect auth requirement from scopes or MCP_CONFIGURATION tool presence
    const hasScopes = !!configurationScopes && configurationScopes.length > 0;
    const hasMcpConfigTool =
      tools?.some((t) => t.name === "MCP_CONFIGURATION") ?? false;
    const needsAuth = hasScopes || hasMcpConfigTool;

    // Create connection
    const connection = await ctx.storage.connections.create({
      ...(input.id ? { id: input.id } : {}),
      title: input.title,
      connection_url: input.connection_url,
      connection_type: input.connection_type ?? "HTTP",
      description: input.description ?? null,
      icon: input.icon ?? null,
      app_name: input.app_name ?? null,
      app_id: input.app_id ?? null,
      organization_id: organization.id,
      created_by: userId,
      tools,
      configuration_scopes: configurationScopes,
      connection_token: input.connection_token ?? null,
      connection_headers: (input.connection_headers as never) ?? null,
      oauth_config: (input.oauth_config as never) ?? null,
      configuration_state: (input.configuration_state as never) ?? null,
      metadata: needsAuth
        ? { ...(input.metadata ?? {}), needs_auth: true }
        : ((input.metadata as never) ?? null),
    });

    // Populate NATS KV cache with fetched tools
    if (tools && tools.length > 0) {
      const cache = getMcpListCache();
      if (cache) {
        cache.set("tools", connection.id, tools).catch(() => {});
      }
    }

    // Publish connection.created event
    await ctx.eventBus.publish(
      organization.id,
      WellKnownOrgMCPId.SELF(organization.id),
      {
        type: "connection.created",
        data: connection,
      },
    );

    return {
      connection_id: connection.id,
      title: connection.title,
      icon: connection.icon ?? null,
      connection_url: connection.connection_url ?? null,
      status: connection.status,
      needs_auth: needsAuth,
      is_existing: false,
      message: needsAuth
        ? `Connection "${connection.title}" installed successfully but needs authentication. Use CONNECTION_AUTHENTICATE to show the auth card.`
        : `Connection "${connection.title}" installed and ready to use.`,
    };
  },
});
