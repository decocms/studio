/**
 * Demo Seeder
 *
 * Consolidated module containing:
 * - Type definitions
 * - Record factory functions
 * - Generic organization seeder
 * - Shared configuration
 */

import type { Kysely } from "kysely";
import type { Database } from "../../../src/storage/types";
import { hashPassword } from "better-auth/crypto";
import { fetchToolsFromMCP } from "../../../src/tools/connection/fetch-tools";

// =============================================================================
// Shared Configuration
// =============================================================================

export const CONFIG = {
  PASSWORD: "demo123",
  USER_AGENT_DEFAULT: "mesh-demo-client/1.0",
} as const;

export const USER_AGENTS = {
  meshClient: "mesh-demo-client/1.0",
  cursorAgent: "cursor-agent/0.42.0",
  claudeDesktop: "claude-desktop/1.2.0",
  vscode: "vscode-mcp/1.0.0",
  ghCli: "gh-cli/2.40.0",
  slackBot: "slack-mcp-bot/1.0",
  notionDesktop: "notion-desktop/3.5.0",
  grainDesktop: "grain-desktop/2.1.0",
} as const;

export const TIME = {
  MINUTE: 60 * 1000,
  HOUR: 60 * 60 * 1000,
  DAY: 24 * 60 * 60 * 1000,
} as const;

// =============================================================================
// Type Definitions
// =============================================================================

export type MemberRole = "owner" | "admin" | "user";

export interface OrgUser {
  role: "admin" | "user";
  memberRole: MemberRole;
  name: string;
  email: string;
}

export interface Connection {
  title: string;
  description: string;
  icon: string;
  appName: string;
  connectionUrl: string;
  connectionToken: string | null;
  metadata: {
    provider: string;
    requiresOAuth?: boolean;
    requiresApiKey?: boolean;
    official?: boolean;
    decoHosted?: boolean;
  };
  tools?: Array<{
    name: string;
    description?: string;
    inputSchema?: Record<string, unknown>;
    outputSchema?: Record<string, unknown>;
  }>;
}

export interface Gateway {
  title: string;
  description: string;
  toolSelectionStrategy: "passthrough" | "code_execution";
  toolSelectionMode: "inclusion" | "exclusion";
  icon: string | null;
  isDefault: boolean;
  connections: string[];
}

export interface MonitoringLog {
  connectionKey: string;
  toolName: string;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  isError: boolean;
  errorMessage?: string;
  durationMs: number;
  offsetMs: number;
  userKey: string;
  userAgent: string;
  gatewayKey: string | null;
  properties?: Record<string, string>;
}

export interface OrgConfig {
  orgName: string;
  orgSlug: string;
  users: Record<string, OrgUser>;
  apiKeys?: { userKey: string; name: string }[];
  connections: Record<string, Connection>;
  gateways: Record<string, Gateway>;
  gatewayConnections?: { gatewayKey: string; connectionKey: string }[];
  logs: MonitoringLog[];
  ownerUserKey: string;
}

export interface OrgSeedResult {
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  userIds: Record<string, string>;
  userEmails: Record<string, string>;
  apiKeys: Record<string, string>;
  connectionIds: Record<string, string>;
  gatewayIds: Record<string, string>;
  logCount: number;
}

// =============================================================================
// ID Generator
// =============================================================================

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// =============================================================================
// Record Factories (internal)
// =============================================================================

function createUserRecord(
  userId: string,
  email: string,
  name: string,
  role: string,
  timestamp: string,
) {
  return {
    id: userId,
    email,
    emailVerified: 1,
    name,
    image: null,
    role,
    banned: null,
    banReason: null,
    banExpires: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createAccountRecord(
  userId: string,
  email: string,
  passwordHash: string,
  timestamp: string,
) {
  return {
    id: generateId("account"),
    userId,
    accountId: email,
    providerId: "credential",
    password: passwordHash,
    accessToken: null,
    refreshToken: null,
    accessTokenExpiresAt: null,
    refreshTokenExpiresAt: null,
    scope: null,
    idToken: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

export function createMemberRecord(
  organizationId: string,
  userId: string,
  role: MemberRole,
  timestamp: string,
) {
  return {
    id: generateId("member"),
    organizationId,
    userId,
    role,
    createdAt: timestamp,
  };
}

function createApiKeyRecord(
  userId: string,
  name: string,
  key: string,
  timestamp: string,
) {
  return {
    id: generateId("apikey"),
    name,
    userId,
    key,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function createConnectionRecord(
  connectionId: string,
  organizationId: string,
  createdBy: string,
  conn: Connection,
  timestamp: string,
  tools: unknown[] | null = null,
) {
  return {
    id: connectionId,
    organization_id: organizationId,
    created_by: createdBy,
    title: conn.title,
    description: conn.description,
    icon: conn.icon,
    app_name: conn.appName,
    app_id: null,
    connection_type: "HTTP" as const,
    connection_url: conn.connectionUrl,
    connection_token: conn.connectionToken,
    connection_headers: null,
    oauth_config: null,
    configuration_state: null,
    configuration_scopes: null,
    metadata: JSON.stringify(conn.metadata),
    tools: tools ? JSON.stringify(tools) : null,
    bindings: null,
    status: "active" as const,
    created_at: timestamp,
    updated_at: timestamp,
  };
}

function createGatewayRecord(
  gatewayId: string,
  organizationId: string,
  gateway: Gateway,
  createdBy: string,
  timestamp: string,
) {
  return {
    id: gatewayId,
    organization_id: organizationId,
    title: gateway.title,
    description: gateway.description,
    tool_selection_strategy: gateway.toolSelectionStrategy,
    tool_selection_mode: gateway.toolSelectionMode,
    icon: gateway.icon,
    status: "active" as const,
    is_default: gateway.isDefault ? 1 : 0,
    created_at: timestamp,
    updated_at: timestamp,
    created_by: createdBy,
    updated_by: null,
  };
}

function createGatewayConnectionRecord(
  gatewayId: string,
  connectionId: string,
  timestamp: string,
) {
  return {
    id: generateId("gtw_conn"),
    gateway_id: gatewayId,
    connection_id: connectionId,
    selected_tools: null,
    selected_resources: null,
    selected_prompts: null,
    created_at: timestamp,
  };
}

function createMonitoringLogRecord(
  organizationId: string,
  connectionId: string,
  connectionTitle: string,
  log: MonitoringLog,
  timestamp: string,
  userId: string,
  gatewayId: string | null,
  logIndex: number,
) {
  // Use index to ensure unique IDs when generating many logs quickly
  const timestampMs = Date.now();
  return {
    id: `log_${timestampMs}_${logIndex.toString().padStart(7, "0")}`,
    organization_id: organizationId,
    connection_id: connectionId,
    connection_title: connectionTitle,
    tool_name: log.toolName,
    input: JSON.stringify(log.input),
    output: JSON.stringify(log.output),
    is_error: log.isError ? 1 : 0,
    error_message: log.errorMessage ?? null,
    duration_ms: log.durationMs,
    timestamp,
    user_id: userId,
    request_id: `req_${timestampMs}_${logIndex.toString().padStart(7, "0")}`,
    user_agent: log.userAgent,
    gateway_id: gatewayId,
    properties: log.properties ? JSON.stringify(log.properties) : null,
  };
}

// =============================================================================
// Generic Organization Seeder
// =============================================================================

export async function createOrg(
  db: Kysely<Database>,
  config: OrgConfig,
): Promise<OrgSeedResult> {
  const now = new Date().toISOString();
  const orgId = generateId("org");

  // Generate user IDs
  const userIds: Record<string, string> = {};
  const userEmails: Record<string, string> = {};
  for (const [key, user] of Object.entries(config.users)) {
    userIds[key] = generateId("user");
    userEmails[key] = user.email;
  }

  // 1. Create Organization
  await db
    .insertInto("organization")
    .values({
      id: orgId,
      slug: config.orgSlug,
      name: config.orgName,
      createdAt: now,
    })
    .execute();

  // 2. Create Users
  const passwordHash = await hashPassword(CONFIG.PASSWORD);
  for (const [key, user] of Object.entries(config.users)) {
    await db
      // @ts-ignore: Better Auth user table
      .insertInto("user")
      .values(
        createUserRecord(userIds[key]!, user.email, user.name, user.role, now),
      )
      .execute();
  }

  // 3. Create Credential Accounts
  const accountRecords = Object.entries(config.users).map(([key, user]) =>
    createAccountRecord(userIds[key]!, user.email, passwordHash, now),
  );
  // @ts-ignore: Better Auth account table
  await db.insertInto("account").values(accountRecords).execute();

  // 4. Link Users to Organization
  const memberRecords = Object.entries(config.users).map(([key, user]) =>
    createMemberRecord(orgId, userIds[key]!, user.memberRole, now),
  );
  await db.insertInto("member").values(memberRecords).execute();

  // 5. Create API Keys
  const apiKeyResults: Record<string, string> = {};
  if (config.apiKeys?.length) {
    const apiKeyRecords = config.apiKeys.map((apiKey) => {
      const keyHash = `${config.orgSlug}_${apiKey.userKey}_${generateId("key")}`;
      apiKeyResults[apiKey.userKey] = keyHash;
      return createApiKeyRecord(
        userIds[apiKey.userKey]!,
        apiKey.name,
        keyHash,
        now,
      );
    });
    // @ts-ignore: Better Auth apikey table
    await db.insertInto("apikey").values(apiKeyRecords).execute();
  }

  // 6. Create Connections
  const connectionIds: Record<string, string> = {};
  for (const key of Object.keys(config.connections)) {
    connectionIds[key] = generateId("conn");
  }
  const ownerUserId = userIds[config.ownerUserKey]!;

  // Fetch tools dynamically for connections that don't have them defined
  const connectionRecords = await Promise.all(
    Object.entries(config.connections).map(async ([key, conn]) => {
      let tools = conn.tools ?? null;

      // If tools not provided, fetch them from the MCP server (production behavior)
      if (!tools) {
        const fetchedTools = await fetchToolsFromMCP({
          id: connectionIds[key]!,
          title: conn.title,
          connection_type: "HTTP",
          connection_url: conn.connectionUrl,
          connection_token: conn.connectionToken,
          connection_headers: null,
        }).catch((error) => {
          console.warn(
            `Failed to fetch tools for ${conn.title} (${conn.connectionUrl}):`,
            error instanceof Error ? error.message : error,
          );
          return null;
        });

        tools = fetchedTools;
      }

      return createConnectionRecord(
        connectionIds[key]!,
        orgId,
        ownerUserId,
        conn,
        now,
        tools,
      );
    }),
  );
  await db.insertInto("connections").values(connectionRecords).execute();

  // 7. Create Gateways
  const gatewayIds: Record<string, string> = {};
  for (const key of Object.keys(config.gateways)) {
    gatewayIds[key] = generateId("gtw");
  }
  const gatewayRecords = Object.entries(config.gateways).map(([key, gateway]) =>
    createGatewayRecord(gatewayIds[key]!, orgId, gateway, ownerUserId, now),
  );
  await db.insertInto("gateways").values(gatewayRecords).execute();

  // 8. Link Gateways to Connections
  if (config.gatewayConnections?.length) {
    const gwConnRecords = config.gatewayConnections.map((link) =>
      createGatewayConnectionRecord(
        gatewayIds[link.gatewayKey]!,
        connectionIds[link.connectionKey]!,
        now,
      ),
    );
    await db.insertInto("gateway_connections").values(gwConnRecords).execute();
  }

  // 9. Create Monitoring Logs
  if (config.logs.length > 0) {
    const BATCH_SIZE = 500; // SQLite has a strict limit on SQL variables per query
    const totalLogs = config.logs.length;

    console.log(
      `   📊 Inserting ${totalLogs.toLocaleString()} monitoring logs...`,
    );

    for (let i = 0; i < totalLogs; i += BATCH_SIZE) {
      const batch = config.logs.slice(i, i + BATCH_SIZE);
      const logRecords = batch.map((log, batchIndex) => {
        const timestamp = new Date(Date.now() + log.offsetMs).toISOString();
        const gatewayId = log.gatewayKey
          ? (gatewayIds[log.gatewayKey] ?? null)
          : null;
        // Use global index to ensure unique IDs across all batches
        const logIndex = i + batchIndex;
        return createMonitoringLogRecord(
          orgId,
          connectionIds[log.connectionKey]!,
          config.connections[log.connectionKey]!.title,
          log,
          timestamp,
          userIds[log.userKey]!,
          gatewayId,
          logIndex,
        );
      });
      await db.insertInto("monitoring_logs").values(logRecords).execute();

      if (totalLogs > BATCH_SIZE) {
        const progress = Math.min(i + BATCH_SIZE, totalLogs);
        const percentage = ((progress / totalLogs) * 100).toFixed(1);
        console.log(
          `      → ${progress.toLocaleString()}/${totalLogs.toLocaleString()} (${percentage}%)`,
        );
      }
    }

    console.log(`   ✅ Inserted ${totalLogs.toLocaleString()} logs`);
  }

  // 10. Create Organization Settings
  await db
    .insertInto("organization_settings")
    .values({
      organizationId: orgId,
      sidebar_items: null,
      createdAt: now,
      updatedAt: now,
    })
    .execute();

  return {
    organizationId: orgId,
    organizationName: config.orgName,
    organizationSlug: config.orgSlug,
    userIds,
    userEmails,
    apiKeys: apiKeyResults,
    connectionIds,
    gatewayIds,
    logCount: config.logs.length,
  };
}

// =============================================================================
// Cleanup Helper
// =============================================================================

export async function cleanupOrgs(
  db: Kysely<Database>,
  slugs: string[],
): Promise<void> {
  const existingOrgs = await db
    .selectFrom("organization")
    .select(["id", "slug"])
    .where("slug", "in", slugs)
    .execute();

  if (existingOrgs.length === 0) return;

  console.log(`🧹 Cleaning up ${existingOrgs.length} existing demo org(s)...`);
  const orgIds = existingOrgs.map((org) => org.id);

  await db
    .deleteFrom("monitoring_logs")
    .where("organization_id", "in", orgIds)
    .execute();

  const gatewayIds = await db
    .selectFrom("gateways")
    .select("id")
    .where("organization_id", "in", orgIds)
    .execute()
    .then((rows) => rows.map((r) => r.id));

  if (gatewayIds.length > 0) {
    await db
      .deleteFrom("gateway_connections")
      .where("gateway_id", "in", gatewayIds)
      .execute();
  }

  await db
    .deleteFrom("gateways")
    .where("organization_id", "in", orgIds)
    .execute();
  await db
    .deleteFrom("connections")
    .where("organization_id", "in", orgIds)
    .execute();
  await db
    .deleteFrom("organization_settings")
    .where("organizationId", "in", orgIds)
    .execute();

  const memberUserIds = await db
    .selectFrom("member")
    .select("userId")
    .where("organizationId", "in", orgIds)
    .execute()
    .then((rows) => rows.map((r) => r.userId));

  await db.deleteFrom("member").where("organizationId", "in", orgIds).execute();

  if (memberUserIds.length > 0) {
    // biome-ignore format: keep on single line for ts-ignore
    // @ts-ignore: Better Auth tables not in Database type
    await db.deleteFrom("apikey").where("userId", "in", memberUserIds).execute();

    // biome-ignore format: keep on single line for ts-ignore
    // @ts-ignore: Better Auth tables not in Database type
    await db.deleteFrom("account").where("userId", "in", memberUserIds).execute();

    await db.deleteFrom("user").where("id", "in", memberUserIds).execute();
  }

  await db.deleteFrom("organization").where("id", "in", orgIds).execute();
  console.log(
    `   ✅ Cleaned up: ${existingOrgs.map((o) => o.slug).join(", ")}`,
  );
}
