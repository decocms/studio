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
});

const InstallOutputSchema = z.object({
  connection_id: z.string(),
  title: z.string(),
  icon: z.string().nullable(),
  connection_url: z.string().nullable(),
  status: z.string(),
  needs_auth: z.boolean(),
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

    // Check for duplicate connections by URL
    const existing = await ctx.storage.connections.list(organization.id);
    const duplicate = existing.find(
      (c: { connection_url?: string | null }) =>
        c.connection_url === input.connection_url,
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
        message: needsAuth
          ? `Connection "${dupConn.title}" already exists but needs authentication. Please authenticate it.`
          : `Connection "${dupConn.title}" already exists and is ready to use.`,
      };
    }

    // Validate endpoint by fetching tools
    const fetchResult = await fetchToolsFromMCP({
      id: `pending-${Date.now()}`,
      title: input.title,
      connection_type: input.connection_type ?? "HTTP",
      connection_url: input.connection_url,
      connection_token: null,
      connection_headers: null,
    }).catch(() => null);

    const tools = fetchResult?.tools?.length ? fetchResult.tools : null;
    const configurationScopes = fetchResult?.scopes?.length
      ? fetchResult.scopes
      : null;

    // Detect auth requirement from scopes or MCP_CONFIGURATION tool presence
    const hasScopes = !!configurationScopes && configurationScopes.length > 0;
    const hasMcpConfigTool =
      tools?.some((t) => t.name === "MCP_CONFIGURATION") ?? false;
    const needsAuth = hasScopes || hasMcpConfigTool;

    // Create connection
    const connection = await ctx.storage.connections.create({
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
      metadata: needsAuth ? { needs_auth: true } : null,
    });

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
      message: needsAuth
        ? `Connection "${connection.title}" installed successfully but needs authentication. Use CONNECTION_AUTHENTICATE to show the auth card.`
        : `Connection "${connection.title}" installed and ready to use.`,
    };
  },
});
