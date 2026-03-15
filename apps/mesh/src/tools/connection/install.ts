/**
 * CONNECTION_INSTALL Tool
 *
 * Install an MCP from the store as a new connection.
 * Simplified version of COLLECTION_CONNECTIONS_CREATE for AI-driven installs.
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

export const CONNECTION_INSTALL = defineTool({
  name: "CONNECTION_INSTALL",
  description:
    "Install an MCP from the store as a new connection. Use after CONNECTION_SEARCH_STORE to add a discovered MCP.",
  annotations: {
    title: "Install Connection",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  inputSchema: z.object({
    title: z.string().describe("Display name for the connection"),
    connection_url: z.string().url().describe("MCP server URL"),
    description: z.string().optional(),
    icon: z.string().optional().describe("Icon URL"),
    app_name: z.string().optional(),
    app_id: z.string().optional(),
    connection_type: z
      .enum(["HTTP", "SSE"])
      .optional()
      .describe("Transport type. Defaults to HTTP."),
  }),
  outputSchema: z.object({
    connection: z.object({
      id: z.string(),
      title: z.string(),
      icon: z.string().nullable(),
      status: z.enum(["active", "inactive", "error"]),
    }),
    needs_auth: z.boolean(),
    message: z.string(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to install connection");
    }

    // Check if a connection with same URL already exists
    const existing = await ctx.storage.connections.list(organization.id);
    const duplicate = existing.find(
      (c) => c.connection_url === input.connection_url,
    );
    if (duplicate) {
      return {
        connection: {
          id: duplicate.id,
          title: duplicate.title,
          icon: duplicate.icon ?? null,
          status: duplicate.status ?? "active",
        },
        needs_auth: false,
        message: `Connection "${duplicate.title}" already exists.`,
      };
    }

    // Fetch tools to validate endpoint
    const fetchResult = await fetchToolsFromMCP({
      id: `pending-${Date.now()}`,
      title: input.title,
      connection_type: input.connection_type ?? "HTTP",
      connection_url: input.connection_url,
      connection_token: null,
      connection_headers: null,
    }).catch(() => null);

    const tools = fetchResult?.tools?.length ? fetchResult.tools : null;
    const scopes = fetchResult?.scopes?.length ? fetchResult.scopes : null;

    // Create the connection
    const connection = await ctx.storage.connections.create({
      title: input.title,
      connection_type: input.connection_type ?? "HTTP",
      connection_url: input.connection_url,
      description: input.description ?? null,
      icon: input.icon ?? null,
      app_name: input.app_name ?? null,
      app_id: input.app_id ?? null,
      organization_id: organization.id,
      created_by: userId,
      connection_token: null,
      connection_headers: null,
      oauth_config: null,
      configuration_state: null,
      configuration_scopes: scopes,
      tools,
    });

    await ctx.eventBus.publish(
      organization.id,
      WellKnownOrgMCPId.SELF(organization.id),
      {
        type: "connection.created",
        data: connection,
      },
    );

    // Auth is needed if tools couldn't be fetched or server declared scopes
    const needsAuth = !fetchResult || !!scopes;

    return {
      connection: {
        id: connection.id,
        title: connection.title,
        icon: connection.icon ?? null,
        status: connection.status ?? "active",
      },
      needs_auth: needsAuth,
      message: needsAuth
        ? `Installed "${connection.title}". Authentication is required — use CONNECTION_AUTHENTICATE to show the auth UI.`
        : `Installed "${connection.title}" successfully with ${tools?.length ?? 0} tools.`,
    };
  },
});
