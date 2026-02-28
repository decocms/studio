/**
 * Context Factory
 *
 * Creates MeshContext instances from HTTP requests (via Hono Context).
 * Handles:
 * - API key verification
 * - Organization scope extraction (from Better Auth)
 * - Storage adapter initialization
 * - Base URL derivation
 */

import type { Meter, Tracer } from "@opentelemetry/api";
import type { Kysely } from "kysely";
import { verifyMeshToken } from "../auth/jwt";
import { CredentialVault } from "../encryption/credential-vault";
import { getBaseUrl } from "./server-constants";
import { ConnectionStorage } from "../storage/connection";
import { VirtualMCPStorage } from "../storage/virtual";
import { SqlMonitoringStorage } from "../storage/monitoring";
import { SqlMonitoringDashboardStorage } from "../storage/monitoring-dashboards";
import { OrganizationSettingsStorage } from "../storage/organization-settings";
import { ProjectsStorage } from "../storage/projects";
import { ProjectPluginConfigsStorage } from "../storage/project-plugin-configs";
import { TagStorage } from "../storage/tags";
import type { Database, Permission } from "../storage/types";
import { UserStorage } from "../storage/user";
import { AccessControl } from "./access-control";
import type {
  BetterAuthInstance,
  BoundAuthClient,
  MeshContext,
  Timings,
} from "./mesh-context";

// ============================================================================
// Configuration
// ============================================================================

import type { EventBus } from "../event-bus/interface";

// ============================================================================
// Helper Functions
// ============================================================================

/**
 * Parse x-mesh-properties header value into a Record<string, string>.
 * The header value should be a JSON object with string values.
 * Returns undefined if the header is missing, empty, or invalid.
 */
function parsePropertiesHeader(
  headerValue: string | null | undefined,
): Record<string, string> | undefined {
  if (!headerValue) return undefined;

  try {
    const parsed = JSON.parse(headerValue);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return undefined;
    }

    // Validate all values are strings
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === "string") {
        result[key] = value;
      }
    }

    return Object.keys(result).length > 0 ? result : undefined;
  } catch {
    return undefined;
  }
}

export interface MeshContextConfig {
  db: Kysely<Database>;
  databaseType: "sqlite" | "postgres";
  auth: BetterAuthInstance;
  encryption: {
    key: string;
  };
  observability: {
    tracer: Tracer;
    meter: Meter;
  };
  eventBus: EventBus;
}

// ============================================================================
// Errors
// ============================================================================

// ============================================================================
// Types
// ============================================================================

/**
 * OAuth Session from Better Auth MCP plugin
 * Returned by auth.api.getMcpSession()
 */
interface OAuthSession {
  id: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: Date;
  refreshTokenExpiresAt: Date;
  clientId: string;
  userId: string;
  scopes: string;
  createdAt: Date;
  updatedAt: Date;
}

// ============================================================================
// Authentication Helpers
// ============================================================================

interface OrganizationContext {
  id: string;
  slug?: string;
  name?: string;
}

interface AuthenticatedUser {
  id: string;
  connectionId?: string;
  email?: string;
  name?: string;
  role?: string;
}

// Type for the hasPermission API (from @decocms/better-auth organization plugin)
type HasPermissionAPI = (params: {
  headers: Headers;
  body: { permission: Permission };
}) => Promise<{ success?: boolean; error?: unknown } | null>;

/**
 * Check if API key permissions grant access to the requested permission
 * API key permissions are a simple { resource: [tools] } map
 */
function checkApiKeyPermission(
  apiKeyPermissions: Permission,
  requestedPermission: Permission,
): boolean {
  for (const [resource, tools] of Object.entries(requestedPermission)) {
    // Check if the API key has permission for this resource
    const grantedTools = apiKeyPermissions[resource];

    // No permission for this resource at all
    if (!grantedTools || grantedTools.length === 0) {
      // Also check wildcard resource "*"
      const wildcardTools = apiKeyPermissions["*"];
      if (!wildcardTools || wildcardTools.length === 0) {
        return false;
      }
      // Check if wildcard grants the tools
      if (wildcardTools.includes("*")) {
        continue; // Wildcard grants all tools
      }
      for (const tool of tools) {
        if (!wildcardTools.includes(tool)) {
          return false;
        }
      }
      continue;
    }

    // Wildcard grants all tools for this resource
    if (grantedTools.includes("*")) {
      continue;
    }

    // Check each requested tool
    for (const tool of tools) {
      if (!grantedTools.includes(tool)) {
        return false;
      }
    }
  }

  return true;
}

/**
 * Auth context needed to create a bound auth client
 *
 * Two permission flows:
 * 1. API Key / MCP OAuth → permissions are queried and stored here
 * 2. Browser sessions → use Better Auth's hasPermission API (no stored permissions)
 */
interface AuthContext {
  headers: Headers;
  auth: BetterAuthInstance;
  role?: string; // User's role (for built-in role bypass)
  permissions?: Permission; // Permissions from API key or custom role (MCP OAuth)
  userId?: string; // User ID for server-side API key operations
}

/**
 * Create a bound auth client that encapsulates HTTP headers and auth context
 * MeshContext stays HTTP-agnostic while delegating all Better Auth calls
 *
 * Two permission flows:
 * 1. API Key / MCP OAuth → check directly against stored `permissions`
 * 2. Browser sessions → delegate to Better Auth's hasPermission API
 */
function createBoundAuthClient(ctx: AuthContext): BoundAuthClient {
  const { auth, headers, role, permissions, userId } = ctx;

  // Get hasPermission from Better Auth's organization plugin (for browser sessions)
  const hasPermissionApi = (auth.api as { hasPermission?: HasPermissionAPI })
    .hasPermission;

  return {
    hasPermission: async (
      requestedPermission: Permission,
    ): Promise<boolean> => {
      // Built-in roles bypass all permission checks
      if (
        role &&
        BUILTIN_ROLES.includes(role as (typeof BUILTIN_ROLES)[number])
      ) {
        return true;
      }

      // Flow 1: API Key / MCP OAuth - check against stored permissions
      if (permissions) {
        return checkApiKeyPermission(permissions, requestedPermission);
      }

      // Flow 2: Browser sessions - delegate to Better Auth's hasPermission API
      if (!hasPermissionApi) {
        console.error("[Auth] hasPermission API not available");
        return false;
      }

      try {
        // Check exact permission first: { resource: [tool] }
        const exactResult = await hasPermissionApi({
          headers,
          body: { permission: requestedPermission },
        });

        if (exactResult?.success === true) {
          return true;
        }

        // Check wildcard permission: { resource: ["*"] }
        // Better Auth may not handle wildcards, so we check explicitly
        const wildcardPermission: Permission = {};
        for (const resource of Object.keys(requestedPermission)) {
          wildcardPermission[resource] = ["*"];
        }

        const wildcardResult = await hasPermissionApi({
          headers,
          body: { permission: wildcardPermission },
        });

        return wildcardResult?.success === true;
      } catch (err) {
        console.error("[Auth] Permission check failed:", err);
        return false;
      }
    },

    organization: {
      create: async (data) => {
        return auth.api.createOrganization({
          headers,
          body: data,
        } as unknown as Parameters<typeof auth.api.createOrganization>[0]);
      },

      update: async (data) => {
        return auth.api.updateOrganization({
          headers,
          body: data,
        });
      },

      delete: async (organizationId) => {
        await auth.api.deleteOrganization({
          headers,
          body: { organizationId },
        });
      },

      get: async (organizationId) => {
        return auth.api.getFullOrganization({
          headers,
          query: organizationId ? { organizationId } : undefined,
        });
      },

      list: async (userId?: string) => {
        return auth.api.listOrganizations({
          headers,
          query: userId ? { userId } : undefined,
        });
      },

      addMember: async (data) => {
        return auth.api.addMember({
          headers,
          body: data,
        } as unknown as Parameters<typeof auth.api.addMember>[0]);
      },

      removeMember: async (data) => {
        await auth.api.removeMember({
          headers,
          body: data,
        });
      },

      listMembers: async (options) => {
        return auth.api.listMembers({
          headers,
          query: options
            ? {
                organizationId: options.organizationId,
                limit: options.limit,
                offset: options.offset,
              }
            : undefined,
        });
      },

      updateMemberRole: async (data) => {
        return auth.api.updateMemberRole({
          headers,
          body: data,
        } as unknown as Parameters<typeof auth.api.updateMemberRole>[0]);
      },
    },

    apiKey: {
      create: async (data) => {
        // Don't pass headers - Better Auth treats requests with headers as "client" requests
        // and blocks server-only properties like `permissions`. By not passing headers and
        // providing userId in the body, Better Auth treats this as a server-side call.
        // Note: Authorization to create API keys is already checked by ctx.access.check()
        return auth.api.createApiKey({
          body: {
            ...data,
            userId, // Required for server-side calls (no headers = no session lookup)
          },
        });
      },

      list: async () => {
        // Uses headers - Better Auth's sessionMiddleware handles this
        // enableSessionForAPIKeys: true creates a session for API key auth
        return auth.api.listApiKeys({
          headers,
        });
      },

      update: async (data) => {
        // Don't pass headers - same reason as create: enables server-only properties
        // Note: Authorization is already checked by ctx.access.check()
        return auth.api.updateApiKey({
          body: {
            ...data,
            userId, // Required for server-side calls
          },
        });
      },

      delete: async (keyId) => {
        // Uses headers - Better Auth's sessionMiddleware handles this
        // enableSessionForAPIKeys: true creates a session for API key auth
        await auth.api.deleteApiKey({
          headers,
          body: { keyId },
        });
      },
    },
  };
}

// Import built-in roles from separate module to avoid circular dependency
import { createMCPProxy } from "@/api/routes/proxy";
import { ConnectionEntity } from "@/tools/connection/schema";
import { BUILTIN_ROLES } from "../auth/roles";
import { SqlThreadStorage } from "@/storage/threads";
import { createClientPool } from "@/mcp-clients/outbound/client-pool";

/**
 * Fetch role permissions from the database
 * Returns undefined for built-in roles (they bypass permission checks)
 */
async function fetchRolePermissions(
  db: Kysely<Database>,
  organizationId: string,
  role: string,
): Promise<Permission | undefined> {
  // Built-in roles bypass permission checks
  if (BUILTIN_ROLES.includes(role as (typeof BUILTIN_ROLES)[number])) {
    return undefined;
  }

  // Query custom role permissions from the organizationRole table
  const roleRecord = await db
    .selectFrom("organizationRole")
    .select(["permission"])
    .where("organizationId", "=", organizationId)
    .where("role", "=", role)
    .executeTakeFirst();

  if (!roleRecord?.permission) {
    return undefined;
  }

  // Parse JSON permission string
  try {
    return JSON.parse(roleRecord.permission) as Permission;
  } catch {
    console.error(`[Auth] Failed to parse permissions for role: ${role}`);
    return undefined;
  }
}

/**
 * Authenticate request using either OAuth session or API key
 * Returns unified authentication data with organization context
 *
 * Two permission flows:
 * 1. API Key / MCP OAuth → permissions are queried and returned
 * 2. Browser sessions → no permissions stored (use Better Auth's hasPermission API)
 */
async function authenticateRequest(
  req: Request,
  auth: BetterAuthInstance,
  db: Kysely<Database>,
  timings: FactoryOptions["timings"] = DEFAULT_TIMINGS,
): Promise<{
  user?: AuthenticatedUser;
  role?: string;
  permissions?: Permission; // Permissions from API key or custom role (for non-browser sessions)
  apiKeyId?: string;
  organization?: OrganizationContext;
}> {
  const authHeader = req.headers.get("Authorization");

  // Try OAuth session first (getMcpSession)
  // Add X-MCP-Session-Auth header to tell the API key plugin this is an MCP OAuth session
  // so it won't try to validate the Bearer token as an API key
  try {
    const mcpHeaders = new Headers(req.headers);
    mcpHeaders.set("X-MCP-Session-Auth", "true");

    const session = await timings.measure(
      "auth_get_mcp_session",
      () =>
        auth.api.getMcpSession({
          headers: mcpHeaders,
        }) as Promise<OAuthSession | null>,
    );

    if (session) {
      const userId = session.userId;

      // For MCP OAuth sessions, we need to query the database directly
      // because getFullOrganization requires a browser session (cookies)
      // Query user's first organization membership
      const membership = await timings.measure("auth_query_membership", () =>
        db
          .selectFrom("member")
          .innerJoin("organization", "organization.id", "member.organizationId")
          .select([
            "member.role",
            "member.organizationId",
            "organization.id as orgId",
            "organization.slug as orgSlug",
            "organization.name as orgName",
          ])
          .where("member.userId", "=", userId)
          .executeTakeFirst(),
      );

      const role = membership?.role;
      const organization = membership
        ? {
            id: membership.orgId,
            slug: membership.orgSlug,
            name: membership.orgName,
          }
        : undefined;

      // Fetch role permissions for MCP OAuth sessions (non-browser)
      let permissions: Permission | undefined;
      if (membership && role) {
        permissions = await timings.measure("auth_fetch_role_permissions", () =>
          fetchRolePermissions(db, membership.organizationId, role),
        );
      }

      return {
        user: { id: userId, role },
        role,
        permissions,
        organization,
      };
    }
  } catch (error) {
    const err = error as Error;
    console.error("[Auth] OAuth session check failed:", err);
  }

  // Try Mesh JWT or API Key authentication (Bearer token)
  // These use the same header but different validation
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "").trim();

    // First, try to verify as Mesh JWT token
    // These are issued by mesh for downstream services calling back
    try {
      const meshJwtPayload = await timings.measure("auth_verify_mesh_jwt", () =>
        verifyMeshToken(token),
      );

      if (meshJwtPayload) {
        // Look up user's organization role for admin/owner bypass
        let role: string | undefined;
        const organizationId = meshJwtPayload.metadata?.organizationId;
        if (meshJwtPayload.sub && organizationId) {
          const membership = await timings.measure(
            "auth_query_membership",
            () =>
              db
                .selectFrom("member")
                .select(["member.role"])
                .where("member.userId", "=", meshJwtPayload.sub)
                .where("member.organizationId", "=", organizationId)
                .executeTakeFirst(),
          );
          role = membership?.role;
        }

        return {
          user: {
            id: meshJwtPayload.sub,
            connectionId: meshJwtPayload.metadata?.connectionId,
            role,
          },
          role,
          permissions: meshJwtPayload.permissions,
          organization: meshJwtPayload.metadata?.organizationId
            ? {
                id: meshJwtPayload.metadata?.organizationId,
              }
            : undefined,
        };
      }
    } catch {
      // Not a valid mesh JWT, continue to API key check
    }

    // Try API Key authentication
    try {
      const result = await timings.measure("auth_verify_api_key", () =>
        auth.api.verifyApiKey({ body: { key: token } }),
      );

      if (result?.valid && result.key) {
        // For API keys, organization might be embedded in metadata
        const orgMetadata = result.key.metadata?.organization as
          | OrganizationContext
          | undefined;

        // API keys have permissions stored directly on them
        const permissions = result.key.permissions as Permission | undefined;

        // Look up user's organization role for admin/owner bypass
        let role: string | undefined;
        const userId = result.key.userId;
        if (userId && orgMetadata?.id) {
          const membership = await timings.measure(
            "auth_query_membership",
            () =>
              db
                .selectFrom("member")
                .select(["member.role"])
                .where("member.userId", "=", userId)
                .where("member.organizationId", "=", orgMetadata.id)
                .executeTakeFirst(),
          );
          role = membership?.role;
        }

        return {
          apiKeyId: result.key.id,
          user: { id: result.key.userId, role }, // Include userId and role from membership
          role,
          permissions, // Store the API key's permissions
          organization: orgMetadata
            ? {
                id: orgMetadata.id,
                slug: orgMetadata.slug,
                name: orgMetadata.name,
              }
            : undefined,
        };
      }
    } catch (error) {
      const err = error as Error;
      console.error("[Auth] API key check failed:", err);
    }
  }

  try {
    // Strip the Authorization header before calling getSession.
    // We've already tried all Bearer-based auth (Mesh JWT, API key) above.
    // If we pass the Bearer token to getSession, Better Auth's API key plugin
    // will attempt to validate it as an API key and throw INVALID_API_KEY,
    // flooding logs with false-positive errors.
    const sessionHeaders = new Headers(req.headers);
    sessionHeaders.delete("Authorization");

    const session = await timings.measure("auth_get_session", () =>
      auth.api.getSession({ headers: sessionHeaders }),
    );

    if (session) {
      let organization: OrganizationContext | undefined;
      let role: string | undefined;

      if (session.session.activeOrganizationId) {
        // Get full organization data (includes members with roles)

        const orgData = await timings.measure(
          "auth_get_full_organization",
          () =>
            auth.api
              .getFullOrganization({ headers: sessionHeaders })
              .catch(() => null),
        );

        if (orgData) {
          organization = {
            id: orgData.id,
            slug: orgData.slug,
            name: orgData.name,
          };

          // Extract user's role from the members array
          const currentMember = orgData.members?.find(
            (m: { userId: string }) => m.userId === session.user.id,
          );
          role = currentMember?.role;

          // Browser sessions use Better Auth's hasPermission API
          // No need to fetch permissions - they're checked via the API
        } else {
          organization = {
            id: session.session.activeOrganizationId,
            slug: "",
            name: "",
          };
        }
      }

      return {
        user: { id: session.user.id, email: session.user.email, role },
        role,
        // No permissions - browser sessions use hasPermission API
        organization,
      };
    }
  } catch (error) {
    const err = error as Error & { body?: unknown };
    console.error(
      "[Auth] Session check failed:",
      JSON.stringify(
        { message: err.message, body: err.body, stack: err.stack },
        null,
        2,
      ),
    );
  }

  // No valid authentication found - return empty auth data
  return {
    user: undefined,
  };
}

// ============================================================================
// Context Factory
// ============================================================================

interface FactoryOptions {
  timings?: Timings;
}

type FactoryFunction = (
  req?: Request,
  options?: FactoryOptions,
) => Promise<MeshContext>;

let createContextFn: FactoryFunction;

export const ContextFactory = {
  set: (fn: FactoryFunction) => {
    createContextFn = fn;
  },
  create: async (req?: Request, options?: FactoryOptions) => {
    return await createContextFn(req, options);
  },
};

const DEFAULT_TIMINGS = {
  measure: async <T>(_name: string, cb: () => Promise<T>): Promise<T> => {
    return await cb();
  },
};

const wellKnownForwardableHeaders = ["x-hub-signature-256"];
/**
 * Create a context factory function
 *
 * The factory creates storage adapters once (singleton pattern) and
 * returns a function that creates MeshContext from Hono Context
 */
export async function createMeshContextFactory(
  config: MeshContextConfig,
): Promise<FactoryFunction> {
  // Create vault instance for credential encryption
  const vault = new CredentialVault(config.encryption.key);

  // Create storage adapters once (singleton pattern)
  const storage = {
    connections: new ConnectionStorage(config.db, vault),
    organizationSettings: new OrganizationSettingsStorage(config.db),
    monitoring: new SqlMonitoringStorage(config.db, config.databaseType),
    monitoringDashboards: new SqlMonitoringDashboardStorage(config.db),
    virtualMcps: new VirtualMCPStorage(config.db),
    users: new UserStorage(config.db),
    threads: new SqlThreadStorage(config.db),
    tags: new TagStorage(config.db),
    projects: new ProjectsStorage(config.db),
    projectPluginConfigs: new ProjectPluginConfigsStorage(config.db),
    // Note: Organizations, teams, members, roles managed by Better Auth organization plugin
    // Note: Policies handled by Better Auth permissions directly
    // Note: API keys (tokens) managed by Better Auth API Key plugin
    // Note: Token revocation handled by Better Auth (deleteApiKey)
  };

  // Return factory function
  return async (
    req?: Request,
    options?: FactoryOptions,
  ): Promise<MeshContext> => {
    const timings = options?.timings ?? DEFAULT_TIMINGS;

    // Client pool scoped to this request — reuses connections within the same
    // request cycle (e.g., virtual MCP calling multiple tools on the same connection).
    // Must NOT be a singleton — per-request auth headers (x-mesh-token JWT) get
    // baked into the transport at creation time and would go stale across requests.
    const clientPool = createClientPool();
    const connectionId = req?.headers.get("x-caller-id") ?? undefined;
    // Authenticate request (OAuth session or API key)
    const authResult = req
      ? await authenticateRequest(req, config.auth, config.db, timings)
      : { user: undefined };

    // Create bound auth client (encapsulates HTTP headers and auth context)
    const boundAuth = createBoundAuthClient({
      auth: config.auth,
      headers: req?.headers ?? new Headers(),
      role: authResult.role,
      permissions: authResult.permissions,
      userId: authResult.user?.id, // For server-side API key operations
    });

    // Build auth object for MeshContext
    const meshAuth: MeshContext["auth"] = {
      user: authResult.user,
    };

    if (authResult.apiKeyId) {
      meshAuth.apiKey = {
        id: authResult.apiKeyId,
        name: "", // Not needed for access control
        userId: "", // Not needed for access control
      };
    }

    // Organization from Better Auth (OAuth session or API key metadata)
    const organization = authResult.organization;

    // Derive base URL from request or fallback to configured base URL
    const baseUrl = req
      ? (process.env.BASE_URL ?? `${new URL(req.url).origin}`)
      : getBaseUrl();

    // Create AccessControl instance with bound auth client
    const access = new AccessControl(
      config.auth,
      meshAuth.user?.id,
      undefined, // toolName set later by defineTool
      boundAuth, // Bound auth client for permission checks
      authResult.role, // Role from session (for built-in role bypass)
      "self", // Default connectionId for management APIs (matches permission resource key)
    );

    const ctx: MeshContext = {
      timings,
      auth: meshAuth,
      connectionId,
      organization,
      storage,
      vault,
      authInstance: config.auth,
      boundAuth, // Pre-bound auth client for permission checks
      access,
      db: config.db,
      tracer: config.observability.tracer,
      meter: config.observability.meter,
      baseUrl,
      metadata: {
        requestId: crypto.randomUUID(),
        timestamp: new Date(),
        wellKnownForwardableHeaders: Object.fromEntries(
          wellKnownForwardableHeaders
            .map((header) => [header, req?.headers.get(header) ?? null])
            .filter(([_, value]) => value !== null),
        ),
        userAgent:
          req?.headers.get("x-mesh-client") ||
          req?.headers.get("User-Agent") ||
          undefined,
        ipAddress:
          (req?.headers.get("CF-Connecting-IP") ||
            req?.headers.get("X-Forwarded-For")) ??
          undefined,
        properties: parsePropertiesHeader(
          req?.headers.get("x-mesh-properties"),
        ),
      },
      eventBus: config.eventBus,
      createMCPProxy: async (conn: string | ConnectionEntity) => {
        return await createMCPProxy(conn, ctx);
      },
      getOrCreateClient: clientPool,
    };

    return ctx;
  };
}
