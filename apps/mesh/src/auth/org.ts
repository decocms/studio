import {
  getWellKnownCommunityRegistryConnection,
  getWellKnownRegistryConnection,
  getWellKnownSelfConnection,
} from "@decocms/mesh-sdk";
import { decoAiGatewayAdapter } from "@/ai-providers/adapters/deco-ai-gateway";
import { getBaseUrl } from "@/core/server-constants";
import { getDb } from "@/database";
import { CredentialVault } from "@/encryption/credential-vault";
import { AIProviderKeyStorage } from "@/storage/ai-provider-keys";
import { ConnectionStorage } from "@/storage/connection";
import { Permission } from "@/storage/types";
import { VirtualMCPStorage } from "@/storage/virtual";
import { fetchToolsFromMCP } from "@/tools/connection/fetch-tools";
import {
  ConnectionCreateData,
  ToolDefinition,
} from "@/tools/connection/schema";
import { installStudioPack } from "@/tools/virtual/studio-pack";
import { z } from "zod";
import { getSettings } from "../settings";
import { auth } from "./index";
import { mintGatewayJwt } from "./jwt";

export async function sendNewOrgSlackNotification(
  orgName: string,
  orgSlug: string,
  createdBy: string,
): Promise<void> {
  const settings = getSettings();
  if (!settings.slackNewOrgWebhookUrl) return;

  try {
    const database = getDb();
    const user = await database.db
      .selectFrom("user")
      .select(["email", "name"])
      .where("id", "=", createdBy)
      .executeTakeFirst();

    const userLabel = user?.name
      ? `${user.name} (${user.email})`
      : (user?.email ?? createdBy);

    await fetch(settings.slackNewOrgWebhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text: `🎉 Nova org criada no Studio: *${orgName}* (\`${orgSlug}\`)\n👤 Criada por: ${userLabel}`,
      }),
    });
  } catch (err) {
    console.error("Failed to send new org Slack notification:", err);
  }
}

interface MCPCreationSpec {
  data: ConnectionCreateData;
  permissions?: Permission;
  /** Lazy getter for tools to avoid circular dependency issues at module load time */
  getTools?: () => Promise<ToolDefinition[]> | ToolDefinition[];
}

/**
 * Get default MCP connections to create for new organizations.
 * This is a function (not a constant) to defer evaluation of ALL_TOOLS
 * until after all modules have finished initializing.
 */
function getDefaultOrgMcps(organizationId: string): MCPCreationSpec[] {
  return [
    {
      permissions: {
        self: ["*"],
      },
      // FIXME (@mcandeia) Tools are not being updated when new tools are added to the system
      // so once installed tools remains static, should have a way to update them.
      getTools: async () => {
        // Dynamically import ALL_TOOLS at call time to avoid circular dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { ALL_TOOLS } = await import("@/tools");
        return ALL_TOOLS.map(
          (tool: {
            name: string;
            inputSchema: unknown;
            outputSchema?: unknown;
            description?: string;
          }) => {
            return {
              name: tool.name,
              inputSchema: z.toJSONSchema(
                tool.inputSchema as Parameters<typeof z.toJSONSchema>[0],
                { unrepresentable: "any" },
              ) as unknown as ToolDefinition["inputSchema"],
              outputSchema: tool.outputSchema
                ? (z.toJSONSchema(
                    tool.outputSchema as Parameters<typeof z.toJSONSchema>[0],
                    { unrepresentable: "any" },
                  ) as unknown as ToolDefinition["outputSchema"])
                : undefined,
              description: tool.description,
            };
          },
        );
      },
      data: getWellKnownSelfConnection(getBaseUrl(), organizationId),
    },
    // MCP Registry (Community Registry) - public registry, no permissions required
    {
      data: getWellKnownCommunityRegistryConnection(),
    },
    // Deco Store Registry - official deco MCP registry with curated integrations (installed last)
    {
      data: getWellKnownRegistryConnection(organizationId),
    },
  ];
}

/**
 * Create default MCP connections for a new organization
 * This is deferred to run after the Better Auth request completes
 * to avoid deadlocks when issuing tokens
 */
export async function seedOrgDb(organizationId: string, createdBy: string) {
  try {
    const database = getDb();
    const settings = getSettings();
    const vault = new CredentialVault(settings.encryptionKey);
    const connectionStorage = new ConnectionStorage(database.db, vault);
    const defaultOrgMcps = getDefaultOrgMcps(organizationId);

    await Promise.all(
      defaultOrgMcps.map(async (mcpConfig) => {
        let connectionToken: string | null = null;
        if (mcpConfig.permissions) {
          const key = await auth.api.createApiKey({
            body: {
              name: `${mcpConfig.data.app_name ?? crypto.randomUUID()}-mcp`,
              userId: createdBy,
              permissions: mcpConfig.permissions,
              rateLimitEnabled: false,
              metadata: {
                organization: { id: organizationId },
                purpose: "default-org-connections",
              },
            },
          });
          connectionToken = key?.key;
        }
        // Get tools either from the lazy getter or by fetching from MCP
        const fetchResult = await fetchToolsFromMCP({
          id: "pending",
          title: mcpConfig.data.title,
          connection_type: mcpConfig.data.connection_type,
          connection_url: mcpConfig.data.connection_url,
          connection_token: mcpConfig.data.connection_token ?? connectionToken,
          connection_headers: mcpConfig.data.connection_headers,
        }).catch(() => null);
        const tools =
          (await mcpConfig.getTools?.()) ?? fetchResult?.tools ?? null;
        const configuration_scopes = fetchResult?.scopes?.length
          ? fetchResult.scopes
          : null;

        // Add org prefix only if ID doesn't already have it
        // (e.g., Deco Store already includes org prefix via WellKnownOrgMCPId)
        const connectionId = mcpConfig.data.id
          ? mcpConfig.data.id.startsWith(`${organizationId}_`)
            ? mcpConfig.data.id
            : `${organizationId}_${mcpConfig.data.id}`
          : undefined;

        await connectionStorage.create({
          ...mcpConfig.data,
          id: connectionId,
          tools,
          configuration_scopes,
          organization_id: organizationId,
          created_by: createdBy,
          connection_token: mcpConfig.data.connection_token ?? connectionToken,
        });
      }),
    );

    // Install studio pack agents (Agent Manager, Automation Manager, Connection Manager)
    try {
      const virtualMcpStorage = new VirtualMCPStorage(database.db);
      await installStudioPack(organizationId, createdBy, virtualMcpStorage);
    } catch (err) {
      console.error("Failed to install studio pack agents:", err);
    }

    if (
      settings.aiGatewayEnabled &&
      settings.studioProvisionSecretKey &&
      decoAiGatewayAdapter.provisionKey
    ) {
      try {
        const meshJwt = await mintGatewayJwt(createdBy);
        const apiKey = await decoAiGatewayAdapter.provisionKey(
          meshJwt,
          organizationId,
        );
        const aiProviderKeyStorage = new AIProviderKeyStorage(
          database.db,
          vault,
        );
        await aiProviderKeyStorage.upsert({
          providerId: "deco",
          label: "Auto-provisioned",
          apiKey,
          organizationId,
          createdBy,
        });
      } catch (err) {
        console.error("Failed to auto-provision Deco AI Gateway key:", err);
      }
    }
  } catch (err) {
    console.error("Error creating default MCP connections:", err);
  }
}
