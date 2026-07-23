import {
  getWellKnownCommunityRegistryConnection,
  getWellKnownRegistryConnection,
  getWellKnownSelfConnection,
} from "@decocms/shared/sdk";
import { decoAiGatewayAdapter } from "@/ai-providers/adapters/deco-ai-gateway";
import { getBaseUrl } from "@/core/server-constants";
import { getDb } from "@/database";
import { CredentialVault } from "@/encryption/credential-vault";
import { AIProviderKeyStorage } from "@/storage/ai-provider-keys";
import { ConnectionStorage } from "@/storage/connection";
import { OrganizationBillingStorage } from "@/storage/organization-billing";
import {
  benefitsSyncEnabled,
  enqueueBenefitsSync,
} from "@/billing/sync-org-benefits";
import { Permission } from "@/storage/types";
import { fetchToolsFromMCP } from "@/tools/connection/fetch-tools";
import {
  ConnectionCreateData,
  ToolDefinition,
} from "@/tools/connection/schema";
import { z } from "zod";
import { getSettings } from "../settings";
import { auth } from "./index";
import { enqueueInstallStudioPack } from "./install-studio-pack-workflow";
import { mintGatewayJwt } from "./jwt";

interface MCPCreationSpec {
  data: ConnectionCreateData;
  permissions?: Permission;
  /** Lazy getter for tools to avoid circular dependency issues at module load time */
  getTools?: () => Promise<ToolDefinition[]> | ToolDefinition[];
}

/**
 * Get default MCP connections to create for new organizations.
 * This is a function (not a constant) to defer evaluation of CORE_TOOLS
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
        // Dynamically import CORE_TOOLS at call time to avoid circular dependency
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { CORE_TOOLS } = await import("@/tools");
        return CORE_TOOLS.map(
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
 * Drop a user's paid seat (if any) + log the transition. Called from the
 * afterAddMember / afterRemoveMember organization hooks — see
 * OrganizationBillingStorage.releaseSeat for the invariant this maintains.
 */
export async function releaseSeat(
  organizationId: string,
  userId: string,
  changedBy: string,
): Promise<void> {
  const database = getDb();
  const storage = new OrganizationBillingStorage(database.db);
  // The paid-seat count changed, so the benefits it buys change too. The
  // pending marker commits with the release; the DBOS workflow + scheduled
  // sweep deliver the gateway grant durably. Enqueue is fail-soft — a failed
  // enqueue is exactly what the sweep exists for.
  const { released, benefitsReferenceId } = await storage.releaseSeat(
    organizationId,
    userId,
    changedBy,
    { markBenefitsPending: benefitsSyncEnabled() },
  );
  if (!released || !benefitsReferenceId) return;
  try {
    await enqueueBenefitsSync(organizationId, benefitsReferenceId, "apply");
  } catch (err) {
    console.error("Failed to enqueue benefit sync (sweep covers):", err);
  }
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

    // Billing identity FIRST (cheapest, most load-bearing): orgs created from
    // now on are legacy = false — the per-seat plan applies to them once
    // STUDIO_BILLING_ENFORCED turns on. Orgs that predate migration 139 were
    // backfilled legacy = true there. If this insert (or this whole hook)
    // fails, the missing row fails OPEN in resolveOrgFromPath (treated as
    // legacy) — never bricks the org.
    await database.db
      .insertInto("organization_billing")
      .values({ organization_id: organizationId, legacy: false })
      .onConflict((oc) => oc.column("organization_id").doNothing())
      .execute();

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

    try {
      await enqueueInstallStudioPack({ orgId: organizationId, createdBy });
    } catch (err) {
      console.error("Failed to enqueue studio pack install:", err);
    }

    if (
      settings.aiGatewayEnabled &&
      settings.studioProvisionSecretKey &&
      decoAiGatewayAdapter.provisionKey
    ) {
      try {
        const studioJwt = await mintGatewayJwt(createdBy);
        const apiKey = await decoAiGatewayAdapter.provisionKey(
          studioJwt,
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
