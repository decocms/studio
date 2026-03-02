import {
  getWellKnownCommunityRegistryConnection,
  getWellKnownRegistryConnection,
  getWellKnownSelfConnection,
  ORG_ADMIN_PROJECT_NAME,
  ORG_ADMIN_PROJECT_SLUG,
} from "@decocms/mesh-sdk";
import { getBaseUrl } from "@/core/server-constants";
import { isLocalMode } from "@/auth/local-mode";
import { getDb } from "@/database";
import { CredentialVault } from "@/encryption/credential-vault";
import { ConnectionStorage } from "@/storage/connection";
import { ProjectsStorage } from "@/storage/projects";
import { Permission } from "@/storage/types";
import { fetchToolsFromMCP } from "@/tools/connection/fetch-tools";
import {
  ConnectionCreateData,
  ToolDefinition,
} from "@/tools/connection/schema";
import { z } from "zod";
import { auth } from "./index";

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
              ),
              outputSchema: tool.outputSchema
                ? z.toJSONSchema(
                    tool.outputSchema as Parameters<typeof z.toJSONSchema>[0],
                    { unrepresentable: "any" },
                  )
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
    // Local Files - filesystem object storage (only in local mode)
    ...(isLocalMode()
      ? [
          {
            data: {
              id: "local-files",
              title: "Local Files",
              description: "Local filesystem storage for files and assets",
              connection_type: "HTTP" as const,
              connection_url: `${getBaseUrl()}/mcp/dev-assets`,
              icon: null,
              app_name: "@deco/local-files",
              connection_token: null,
              connection_headers: null,
              oauth_config: null,
              configuration_state: null,
              configuration_scopes: null,
              metadata: {
                isDefault: true,
                type: "local-files",
              },
            } satisfies ConnectionCreateData,
            permissions: {
              self: ["*"],
            },
          },
        ]
      : []),
  ];
}

/**
 * Create default MCP connections and org-admin project for a new organization
 * This is deferred to run after the Better Auth request completes
 * to avoid deadlocks when issuing tokens
 */
export async function seedOrgDb(organizationId: string, createdBy: string) {
  try {
    const database = getDb();
    const vault = new CredentialVault(process.env.ENCRYPTION_KEY || "");
    const connectionStorage = new ConnectionStorage(database.db, vault);
    const projectsStorage = new ProjectsStorage(database.db);
    const defaultOrgMcps = getDefaultOrgMcps(organizationId);

    // Create the org-admin project
    try {
      await projectsStorage.create({
        organizationId,
        slug: ORG_ADMIN_PROJECT_SLUG,
        name: ORG_ADMIN_PROJECT_NAME,
        description: "Organization administration and settings",
        enabledPlugins: null,
        ui: null,
      });
    } catch (projectError) {
      // Project might already exist (e.g., race condition), log and continue
      console.warn(
        "Could not create org-admin project (may already exist):",
        projectError,
      );
    }

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
        // Use the newly created API key token if available (for auth-protected endpoints)
        const effectiveToken =
          mcpConfig.data.connection_token ?? connectionToken;
        const fetchResult = await fetchToolsFromMCP({
          id: "pending",
          title: mcpConfig.data.title,
          connection_type: mcpConfig.data.connection_type,
          connection_url: mcpConfig.data.connection_url,
          connection_token: effectiveToken,
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
  } catch (err) {
    console.error("Error creating default MCP connections:", err);
  }
}
