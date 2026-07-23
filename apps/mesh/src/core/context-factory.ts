/**
 * Context Factory
 *
 * Creates StudioContext instances from HTTP requests (via Hono Context).
 * Handles:
 * - API key verification
 * - Organization scope extraction (from Better Auth)
 * - Storage adapter initialization
 * - Base URL derivation
 */

import { SpanStatusCode, type Meter, type Tracer } from "@opentelemetry/api";
import type { Kysely } from "kysely";
import { verifyMeshToken } from "../auth/jwt";
import { CredentialVault } from "../encryption/credential-vault";
import { getSettings } from "../settings";
import { getBaseUrl } from "./server-constants";
import { ConnectionStorage } from "../storage/connection";
import { ConnectionCredentialVaultStorage } from "../storage/connection-credential-vault";
import {
  createRequestCachedVirtualMcps,
  VirtualMCPStorage,
} from "../storage/virtual";
import {
  SqlMonitoringStorage,
  type SqlDialect,
} from "../storage/monitoring-sql";
import {
  createMonitoringEngine,
  ClickHouseClientEngine,
  DuckDBEngine,
  buildOtlpFlatSource,
} from "../monitoring/query-engine";
import type {
  QueryEngine,
  DuckDBGcsConfig,
  MonitoringDateRange,
} from "../monitoring/query-engine";
import { getLogsDir, getMetricsDir } from "../monitoring/schema";
import { OrganizationSettingsStorage } from "../storage/organization-settings";
import { VirtualMcpPluginConfigsStorage } from "../storage/virtual-mcp-plugin-configs";
import { createAutomationsStorage } from "../storage/automations";
import { KyselyTriggerCallbackTokenStorage } from "../storage/trigger-callback-tokens";
import { BrandContextStorage } from "../storage/brand-context";
import { OrganizationDomainStorage } from "../storage/organization-domains";
import { OrganizationJoinRequestStorage } from "../storage/organization-join-requests";
import { KyselyKVStorage } from "../storage/kv";
import { KyselyInterestsStorage } from "../storage/interests";
import { OrgSsoConfigStorage } from "../storage/org-sso-config";
import { OrgSsoSessionStorage } from "../storage/org-sso-sessions";
import {
  RegistryItemStorage,
  PublishRequestStorage,
  PublishApiKeyStorage,
  MonitorRunStorage,
  MonitorResultStorage,
  MonitorConnectionStorage,
} from "../storage/registry";
import type { PrivateRegistryDatabase } from "../storage/registry/types";
import { TagStorage } from "../storage/tags";
import type { Database, Permission } from "../storage/types";
import { UserStorage } from "../storage/user";
import { AgentSandboxSessionStorage } from "../storage/agent-sandbox-sessions";
import { AccessControl } from "./access-control";
import { buildWildcardPermission } from "./permission-wildcard";
import { isOrgArchived } from "./org-archived";
import type {
  BetterAuthInstance,
  BoundAuthClient,
  StudioContext,
  Timings,
} from "./studio-context";

// ============================================================================
// Configuration
// ============================================================================

import type { MemberRoleCache } from "../auth/member-role-cache";

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

export interface StudioContextConfig {
  db: Kysely<Database>;
  auth: BetterAuthInstance;
  encryption: {
    key: string;
  };
  observability: {
    tracer: Tracer;
    meter: Meter;
  };
  modelListCache?: ModelListCache;
  providerKeyCache?: ProviderKeyCache;
  memberRoleCache?: MemberRoleCache;
  linkStatusProbe?: import("@/links/tunnel-status-probe").LinkStatusProbe;
  /**
   * Publishes a control frame to a user's link control channel (delegates to
   * the app's CancelBroadcast). Required for LINK_DISCONNECT; tests may omit.
   */
  publishLinkControlFrame?: StudioContext["publishLinkControlFrame"];
  /**
   * Test-only escape hatch: pre-built monitoring + metric engines. When
   * provided, skips the `@duckdb/node-api` import path that otherwise
   * runs in dev/test (when no `clickhouseUrl` is set). DuckDB's native
   * binding triggers a Bun teardown crash (SIGSEGV/SIGILL/SIGABRT) on
   * process exit, even on 1.3.14 / 1.4-canary. Production never sets
   * this — it either has a real `clickhouseUrl` or wants the real
   * DuckDB engine.
   */
  monitoringEngines?: {
    monitoringEngine: QueryEngine;
    metricEngine: QueryEngine;
  };
}

// ============================================================================
// Errors
// ============================================================================

// ============================================================================
// Types
// ============================================================================

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
  emailVerified?: boolean;
  name?: string;
  image?: string;
  role?: string;
}

/**
 * Extract the canonical organization slug from an org-scoped API path.
 * Header hints are still supported for legacy, unscoped routes, but the URL
 * path is authoritative whenever it is present.
 */
function getOrgSlugFromRequestPath(req: Request): string | undefined {
  try {
    const segments = new URL(req.url).pathname.split("/").filter(Boolean);
    if (segments[0] === "api" && segments[1]) {
      return decodeURIComponent(segments[1]);
    }
  } catch {
    // Fall through to legacy header/single-membership resolution.
  }
  return undefined;
}

// Type for the hasPermission API (from @decocms/better-auth organization plugin)
type HasPermissionAPI = (params: {
  headers: Headers;
  body: { permission: Permission; organizationId?: string };
}) => Promise<{ success?: boolean; error?: unknown } | null>;

/**
 * Auth context needed to create a bound auth client
 *
 * Two permission flows:
 * 1. API Key / MCP OAuth → permissions are queried and stored here
 * 2. Browser sessions → use Better Auth's hasPermission API (no stored permissions)
 */
export interface AuthContext {
  headers: Headers;
  auth: BetterAuthInstance;
  role?: string; // User's role (for built-in role bypass)
  permissions?: Permission; // Permissions from API key or custom role (MCP OAuth)
  userId?: string; // User ID for server-side API key operations
  apiKeyId?: string; // Set when the principal authenticated with an API key
}

/**
 * Create a bound auth client that encapsulates HTTP headers and auth context
 * StudioContext stays HTTP-agnostic while delegating all Better Auth calls
 *
 * Two permission flows:
 * 1. API Key / MCP OAuth → check directly against stored `permissions`
 * 2. Browser sessions → delegate to Better Auth's hasPermission API
 */
export function createBoundAuthClient(ctx: AuthContext): BoundAuthClient {
  const { auth, headers, role, permissions, userId, apiKeyId } = ctx;

  // An API key is authorized SOLELY by its own stored allowlist — the owner's
  // admin/owner role never widens it, or a "read-only" key minted by an admin
  // would silently act with full org power. A full-access key carries an
  // explicit wildcard. Only genuine API keys (apiKeyId present) are gated this
  // way; browser sessions, MCP OAuth, and studio JWTs keep the role-based path.
  const isApiKeyPrincipal = !!apiKeyId;

  // Get hasPermission from Better Auth's organization plugin (for browser sessions)
  const hasPermissionApi = (auth.api as { hasPermission?: HasPermissionAPI })
    .hasPermission;

  return {
    isApiKeyPrincipal,
    hasPermission: async (
      requestedPermission: Permission,
      options?: { organizationId?: string; role?: string },
    ): Promise<boolean> => {
      // API key → its allowlist IS the authorization. Checked before the role
      // bypass so the owner's role can never widen it. No allowlist → grants
      // nothing (fail-closed).
      if (isApiKeyPrincipal) {
        return checkApiKeyPermission(permissions ?? {}, requestedPermission);
      }

      // Only owner/admin bypass all permission checks (full org access). The
      // built-in `user` role is enforced like any member: it gets basic-usage
      // (granted out-of-band in AccessControl) plus its explicit Better Auth /
      // connection grants, and nothing else. See ADMIN_ROLES in auth/roles.ts.
      // `role` may be Better Auth's comma-joined multi-role string, so a
      // plain exact-match here would deny a legitimate multi-role
      // owner/admin the bypass — see `hasAdminRole`.
      if (hasAdminRole(role)) {
        return true;
      }

      // Flow 1: API Key / MCP OAuth - check against stored permissions
      if (permissions) {
        return checkApiKeyPermission(permissions, requestedPermission);
      }

      // Flow 2: Browser sessions.
      //
      // Fast path: resolve BUILT-IN roles in-memory. The caller
      // (AccessControl.checkResource) passes the member's role for the SAME
      // effective org as `organizationId`, so this matches what Better Auth
      // would resolve server-side — without two DB-backed calls. For custom /
      // multi-role / unknown roles this returns "fallback" and we drop to the
      // unchanged Better Auth path below. Admin/owner already bypassed above and
      // in AccessControl, so in practice only `user` is resolved here.
      // See auth/builtin-role-permission.ts for the full parity argument.
      const builtinDecision = resolveBuiltinRolePermission(
        options?.role,
        requestedPermission,
        getCachedBuiltinRoleStatements(),
      );
      if (builtinDecision !== "fallback") {
        return builtinDecision === "grant";
      }

      // Slow path: delegate to Better Auth's hasPermission API.
      if (!hasPermissionApi) {
        console.error("[Auth] hasPermission API not available");
        return false;
      }

      // When organizationId is provided (e.g. via path-resolved org middleware),
      // pass it to Better Auth so it overrides the session-based active org.
      // Without this, signup races in CI cause "No active organization" 403s
      // even when the path slug points at a valid org the user belongs to.
      const orgIdOverride = options?.organizationId
        ? { organizationId: options.organizationId }
        : {};

      try {
        // Check exact permission first: { resource: [tool] }
        const exactResult = await hasPermissionApi({
          headers,
          body: { permission: requestedPermission, ...orgIdOverride },
        });

        if (exactResult?.success === true) {
          return true;
        }

        // Check wildcard permission: { resource: ["*"] }
        // Better Auth's authorize() matches actions literally with no wildcard
        // expansion, so the `*` grant on a (custom) role is only reachable by
        // probing for the literal `"*"` action — a SEPARATE call from the exact
        // probe above (a merged array would be AND-matched and fail both). See
        // permission-wildcard.ts.
        const wildcardPermission = buildWildcardPermission(requestedPermission);

        const wildcardResult = await hasPermissionApi({
          headers,
          body: { permission: wildcardPermission, ...orgIdOverride },
        });

        return wildcardResult?.success === true;
      } catch (err) {
        // A 401/403 from the permission API is an expected denial (no session
        // or insufficient scope) — we already deny by returning `false`, so
        // don't log it as an error. Only surface genuinely unexpected failures
        // (5xx, network), and log the message rather than dumping the whole
        // APIError object.
        const statusCode = (err as { statusCode?: number } | null)?.statusCode;
        if (statusCode !== 401 && statusCode !== 403) {
          console.error(
            "[Auth] Permission check failed:",
            err instanceof Error ? err.message : String(err),
          );
        }
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
        // Choke point: archived (soft-deleted) orgs are invisible to every
        // API/UI surface, so filter them here — no caller of this method ever
        // sees them. A future restore flow would read archived orgs from
        // storage directly, not via this method.
        const orgs = await auth.api.listOrganizations({
          headers,
          query: userId ? { userId } : undefined,
        });
        return orgs.filter((org: (typeof orgs)[number]) => !isOrgArchived(org));
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
                filterField: options.filterField,
                filterValue: options.filterValue,
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

import { createMCPProxy } from "@/api/routes/mcp-proxy-factory";
import { ConnectionEntity } from "@/tools/connection/schema";
import { BUILTIN_ROLES, hasAdminRole } from "../auth/roles";
import { checkApiKeyPermission } from "../auth/api-key-permissions";
import {
  getCachedBuiltinRoleStatements,
  resolveBuiltinRolePermission,
} from "../auth/builtin-role-permission";
import { OrgScopedThreadStorage, SqlThreadStorage } from "@/storage/threads";
import {
  OrgScopedAsyncResearchJobStorage,
  SqlAsyncResearchJobStorage,
} from "@/storage/async-research-jobs";
import { createClientPool } from "@/mcp-clients/outbound/client-pool";
import { AIProviderKeyStorage } from "@/storage/ai-provider-keys";
import { SecretStorage } from "@/storage/secrets";
import { OrgFileConfigStorage } from "@/storage/org-file-configs";
import { OrgSiteStorage } from "@/storage/org-sites";
import { TaskBoardStorage } from "@/storage/task-board";
import { OrgFsEntryStorage } from "@/storage/org-fs";
import { OrgFs } from "@/file-storage/org-fs";
import { OAuthPkceStateStorage } from "@/storage/oauth-pkce-states";
import { AIProviderFactory } from "@/ai-providers/factory";
import type { ModelListCache } from "@/ai-providers/model-list-cache";
import type { ProviderKeyCache } from "@/storage/provider-key-cache";
import { getObjectStorageS3Service } from "../object-storage/factory";
import { createBoundObjectStorage } from "../object-storage/bound-object-storage";
import { DevObjectStorage } from "../object-storage/dev-object-storage";
import { decorateStorageWithAssetHoisting } from "../object-storage/asset-hoister";

/**
 * Fetch role permissions from the database.
 * Built-in roles have no row in the organizationRole table, so this returns
 * undefined for them. owner/admin additionally bypass all checks at runtime;
 * `user` falls through to its (intentionally empty) Better Auth role grant.
 */
export async function fetchRolePermissions(
  db: Kysely<Database>,
  organizationId: string,
  role: string,
): Promise<Permission | undefined> {
  // Built-in roles have no custom-role permission row to fetch.
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
// Tiny TTL cache for org archived-status, keyed by org id. The mesh-JWT
// (embedded name/slug) and API-key auth paths check this on every proxied
// request, so caching keeps the lookup off the hot path. Archiving is a
// one-way soft-delete, so a short TTL is plenty.
const ARCHIVED_CACHE_TTL_MS = 60_000;
const orgArchivedCache = new Map<string, { archived: boolean; at: number }>();

async function isOrgArchivedCached(
  db: Kysely<Database>,
  timings: NonNullable<FactoryOptions["timings"]>,
  organizationId: string,
  spanName: string,
): Promise<boolean> {
  const hit = orgArchivedCache.get(organizationId);
  if (hit && Date.now() - hit.at < ARCHIVED_CACHE_TTL_MS) return hit.archived;
  const orgRow = await timings.measure(spanName, () =>
    db
      .selectFrom("organization")
      .select(["metadata"])
      .where("id", "=", organizationId)
      .executeTakeFirst(),
  );
  const archived = isOrgArchived(orgRow);
  orgArchivedCache.set(organizationId, { archived, at: Date.now() });
  return archived;
}

// Read-through member-role cache; shared by the mesh-JWT and API-key auth paths.
async function resolveAndCacheRole(
  db: Kysely<Database>,
  timings: NonNullable<FactoryOptions["timings"]>,
  userId: string,
  organizationId: string,
  memberRoleCache?: MemberRoleCache,
): Promise<string | undefined> {
  const cachedRole = memberRoleCache?.get(userId, organizationId);
  if (cachedRole) return cachedRole;

  const membership = await timings.measure("auth_query_membership", () =>
    db
      .selectFrom("member")
      .select(["member.role"])
      .where("member.userId", "=", userId)
      .where("member.organizationId", "=", organizationId)
      .executeTakeFirst(),
  );
  const role = membership?.role;
  if (role) {
    memberRoleCache?.set(userId, organizationId, role);
  }
  return role;
}

/**
 * Resolve the on-behalf-of user for a self/loopback call.
 *
 * When studio calls its own management server (the `<org>_self` connection — e.g.
 * a Studio Pack agent invoking COLLECTION_VIRTUAL_MCP_CREATE), the outbound
 * request authenticates with that connection's API key (owned by the org
 * creator) but ALSO forwards the REAL acting user in an `x-mesh-token` JWT (see
 * `buildRequestHeaders`). Without honoring it, every write routed through a
 * Studio Pack agent is attributed to the org creator instead of the user who
 * actually acted (wrong `created_by`/`updated_by`).
 *
 * `x-mesh-token` is only ever set by studio's own outbound header builder, so an
 * inbound API-key request carrying one is always a self/loopback call. We use
 * the forwarded user for IDENTITY/attribution; the API key's permissions remain
 * the authorizing capability (the caller keeps `permissions`/`apiKeyId`).
 */
async function resolveOnBehalfOfUser(
  req: Request,
  db: Kysely<Database>,
  timings: NonNullable<FactoryOptions["timings"]>,
  apiKeyOrgId: string | undefined,
  memberRoleCache?: MemberRoleCache,
): Promise<AuthenticatedUser | undefined> {
  const meshToken = req.headers.get("x-mesh-token");
  if (!meshToken) return undefined;

  const payload = await timings.measure("auth_verify_onbehalf_mesh_jwt", () =>
    verifyMeshToken(meshToken),
  );
  if (!payload?.sub) return undefined;

  // Defensive: only honor a forwarded user scoped to the SAME org the API key
  // authorizes. A cross-org token (never expected for self calls) is ignored.
  const tokenOrgId = payload.metadata?.organizationId;
  if (apiKeyOrgId && tokenOrgId && tokenOrgId !== apiKeyOrgId) {
    return undefined;
  }

  // Re-resolve the actor's role for the org (authoritative + cached) rather
  // than trusting the JWT's snapshot. Authorization is unaffected either way —
  // it's decided by the API key's stored permissions, not this role — so an
  // undefined role (e.g. non-member) is harmless.
  const role = apiKeyOrgId
    ? await resolveAndCacheRole(
        db,
        timings,
        payload.sub,
        apiKeyOrgId,
        memberRoleCache,
      )
    : (payload.user?.role ?? undefined);

  return {
    id: payload.sub,
    email: payload.user?.email,
    name: payload.user?.name,
    role,
  };
}

async function authenticateRequest(
  req: Request,
  auth: BetterAuthInstance,
  db: Kysely<Database>,
  timings: FactoryOptions["timings"] = DEFAULT_TIMINGS,
  memberRoleCache?: MemberRoleCache,
): Promise<{
  user?: AuthenticatedUser;
  role?: string;
  permissions?: Permission; // Permissions from API key or custom role (for non-browser sessions)
  apiKeyId?: string;
  apiKey?: StudioContext["auth"]["apiKey"];
  tokenOrganizationId?: string;
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
        }) as Promise<{ userId: string } | null>,
    );

    if (session) {
      const userId = session.userId;

      // For MCP OAuth sessions we need to query the database directly because
      // getFullOrganization requires a browser session (cookies). The OAuth
      // grant doesn't carry org context. A canonical `/api/:org` path is
      // authoritative; legacy callers may still provide x-org-id / x-org-slug
      // headers, and we fall back to the user's only membership when neither
      // source is present. Without a deterministic hint, multi-org users would
      // get the wrong ctx.organization.
      const orgIdHint = req.headers.get("x-org-id");
      const orgSlugHint = req.headers.get("x-org-slug");
      // External MCP clients (Claude Desktop/Code) authenticate via OAuth and
      // do NOT send x-org-* headers — the org they target is in the request
      // path (`/api/:org/mcp/...`). Without honoring it, a multi-org member
      // falls through to the single-membership guard below, resolves to NO
      // role, and loses the admin/owner bypass (every connection tool call
      // 403s "Access denied"). Derive the authoritative slug from the path.
      const pathOrgSlug = getOrgSlugFromRequestPath(req);

      const membership = await timings.measure("auth_query_membership", () => {
        const base = db
          .selectFrom("member")
          .innerJoin("organization", "organization.id", "member.organizationId")
          .select([
            "member.role",
            "member.organizationId",
            "organization.id as orgId",
            "organization.slug as orgSlug",
            "organization.name as orgName",
            "organization.metadata as orgMetadata",
          ])
          .where("member.userId", "=", userId);

        // The canonical org path is authoritative. External MCP clients do not
        // send x-org-* headers, and accepting a stale header ahead of the path
        // can bind permissions to one org while the route serves another.
        if (pathOrgSlug) {
          return base
            .where("organization.slug", "=", pathOrgSlug)
            .executeTakeFirst();
        }
        if (orgIdHint) {
          return base
            .where("organization.id", "=", orgIdHint)
            .executeTakeFirst();
        }
        if (orgSlugHint) {
          return base
            .where("organization.slug", "=", orgSlugHint)
            .executeTakeFirst();
        }
        // No org hint — only resolve when the user has exactly one membership.
        // For multi-org users without a hint, return undefined so callers get
        // no org context instead of a non-deterministic pick (the previous
        // .executeTakeFirst() without ORDER BY could return any membership row
        // depending on PostgreSQL's physical row ordering).
        return base
          .orderBy("member.createdAt", "asc")
          .limit(2)
          .execute()
          .then((rows) => (rows.length === 1 ? rows[0] : undefined));
      });

      if (isOrgArchived({ metadata: membership?.orgMetadata })) {
        throw new Error("Organization is archived");
      }

      const role = membership?.role;
      const organization = membership
        ? {
            id: membership.orgId,
            slug: membership.orgSlug,
            name: membership.orgName,
          }
        : undefined;

      // Cache the role for future requests
      if (membership && role) {
        memberRoleCache?.set(userId, membership.organizationId, role);
      }

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

  // Try Studio JWT or API Key authentication (Bearer token)
  // These use the same header but different validation
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.replace("Bearer ", "").trim();

    // First, try to verify as Studio JWT token
    // These are issued by studio for downstream services calling back
    try {
      const meshJwtPayload = await timings.measure("auth_verify_mesh_jwt", () =>
        verifyMeshToken(token),
      );

      if (meshJwtPayload) {
        // Look up user's organization role for admin/owner bypass
        let role: string | undefined;
        const organizationId = meshJwtPayload.metadata?.organizationId;
        if (meshJwtPayload.sub && organizationId) {
          role = await resolveAndCacheRole(
            db,
            timings,
            meshJwtPayload.sub,
            organizationId,
            memberRoleCache,
          );
        }

        let organization: OrganizationContext | undefined;
        const metaOrgId = meshJwtPayload.metadata?.organizationId;
        if (metaOrgId) {
          const metaName = meshJwtPayload.metadata?.organizationName;
          const metaSlug = meshJwtPayload.metadata?.organizationSlug;
          if (metaName || metaSlug) {
            // Name/slug are embedded in the JWT, but we still need to verify the
            // org isn't archived — the token may have been issued before
            // deletion. Cached to keep this off the hot path.
            if (
              await isOrgArchivedCached(
                db,
                timings,
                metaOrgId,
                "auth_query_org_archived_for_mesh_jwt",
              )
            ) {
              return { user: undefined };
            }
            organization = { id: metaOrgId, name: metaName, slug: metaSlug };
          } else {
            const orgRow = await timings.measure(
              "auth_query_org_for_mesh_jwt",
              () =>
                db
                  .selectFrom("organization")
                  .select(["id", "slug", "name", "metadata"])
                  .where("id", "=", metaOrgId)
                  .executeTakeFirst(),
            );
            if (isOrgArchived(orgRow)) {
              return { user: undefined };
            }
            organization = orgRow
              ? { id: orgRow.id, slug: orgRow.slug, name: orgRow.name }
              : { id: metaOrgId };
          }
        }

        return {
          user: {
            id: meshJwtPayload.sub,
            connectionId: meshJwtPayload.metadata?.connectionId,
            role,
          },
          role,
          permissions: meshJwtPayload.permissions,
          tokenOrganizationId: organizationId,
          organization,
        };
      }
    } catch {
      // Not a valid studio JWT, continue to API key check
    }

    // Try API Key authentication
    try {
      const result = (await timings.measure("auth_verify_api_key", () =>
        auth.api.verifyApiKey({ body: { key: token } }),
      )) as {
        valid?: boolean;
        key?: {
          id: string;
          name?: string | null;
          userId: string;
          metadata?: { organization?: OrganizationContext };
          permissions?: Permission;
        };
      } | null;

      if (result?.valid && result.key) {
        // For API keys, organization might be embedded in metadata
        const orgMetadata = result.key.metadata?.organization as
          | OrganizationContext
          | undefined;

        // Block access if the org has been soft-deleted since the key was issued
        if (
          orgMetadata?.id &&
          (await isOrgArchivedCached(
            db,
            timings,
            orgMetadata.id,
            "auth_query_org_for_api_key",
          ))
        ) {
          return { user: undefined };
        }

        // API keys have permissions stored directly on them
        const permissions = result.key.permissions as Permission | undefined;

        // Look up user's organization role for admin/owner bypass
        let role: string | undefined;
        const userId = result.key.userId;
        if (userId && orgMetadata?.id) {
          role = await resolveAndCacheRole(
            db,
            timings,
            userId,
            orgMetadata.id,
            memberRoleCache,
          );
        }

        // On-behalf-of: a self/loopback call authenticates with the
        // connection's API key but forwards the real acting user in
        // `x-mesh-token`. Credit that user (attribution) while keeping the API
        // key's permissions as the authorizing capability.
        const onBehalfOf = await resolveOnBehalfOfUser(
          req,
          db,
          timings,
          orgMetadata?.id,
          memberRoleCache,
        );

        return {
          apiKeyId: result.key.id,
          // On-behalf-of fully replaces the principal (id + role) so user/role
          // stay consistent; the actor never inherits the key owner's role.
          user: onBehalfOf ?? { id: result.key.userId, role },
          role: onBehalfOf ? onBehalfOf.role : role,
          permissions, // Store the API key's permissions
          apiKey: {
            id: result.key.id,
            name: result.key.name ?? "",
            userId: result.key.userId,
            metadata: result.key.metadata as
              | Record<string, unknown>
              | undefined,
          },
          tokenOrganizationId: orgMetadata?.id,
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
      const err = error as Error & { body?: { code?: string } };
      // INVALID_API_KEY is expected here (any Bearer token is probed as an API
      // key). Better Auth's noisy ERROR+stack is suppressed in its logger; emit
      // one concise line with caller context so a flood can be traced to its
      // source. Token prefix only — never the full secret.
      const isInvalidKey =
        err.body?.code === "INVALID_API_KEY" ||
        err.message?.includes("Invalid API key");
      if (isInvalidKey) {
        console.warn("[Auth] invalid API key (Bearer)", {
          path: new URL(req.url).pathname,
          method: req.method,
          ua: req.headers.get("user-agent") ?? undefined,
          ip:
            req.headers.get("x-forwarded-for") ??
            req.headers.get("x-real-ip") ??
            undefined,
          tokenPrefix: token.slice(0, 8),
        });
      } else {
        console.error("[Auth] API key check failed:", err);
      }
    }
  }

  try {
    // Strip the Authorization header before calling getSession.
    // We've already tried all Bearer-based auth (Studio JWT, API key) above.
    // If we pass the Bearer token to getSession, Better Auth's API key plugin
    // will attempt to validate it as an API key and throw INVALID_API_KEY,
    // flooding logs with false-positive errors.
    const sessionHeaders = new Headers(req.headers);
    sessionHeaders.delete("Authorization");

    const session = (await timings.measure("auth_get_session", () =>
      auth.api.getSession({ headers: sessionHeaders }),
    )) as {
      user: {
        id: string;
        email: string;
        emailVerified: boolean;
        name?: string;
        image?: string | null;
      };
      session: { activeOrganizationId?: string };
    } | null;

    if (session) {
      let organization: OrganizationContext | undefined;
      let role: string | undefined;

      // Prefer per-request org header (x-org-id / x-org-slug) over
      // session.activeOrganizationId. The session row stores a single active
      // org shared across all browser tabs, so switching orgs in one tab
      // would otherwise leak into requests from other tabs. The frontend
      // sends x-org-id derived from the URL (/$org) on every MCP call.
      //
      // Fall back to query params on GET requests for SSE endpoints —
      // `EventSource` can't set custom headers, so SSE callers append
      // `?x-org-id=...` instead. GET-only restricts the surface to read paths
      // (mutations always have a body and never go through EventSource).
      // Membership is still verified below.
      let requestedOrgId = req.headers.get("x-org-id");
      let requestedOrgSlug = req.headers.get("x-org-slug");
      if (
        !requestedOrgId &&
        !requestedOrgSlug &&
        req.method.toUpperCase() === "GET"
      ) {
        try {
          const params = new URL(req.url).searchParams;
          requestedOrgId = params.get("x-org-id");
          requestedOrgSlug = params.get("x-org-slug");
        } catch {
          // Malformed URL — leave both null and fall through to session state
        }
      }

      if (requestedOrgId || requestedOrgSlug) {
        const membership = await timings.measure(
          "auth_query_membership_from_header",
          () => {
            let q = db
              .selectFrom("member")
              .innerJoin(
                "organization",
                "organization.id",
                "member.organizationId",
              )
              .select([
                "member.role",
                "organization.id as orgId",
                "organization.slug as orgSlug",
                "organization.name as orgName",
                "organization.metadata as orgMetadata",
              ])
              .where("member.userId", "=", session.user.id);
            if (requestedOrgId) {
              q = q.where("organization.id", "=", requestedOrgId);
            } else if (requestedOrgSlug) {
              q = q.where("organization.slug", "=", requestedOrgSlug);
            }
            return q.executeTakeFirst();
          },
        );

        if (isOrgArchived({ metadata: membership?.orgMetadata })) {
          throw new Error("Organization is archived");
        }

        if (membership) {
          organization = {
            id: membership.orgId,
            slug: membership.orgSlug,
            name: membership.orgName,
          };
          role = membership.role;
        }
        // If header was provided but no membership matched, leave
        // organization undefined so downstream access checks fail closed
        // (403) rather than silently falling back to session state.
      } else if (session.session.activeOrganizationId) {
        // Get full organization data (includes members with roles)

        const orgData = (await timings.measure(
          "auth_get_full_organization",
          () =>
            auth.api
              .getFullOrganization({ headers: sessionHeaders })
              .catch(() => null),
        )) as {
          id: string;
          slug: string;
          name: string;
          metadata?: Record<string, unknown> | null;
          members?: {
            userId: string;
            role?: string;
            user?: { id: string; email: string };
          }[];
          session?: { activeOrganizationId?: string };
        } | null;

        if (orgData) {
          if (isOrgArchived(orgData)) {
            throw new Error("Organization is archived");
          }

          organization = {
            id: orgData.id,
            slug: orgData.slug,
            name: orgData.name,
          };

          // Extract user's role from the members array
          const currentMember = orgData.members?.find(
            (m) => m.userId === session.user.id,
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
        user: {
          id: session.user.id,
          email: session.user.email,
          emailVerified: !!session.user.emailVerified,
          name: session.user.name,
          image: session.user.image ?? undefined,
          role,
        },
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
) => Promise<StudioContext>;

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
 * returns a function that creates StudioContext from Hono Context
 */
export async function createStudioContextFactory(
  config: StudioContextConfig,
): Promise<FactoryFunction> {
  // Create vault instance for credential encryption
  const vault = new CredentialVault(config.encryption.key);

  // Create monitoring engines (shared across requests).
  // Precedence: ClickHouse (otel_logs view) > GCS OTLP-JSON (embedded DuckDB +
  // httpfs) > local NDJSON (embedded DuckDB). The test-stub path overrides all.
  const settings = getSettings();
  const clickhouseUrl = settings.clickhouseUrl;
  const isClickHouse = !!clickhouseUrl;
  const isGcsOtlp = !isClickHouse && !!settings.monitoringS3Bucket;
  const dialect: SqlDialect = isClickHouse ? "clickhouse" : "duckdb";

  const { resolve } = await import("node:path");
  const logsBasePath = resolve(getLogsDir());
  const metricsBasePath = resolve(getMetricsDir());

  // DuckDB reads local NDJSON files; org-sharded directory layout.
  const localLogSourceFactory = (orgId: string) =>
    `read_ndjson('${logsBasePath}/${orgId}/**/*.ndjson', auto_detect=true)`;
  const localMetricSourceFactory = (orgId: string) =>
    `read_ndjson('${metricsBasePath}/${orgId}/**/*.ndjson', auto_detect=true)`;

  let monitoringEngine: QueryEngine;
  let metricEngine: QueryEngine;
  let logSourceFactory: (orgId: string, range?: MonitoringDateRange) => string;
  let metricSourceFactory: (
    orgId: string,
    range?: MonitoringDateRange,
  ) => string;
  // When true, metrics are derived from flat log rows instead of histogram
  // MetricRow files (the GCS OTLP path; see SqlMonitoringStorage).
  let metricsFromLogs = false;

  if (config.monitoringEngines) {
    // Test-only path: caller supplied stubs to avoid loading
    // `@duckdb/node-api` (whose native finalizer trips a Bun teardown
    // crash). See StudioContextConfig.monitoringEngines for the why.
    monitoringEngine = config.monitoringEngines.monitoringEngine;
    metricEngine = config.monitoringEngines.metricEngine;
    logSourceFactory = localLogSourceFactory;
    metricSourceFactory = localMetricSourceFactory;
  } else if (isClickHouse) {
    // ClickHouse reads the studio_monitoring_logs VIEW (a flat projection of the
    // OTel-native otel_logs table — provisioned manually, see
    // monitoring/clickhouse-setup.md). Metrics are derived from those same log
    // rows, so both factories point at the view.
    const clickhouseEngineOptions = settings.clickhouseMaxMemoryUsage
      ? { maxMemoryUsage: String(settings.clickhouseMaxMemoryUsage) }
      : undefined;
    monitoringEngine = new ClickHouseClientEngine(
      clickhouseUrl!,
      clickhouseEngineOptions,
    );
    metricEngine = new ClickHouseClientEngine(
      clickhouseUrl!,
      clickhouseEngineOptions,
    );
    logSourceFactory = (_orgId: string) => "studio_monitoring_logs";
    metricSourceFactory = (_orgId: string) => "studio_monitoring_logs";
  } else if (isGcsOtlp) {
    // GCS OTLP-JSON path: embedded DuckDB reads OTLP-JSON log files from the
    // bucket over the S3-compatible endpoint, flattens them to the dashboard's
    // flat columns, and derives metrics from those log rows. The flat source is
    // the same for logs and metrics; org scoping is the outer WHERE.
    const accessKeyId =
      settings.monitoringS3AccessKeyId ?? settings.s3AccessKeyId;
    const secretAccessKey =
      settings.monitoringS3SecretAccessKey ?? settings.s3SecretAccessKey;
    const extensionDirectory = settings.duckdbExtensionDirectory;
    if (!accessKeyId || !secretAccessKey || !extensionDirectory) {
      throw new Error(
        "MONITORING_S3_BUCKET is set but the GCS monitoring path is misconfigured: " +
          "MONITORING_S3_ACCESS_KEY_ID/S3_ACCESS_KEY_ID, " +
          "MONITORING_S3_SECRET_ACCESS_KEY/S3_SECRET_ACCESS_KEY, and " +
          "DUCKDB_EXTENSION_DIRECTORY are all required.",
      );
    }
    const gcs: DuckDBGcsConfig = {
      endpoint:
        settings.monitoringS3Endpoint ??
        settings.s3Endpoint ??
        "storage.googleapis.com",
      region: settings.monitoringS3Region ?? settings.s3Region,
      accessKeyId,
      secretAccessKey,
      extensionDirectory,
    };
    // One shared engine: same files for logs and log-derived metrics, so the
    // httpfs + SECRET setup runs once. Memory tuning lets constrained
    // containers cap DuckDB so the OTLP-flatten query spills instead of OOMing.
    const gcsEngine = new DuckDBEngine(gcs, {
      memoryLimit: settings.duckdbMemoryLimit,
      threads: settings.duckdbThreads,
    });
    monitoringEngine = gcsEngine;
    metricEngine = gcsEngine;

    const gcsBucket = settings.monitoringS3Bucket!;
    const gcsPrefix = settings.monitoringS3Prefix ?? "";
    // Source is rebuilt per query so the dashboard date range scopes the read to
    // the relevant year=/month=/day= partitions (the documented collector layout
    // is assumed) instead of flattening the whole prefix — the embedded-DuckDB
    // OOM cause. A range-less query still reads everything.
    const gcsSourceFactory = (_orgId: string, range?: MonitoringDateRange) =>
      buildOtlpFlatSource({ bucket: gcsBucket, prefix: gcsPrefix, range });
    logSourceFactory = gcsSourceFactory;
    metricSourceFactory = gcsSourceFactory;
    metricsFromLogs = true;
  } else {
    const { engine: me } = await createMonitoringEngine({
      basePath: getLogsDir(),
    });
    const { engine: metricE } = await createMonitoringEngine({
      basePath: getMetricsDir(),
    });
    monitoringEngine = me;
    metricEngine = metricE;
    logSourceFactory = localLogSourceFactory;
    metricSourceFactory = localMetricSourceFactory;
  }

  // Create storage adapters once (singleton pattern)
  const threadDb = new SqlThreadStorage(config.db);
  const asyncResearchJobDb = new SqlAsyncResearchJobStorage(config.db);
  const kvStorage = new KyselyKVStorage(config.db);
  const baseStorage = {
    connections: new ConnectionStorage(config.db, vault),
    connectionCredentialVault: new ConnectionCredentialVaultStorage(config.db),
    organizationSettings: new OrganizationSettingsStorage(config.db),
    monitoring: new SqlMonitoringStorage(
      monitoringEngine,
      logSourceFactory,
      metricEngine,
      metricSourceFactory,
      dialect,
      metricsFromLogs,
    ),
    virtualMcps: new VirtualMCPStorage(config.db),
    agentSandboxSessions: new AgentSandboxSessionStorage(config.db),
    users: new UserStorage(config.db),
    tags: new TagStorage(config.db),
    virtualMcpPluginConfigs: new VirtualMcpPluginConfigsStorage(config.db),
    aiProviderKeys: new AIProviderKeyStorage(
      config.db,
      vault,
      config.providerKeyCache,
    ),
    secrets: new SecretStorage(config.db, vault),
    orgFileConfigs: new OrgFileConfigStorage(config.db, vault),
    orgSites: new OrgSiteStorage(config.db),
    taskBoard: new TaskBoardStorage(config.db),
    orgFsEntries: new OrgFsEntryStorage(config.db),
    oauthPkceStates: new OAuthPkceStateStorage(config.db),
    automations: createAutomationsStorage(config.db),
    triggerCallbackTokens: new KyselyTriggerCallbackTokenStorage(config.db),
    orgSsoConfig: new OrgSsoConfigStorage(config.db, vault),
    orgSsoSessions: new OrgSsoSessionStorage(config.db),
    registry: {
      items: new RegistryItemStorage(
        config.db as unknown as Kysely<PrivateRegistryDatabase>,
      ),
      publishRequests: new PublishRequestStorage(
        config.db as unknown as Kysely<PrivateRegistryDatabase>,
      ),
      publishApiKeys: new PublishApiKeyStorage(
        config.db as unknown as Kysely<PrivateRegistryDatabase>,
      ),
      monitorRuns: new MonitorRunStorage(
        config.db as unknown as Kysely<PrivateRegistryDatabase>,
      ),
      monitorResults: new MonitorResultStorage(
        config.db as unknown as Kysely<PrivateRegistryDatabase>,
      ),
      monitorConnections: new MonitorConnectionStorage(
        config.db as unknown as Kysely<PrivateRegistryDatabase>,
      ),
    },
    brandContext: new BrandContextStorage(config.db),
    organizationDomains: new OrganizationDomainStorage(config.db),
    organizationJoinRequests: new OrganizationJoinRequestStorage(config.db),
    kv: kvStorage,
    interests: new KyselyInterestsStorage(kvStorage),
    // Note: Organizations, teams, members, roles managed by Better Auth organization plugin
    // Note: Policies handled by Better Auth permissions directly
    // Note: API keys (tokens) managed by Better Auth API Key plugin
    // Note: Token revocation handled by Better Auth (deleteApiKey)
  };

  // Return factory function
  return async (
    req?: Request,
    options?: FactoryOptions,
  ): Promise<StudioContext> => {
    const timings = options?.timings ?? DEFAULT_TIMINGS;

    // Client pool scoped to this request — reuses connections within the same
    // request cycle (e.g., virtual MCP calling multiple tools on the same connection).
    // Must NOT be a singleton — per-request auth headers (x-mesh-token JWT) get
    // baked into the transport at creation time and would go stale across requests.
    const clientPool = createClientPool();
    // Authenticate request (OAuth session or API key)
    const authResult = req
      ? await config.observability.tracer.startActiveSpan(
          "studio.auth",
          async (span) => {
            try {
              const result = await authenticateRequest(
                req,
                config.auth,
                config.db,
                timings,
                config.memberRoleCache,
              );
              span.setStatus({ code: SpanStatusCode.OK });
              return result;
            } catch (err) {
              span.setStatus({
                code: SpanStatusCode.ERROR,
                message: (err as Error).message,
              });
              span.recordException(err as Error);
              throw err;
            } finally {
              span.end();
            }
          },
        )
      : { user: undefined };

    // Resolve caller connection ID: explicit header takes priority, then fall
    // back to the connectionId embedded in the studio JWT. This ensures that
    // management tools on _self see the caller's connection ID even when the
    // runtime doesn't set x-caller-id.
    const connectionId =
      req?.headers.get("x-caller-id") ??
      authResult.user?.connectionId ??
      undefined;

    // Create bound auth client (encapsulates HTTP headers and auth context)
    const boundAuth = createBoundAuthClient({
      auth: config.auth,
      headers: req?.headers ?? new Headers(),
      role: authResult.role,
      permissions: authResult.permissions,
      userId: authResult.user?.id, // For server-side API key operations
      apiKeyId: authResult.apiKeyId, // Enables scoped-key enforcement
    });

    // Build auth object for StudioContext
    const studioAuth: StudioContext["auth"] = {
      user: authResult.user,
      tokenOrganizationId: authResult.tokenOrganizationId,
    };

    if (authResult.apiKey) {
      studioAuth.apiKey = authResult.apiKey;
    }

    // Organization from Better Auth (OAuth session or API key metadata)
    const organization = authResult.organization;

    // Derive base URL from request or fallback to configured base URL
    const baseUrl = req
      ? (getSettings().baseUrl ?? `${new URL(req.url).origin}`)
      : getBaseUrl();

    // Create AccessControl instance with bound auth client
    const access = new AccessControl(
      studioAuth.user?.id,
      undefined, // toolName set later by defineTool
      boundAuth, // Bound auth client for permission checks
      authResult.role, // Role from session (for built-in role bypass)
      "self", // Default connectionId for management APIs (matches permission resource key)
      undefined, // getToolMeta set later by defineTool
      organization?.id, // Path-resolved/auth-resolved org for permission checks
    );

    const storage = {
      ...baseStorage,
      virtualMcps: createRequestCachedVirtualMcps(baseStorage.virtualMcps),
      threads: new OrgScopedThreadStorage(threadDb, organization?.id),
      asyncResearchJobs: new OrgScopedAsyncResearchJobStorage(
        asyncResearchJobDb,
        organization?.id,
      ),
    };

    const aiProviderFactory = new AIProviderFactory(
      storage.aiProviderKeys,
      config.modelListCache,
    );

    // Create org-scoped object storage. Use S3 when configured, otherwise fall
    // back to DevObjectStorage (local filesystem) so the OBJECT_STORAGE binding
    // still resolves on self-host setups without S3.
    const s3Service = getObjectStorageS3Service();
    const objectStorage = !organization
      ? null
      : s3Service
        ? createBoundObjectStorage(s3Service, organization.id)
        : new DevObjectStorage(organization.id, baseUrl);

    // Org filesystem: path/tree view over the org-prefixed keyspace. Needs both
    // object storage and an org scope.
    const orgFs =
      organization && objectStorage
        ? new OrgFs(objectStorage, storage.orgFsEntries, organization.id)
        : null;

    // Hoist inline data: media to object storage on connection/virtual-MCP
    // writes so base64 blobs never land on a row or get re-inlined into
    // COLLECTION_*_LIST results. Decorate here — not in the storage classes —
    // because those are singletons without objectStorage/org slug.
    decorateStorageWithAssetHoisting(storage, {
      objectStorage,
      baseUrl,
      orgSlug: organization?.slug,
    });

    const ctx: StudioContext = {
      timings,
      auth: studioAuth,
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
      objectStorage,
      orgFs,
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
      linkStatusProbe: config.linkStatusProbe,
      publishLinkControlFrame: config.publishLinkControlFrame,
      aiProviders: aiProviderFactory,
      createMCPProxy: async (conn: string | ConnectionEntity) => {
        return await createMCPProxy(conn, ctx);
      },
      invalidateMemberRole: config.memberRoleCache
        ? (userId: string, organizationId: string) =>
            config.memberRoleCache!.invalidate(userId, organizationId)
        : undefined,
      getOrCreateClient: clientPool,
      pendingRevalidations: [],
      firecrawlApiKey: getSettings().firecrawlApiKey,
    };

    return ctx;
  };
}

/**
 * Rebind every org-scoped facet of an existing StudioContext to `org`.
 *
 * A StudioContext is born from the session's active org — or from no org at
 * all (background contexts, unauthenticated requests). Any code path that
 * resolves the org AFTER creation (path-scoped routes via
 * resolve-org-from-path, durable-run rebuilds via automation-context) must
 * rebind ALL org-scoped state through this one helper. A hand-rolled subset
 * is how `ctx.orgFs` stayed null in background runs while `ctx.objectStorage`
 * worked (#3826) — add new org-scoped fields HERE, not at the call sites.
 *
 * Auth state (ctx.organization, ctx.access, ctx.boundAuth) is intentionally
 * not handled: the callers derive role/permissions differently (path
 * membership vs background membership) and set those themselves.
 */
export function rebindOrgScope(
  ctx: StudioContext,
  org: { id: string; slug: string | null },
): void {
  // Storage wrappers were constructed eagerly with the creation-time org (or
  // undefined); point them at the resolved org. Per-context instances — never
  // shared across requests — so the mutation is race-free.
  ctx.storage.threads.setOrganizationId(org.id);
  ctx.storage.asyncResearchJobs.setOrganizationId(org.id);
  // Object storage, and the org filesystem view over its keyspace.
  const s3Service = getObjectStorageS3Service();
  ctx.objectStorage = s3Service
    ? createBoundObjectStorage(s3Service, org.id)
    : new DevObjectStorage(org.id, ctx.baseUrl);
  ctx.orgFs = new OrgFs(ctx.objectStorage, ctx.storage.orgFsEntries, org.id);
  // Asset hoisters close over object storage and org slug; refresh the
  // wrappers so writes land in the resolved org's tenant scope.
  decorateStorageWithAssetHoisting(ctx.storage, {
    objectStorage: ctx.objectStorage,
    baseUrl: ctx.baseUrl,
    orgSlug: org.slug ?? undefined,
  });
}
