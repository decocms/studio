/**
 * User Sandbox Plugin - Create Session Tool
 *
 * Creates a connect session for an external user.
 * Also creates (or reuses) a Virtual MCP for this user - one per (template, external_user_id).
 */

import { z } from "zod";
import type { Kysely } from "kysely";
import type { ServerPluginToolDefinition } from "@decocms/bindings/server-plugin";
import {
  UserSandboxCreateSessionInputSchema,
  UserSandboxCreateSessionOutputSchema,
} from "./schema";
import { getPluginStorage, getConnectBaseUrl } from "./utils";
import { createAgentMetadata } from "../security";

/** Default session expiration: 7 days */
const DEFAULT_EXPIRES_IN_SECONDS = 7 * 24 * 60 * 60;

/** Type for the user_sandbox_agents linking table */
interface UserSandboxAgentRow {
  id: string;
  user_sandbox_id: string;
  external_user_id: string;
  connection_id: string;
  created_at: string;
}

/** Type for connection inserts */
interface ConnectionInsert {
  id: string;
  organization_id: string;
  created_by: string;
  title: string;
  description: string | null;
  icon: string | null;
  app_name: string | null;
  app_id: string | null;
  connection_type: string;
  connection_url: string | null;
  connection_token: string | null;
  connection_headers: string | null;
  oauth_config: string | null;
  configuration_state: string | null;
  configuration_scopes: string | null;
  metadata: string | null;
  tools: string | null;
  bindings: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

/** Database type for queries */
interface AgentDatabase {
  user_sandbox_agents: UserSandboxAgentRow;
  connections: ConnectionInsert;
}

/** Result of findOrCreateVirtualMCP operation */
interface FindOrCreateResult {
  connectionId: string;
  created: boolean;
}

/**
 * Find or create a Virtual MCP for an external user.
 * Each (template_id, external_user_id) pair gets exactly one Virtual MCP.
 *
 * Uses a linking table (user_sandbox_agents) with a UNIQUE constraint to
 * prevent race conditions. The constraint ensures only one agent per
 * (user_sandbox_id, external_user_id) pair at the database level.
 *
 * Algorithm:
 * 1. Check if agent already exists (fast path)
 * 2. If not, create connection + linking row in a transaction
 * 3. Handle race condition by catching unique constraint violation
 */
async function findOrCreateVirtualMCP(
  db: Kysely<unknown>,
  organizationId: string,
  createdBy: string,
  templateId: string,
  externalUserId: string,
  agentTitle: string,
  agentInstructions: string | null,
  toolSelectionMode: "inclusion" | "exclusion",
): Promise<FindOrCreateResult> {
  const typedDb = db as Kysely<AgentDatabase>;

  // Step 1: Check if agent already exists (fast path for common case)
  const existing = await typedDb
    .selectFrom("user_sandbox_agents")
    .select("connection_id")
    .where("user_sandbox_id", "=", templateId)
    .where("external_user_id", "=", externalUserId)
    .executeTakeFirst();

  if (existing) {
    return { connectionId: existing.connection_id, created: false };
  }

  // Step 2: Create new agent in a transaction (connection first, then linking row)
  const now = new Date().toISOString();
  const linkingId = `usa_${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`;
  const connectionId = `vir_${Date.now().toString(36)}${crypto.randomUUID().replace(/-/g, "").substring(0, 8)}`;

  try {
    await typedDb.transaction().execute(async (trx) => {
      // Create the connection first
      await trx
        .insertInto("connections")
        .values({
          id: connectionId,
          organization_id: organizationId,
          created_by: createdBy,
          title: agentTitle,
          description: agentInstructions,
          icon: null,
          app_name: null,
          app_id: null,
          connection_type: "VIRTUAL",
          connection_url: `virtual://${connectionId}`,
          connection_token: null,
          connection_headers: JSON.stringify({
            tool_selection_mode: toolSelectionMode,
          }),
          oauth_config: null,
          configuration_state: null,
          configuration_scopes: null,
          metadata: JSON.stringify(
            createAgentMetadata(externalUserId, templateId),
          ),
          tools: null,
          bindings: null,
          status: "active",
          created_at: now,
          updated_at: now,
        })
        .execute();

      // Then create the linking row (unique constraint prevents duplicates)
      await trx
        .insertInto("user_sandbox_agents")
        .values({
          id: linkingId,
          user_sandbox_id: templateId,
          external_user_id: externalUserId,
          connection_id: connectionId,
          created_at: now,
        })
        .execute();
    });

    return { connectionId, created: true };
  } catch (error) {
    // Step 3: Handle race condition - another request created the agent
    // Check for unique constraint violation
    const errorMessage = String(error);
    if (errorMessage.includes("duplicate key")) {
      // Another request won the race - fetch and return their agent
      const winner = await typedDb
        .selectFrom("user_sandbox_agents")
        .select("connection_id")
        .where("user_sandbox_id", "=", templateId)
        .where("external_user_id", "=", externalUserId)
        .executeTakeFirst();

      if (winner) {
        return { connectionId: winner.connection_id, created: false };
      }
    }

    // Re-throw unexpected errors
    throw error;
  }
}

export const USER_SANDBOX_CREATE_SESSION: ServerPluginToolDefinition = {
  name: "USER_SANDBOX_CREATE_SESSION",
  description:
    "Create a connect session URL for an external user. " +
    "Returns a URL that the user can visit to configure their integrations. " +
    "Also creates a unique Virtual MCP (agent) for this user if one doesn't exist.",
  inputSchema: UserSandboxCreateSessionInputSchema,
  outputSchema: UserSandboxCreateSessionOutputSchema,

  handler: async (input, ctx) => {
    const typedInput = input as z.infer<
      typeof UserSandboxCreateSessionInputSchema
    >;
    const meshCtx = ctx as {
      organization: { id: string } | null;
      auth: { user: { id: string } | null };
      access: { check: () => Promise<void> };
      db: Kysely<unknown>;
    };

    // Require organization context
    if (!meshCtx.organization) {
      throw new Error("Organization context required");
    }

    // Check access
    await meshCtx.access.check();

    const storage = getPluginStorage();

    // Verify template exists and belongs to organization
    const template = await storage.templates.findById(typedInput.templateId);
    if (!template) {
      throw new Error(`Template not found: ${typedInput.templateId}`);
    }
    if (template.organization_id !== meshCtx.organization.id) {
      throw new Error(
        "Access denied: template belongs to another organization",
      );
    }
    if (template.status !== "active") {
      throw new Error("Template is not active");
    }

    // Find or create Virtual MCP for this user (always do this first)
    const agentTitle = template.agent_title_template.replace(
      "{{externalUserId}}",
      typedInput.externalUserId,
    );
    const createdBy = template.created_by ?? meshCtx.auth.user?.id ?? "system";

    const { connectionId: agentId, created: agentCreated } =
      await findOrCreateVirtualMCP(
        meshCtx.db,
        meshCtx.organization.id,
        createdBy,
        template.id,
        typedInput.externalUserId,
        agentTitle,
        template.agent_instructions,
        template.tool_selection_mode,
      );

    // Check for existing non-expired session for this user
    const existingSession = await storage.sessions.findExisting(
      typedInput.templateId,
      typedInput.externalUserId,
    );

    if (existingSession) {
      // If existing session has no agent ID, update it with the one we just found/created
      if (!existingSession.created_agent_id) {
        await storage.sessions.update(existingSession.id, {
          created_agent_id: agentId,
        });
      }

      // Return existing session URL
      const baseUrl = getConnectBaseUrl();
      return {
        sessionId: existingSession.id,
        url: `${baseUrl}/connect/${existingSession.id}`,
        expiresAt: existingSession.expires_at,
        agentId: existingSession.created_agent_id ?? agentId,
        created: agentCreated,
      };
    }

    // Calculate expiration
    const expiresInSeconds =
      typedInput.expiresInSeconds ?? DEFAULT_EXPIRES_IN_SECONDS;
    const expiresAt = new Date(
      Date.now() + expiresInSeconds * 1000,
    ).toISOString();

    // Create new session with the agent ID already set
    const session = await storage.sessions.create({
      template_id: typedInput.templateId,
      organization_id: meshCtx.organization.id,
      external_user_id: typedInput.externalUserId,
      redirect_url: template.redirect_url, // Snapshot from template
      expires_at: expiresAt,
      created_agent_id: agentId,
    });

    const baseUrl = getConnectBaseUrl();

    return {
      sessionId: session.id,
      url: `${baseUrl}/connect/${session.id}`,
      expiresAt: session.expires_at,
      agentId,
      created: agentCreated,
    };
  },
};
