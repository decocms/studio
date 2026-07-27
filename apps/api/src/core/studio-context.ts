/**
 * StudioContext - Core abstraction for all tools
 *
 * Provides tools with access to all necessary services without coupling them
 * to HTTP frameworks or database drivers.
 *
 * Key Principles:
 * - Tools NEVER access HTTP objects directly
 * - Tools NEVER access database drivers directly
 * - Tools NEVER access environment variables directly
 * - All dependencies injected through this interface
 */

import type { Meter, Tracer } from "@opentelemetry/api";
import type { Kysely } from "kysely";
import type { ControlFrame } from "@/api/routes/decopilot/control-frames";
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, Permission } from "../storage/types";
import type { AccessControl } from "./access-control";
import type { HarnessContext } from "./harness-context";
export type { BetterAuthInstance } from "@/auth";
// Re-export for consumers
export type { AccessControl, CredentialVault };

// ============================================================================
// Authentication State
// ============================================================================

// ============================================================================
// Better Auth API Types (derived from BetterAuthInstance)
// ============================================================================

// Extract return type from Better Auth API methods
type BetterAuthApi = BetterAuthInstance["api"];

// Organization API return types
export type CreateOrganizationResult = Awaited<
  ReturnType<BetterAuthApi["createOrganization"]>
>;
export type UpdateOrganizationResult = Awaited<
  ReturnType<BetterAuthApi["updateOrganization"]>
>;
export type GetFullOrganizationResult = Awaited<
  ReturnType<BetterAuthApi["getFullOrganization"]>
>;
export type ListOrganizationsResult = Awaited<
  ReturnType<BetterAuthApi["listOrganizations"]>
>;
export type AddMemberResult = Awaited<ReturnType<BetterAuthApi["addMember"]>>;
export type ListMembersResult = Awaited<
  ReturnType<BetterAuthApi["listMembers"]>
>;
export type UpdateMemberRoleResult = Awaited<
  ReturnType<BetterAuthApi["updateMemberRole"]>
>;

// API Key return types
export type CreateApiKeyResult = Awaited<
  ReturnType<BetterAuthApi["createApiKey"]>
>;
export type ListApiKeysResult = Awaited<
  ReturnType<BetterAuthApi["listApiKeys"]>
>;
export type UpdateApiKeyResult = Awaited<
  ReturnType<BetterAuthApi["updateApiKey"]>
>;

/**
 * Bound auth client for Better Auth operations
 * Encapsulates HTTP context internally, keeping StudioContext HTTP-agnostic
 * Return types are derived from BetterAuthInstance.api using Awaited<ReturnType<>>
 */
export interface BoundAuthClient {
  /**
   * Check if the authenticated user has the specified permission
   * Delegates to Better Auth's Organization plugin hasPermission API
   *
   * @param permission - Permission to check
   * @param options.organizationId - Override the session-based active org.
   *   When set, Better Auth uses this org for the permission check instead
   *   of the user's session-active org. Used by path-resolved org middleware.
   * @param options.role - The caller's `member.role` for the EFFECTIVE org
   *   (the org in `options.organizationId`, else the session-active org). When
   *   the role is a single built-in role, the check is resolved in-memory
   *   instead of via two DB-backed Better Auth calls. MUST be the role for the
   *   same org as `organizationId` — pass them together. Omit to force the
   *   Better Auth path. See `auth/builtin-role-permission.ts`.
   */
  hasPermission(
    permission: Permission,
    options?: { organizationId?: string; role?: string },
  ): Promise<boolean>;

  /**
   * True when the principal authenticated with an API key. Such a principal is
   * authorized SOLELY by the key's stored allowlist — it must NOT inherit the
   * owner's admin/owner role. Both `hasPermission` here and the role bypass in
   * `AccessControl.checkResource` read this single flag so every call site
   * (REST + MCP) agrees. Absent/false for browser sessions, MCP OAuth, and studio
   * JWTs, which keep the role-based behavior.
   */
  isApiKeyPrincipal?: boolean;

  // Organization APIs (bound with headers)
  organization: {
    create(data: {
      name: string;
      slug: string;
      userId?: string;
      logo?: string;
      metadata?: Record<string, unknown>;
    }): Promise<CreateOrganizationResult>;

    update(data: {
      organizationId: string;
      data: {
        name?: string;
        slug?: string;
        metadata?: Record<string, unknown>;
      };
    }): Promise<UpdateOrganizationResult>;

    delete(organizationId: string): Promise<void>;

    get(organizationId?: string): Promise<GetFullOrganizationResult>;

    list(userId?: string): Promise<ListOrganizationsResult>;

    // Member operations
    addMember(data: {
      userId: string;
      role: string | string[];
      organizationId?: string;
    }): Promise<AddMemberResult>;

    removeMember(data: {
      memberIdOrEmail: string;
      organizationId?: string;
    }): Promise<void>;

    listMembers(options?: {
      organizationId?: string;
      limit?: number;
      offset?: number;
      filterField?: string;
      filterValue?: string;
    }): Promise<ListMembersResult>;

    updateMemberRole(data: {
      memberId: string;
      role: string | string[];
      organizationId?: string;
    }): Promise<UpdateMemberRoleResult>;
  };

  // API Key APIs (bound with headers)
  apiKey: {
    /**
     * Create a new API key
     * @returns The created API key WITH its value (only time it's visible)
     */
    create(data: {
      name: string;
      permissions?: Record<string, string[]>;
      expiresIn?: number;
      metadata?: Record<string, unknown>;
    }): Promise<CreateApiKeyResult>;

    /**
     * List all API keys for the authenticated user
     * @returns Array of API keys (WITHOUT key values)
     */
    list(): Promise<ListApiKeysResult>;

    /**
     * Update an existing API key
     * @returns The updated API key (WITHOUT key value)
     */
    update(data: {
      keyId: string;
      name?: string;
      permissions?: Record<string, string[]>;
      metadata?: Record<string, unknown>;
    }): Promise<UpdateApiKeyResult>;

    /**
     * Delete an API key (instant revocation)
     */
    delete(keyId: string): Promise<void>;
  };
}

/**
 * Authentication state from Better Auth
 */
export interface StudioAuth {
  /**
   * Organization encoded in a bearer credential (API key or Studio JWT).
   * Org-scoped middleware must not rebind a token issued for one org to a
   * different org named in the request path.
   */
  tokenOrganizationId?: string;

  user?: {
    id: string;
    connectionId?: string;
    email?: string;
    emailVerified?: boolean;
    name?: string;
    image?: string;
    role?: string; // From Better Auth organization plugin
  };

  apiKey?: {
    id: string;
    name: string;
    userId: string;
    metadata?: Record<string, unknown>;
    remaining?: number; // Remaining requests (rate limiting)
    expiresAt?: Date;
  };
}

// ============================================================================
// Organization Scope
// ============================================================================

/**
 * Organization scope
 * Organization context from Better Auth organization plugin
 */
export interface OrganizationScope {
  id: string;
  slug?: string;
  name?: string;
  /**
   * Caller's role within this organization (e.g. "owner", "admin", "member").
   * Set by `resolveOrgFromPath` when the org is resolved from the URL slug,
   * so downstream code (notably AuthTransport, which constructs a fresh
   * AccessControl per proxied tool call) can use the path-resolved role
   * instead of the session's active-org role — they may differ.
   */
  role?: string;
}

// ============================================================================
// Request Metadata
// ============================================================================

/**
 * Request metadata (non-HTTP specific)
 */
export interface RequestMetadata {
  requestId: string;
  timestamp: Date;
  userAgent?: string;
  ipAddress?: string;
  threadId?: string;
  /** Custom properties from x-studio-properties (legacy x-mesh-properties accepted). */
  properties?: Record<string, string>;
  wellKnownForwardableHeaders?: Record<string, string | null>;
  /**
   * Per-run metadata forwarded to downstream MCP tool calls as the
   * `x-studio-run-metadata` header (JSON). Set from a webhook trigger's
   * `run_metadata` so a downstream server can read run-scoped context (e.g. the
   * tenant a scheduled/triggered run acts on) without the agent passing it as a
   * tool argument.
   */
  runMetadata?: Record<string, string>;
}

// ============================================================================
// Storage Interfaces
// ============================================================================

// Forward declare storage types
import type { createMCPProxy } from "@/api/routes/mcp-proxy-factory";
import type { BetterAuthInstance } from "@/auth";
import type { OrgScopedThreadStorage } from "@/storage/threads";
import type { OrgScopedAsyncResearchJobStorage } from "@/storage/async-research-jobs";
import type { ConnectionStorage } from "../storage/connection";
import type { ConnectionCredentialVaultStorage } from "../storage/connection-credential-vault";
import type {
  MonitoringStorage,
  VirtualMcpPluginConfigStoragePort,
} from "../storage/ports";
import type { OrganizationSettingsStorage } from "../storage/organization-settings";
import type { UserModelPreferencesStorage } from "../storage/user-model-preferences";
import type { TagStorage } from "../storage/tags";
import type { UserStorage } from "../storage/user";
import type { VirtualMCPStorage } from "../storage/virtual";
import type { AutomationsStorage } from "../storage/automations";
import type { TriggerCallbackTokenStorage } from "../storage/trigger-callback-tokens";
import type { OrgSsoConfigStorage } from "../storage/org-sso-config";
import type { OrgSsoSessionStorage } from "../storage/org-sso-sessions";
import type { BrandContextStorage } from "../storage/brand-context";
import type { OrganizationDomainStorage } from "../storage/organization-domains";
import type { OrganizationJoinRequestStorage } from "../storage/organization-join-requests";
import type { RegistryStorage } from "../storage/registry";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { AIProviderKeyStorage } from "@/storage/ai-provider-keys";
import { SecretStorage } from "@/storage/secrets";
import { OrgFileConfigStorage } from "@/storage/org-file-configs";
import { OrgSiteStorage } from "@/storage/org-sites";
import type { TaskBoardStorage } from "@/storage/task-board";
import type { OrgFsEntryStorage } from "@/storage/org-fs";
import type { OrgFs } from "@/file-storage/org-fs";
import type { KVStorage } from "@/storage/kv";
import type { InterestsStorage } from "@/storage/interests";
import type { OAuthPkceStateStorage } from "@/storage/oauth-pkce-states";
import { AIProviderFactory } from "@/ai-providers/factory";
import type { FireAutomationOutcome } from "../automations/dbos-workflow";
import type { BoundObjectStorage } from "../object-storage/bound-object-storage";
import type { OrganizationBillingStorage } from "../storage/organization-billing";

// Better Auth instance type - flexible for testing
// In production, this is the actual Better Auth instance
// In tests, can be a partial mock

/**
 * Storage interfaces aggregation
 *
 * Note:
 * - Organizations, teams, members, and roles managed by Better Auth organization plugin
 * - Policies handled by Better Auth permissions directly
 * - API Keys (tokens) managed by Better Auth API Key plugin
 * - Token revocation handled by Better Auth (deleteApiKey)
 */
export interface StudioStorage {
  connections: ConnectionStorage;
  connectionCredentialVault: ConnectionCredentialVaultStorage;
  organizationSettings: OrganizationSettingsStorage;
  userModelPreferences: UserModelPreferencesStorage;
  monitoring: MonitoringStorage;
  virtualMcps: VirtualMCPStorage;
  users: UserStorage;
  threads: OrgScopedThreadStorage;
  asyncResearchJobs: OrgScopedAsyncResearchJobStorage;
  tags: TagStorage;
  aiProviderKeys: AIProviderKeyStorage;
  secrets: SecretStorage;
  orgFileConfigs: OrgFileConfigStorage;
  orgSites: OrgSiteStorage;
  taskBoard: TaskBoardStorage;
  orgFsEntries: OrgFsEntryStorage;
  oauthPkceStates: OAuthPkceStateStorage;
  automations: AutomationsStorage;
  triggerCallbackTokens: TriggerCallbackTokenStorage;
  virtualMcpPluginConfigs: VirtualMcpPluginConfigStoragePort;
  orgSsoConfig: OrgSsoConfigStorage;
  orgSsoSessions: OrgSsoSessionStorage;
  registry: RegistryStorage;
  brandContext: BrandContextStorage;
  organizationDomains: OrganizationDomainStorage;
  organizationJoinRequests: OrganizationJoinRequestStorage;
  kv: KVStorage;
  interests: InterestsStorage;
  organizationBilling: OrganizationBillingStorage;
}

// ============================================================================
// StudioContext Interface
// ============================================================================

export interface Timings {
  measure: <T>(name: string, cb: () => Promise<T>) => Promise<T>;
}

/**
 * StudioContext - The core abstraction passed to every tool handler
 *
 * This provides access to all necessary services without coupling
 * to implementation details.
 */
export interface StudioContext extends HarnessContext {
  // Connection ID (from url)
  connectionId?: string;

  // Timings for measuring performance
  timings: Timings;

  // Authentication (via Better Auth)
  auth: StudioAuth;

  // Organization scope (from Better Auth organization plugin)
  organization?: OrganizationScope;

  // Storage interfaces (database-agnostic)
  storage: StudioStorage;

  // Security services
  vault: CredentialVault; // For encrypting connection credentials
  authInstance: BetterAuthInstance; // Better Auth instance
  boundAuth: BoundAuthClient; // Pre-bound auth client for permission checks

  // Access control (for authorization)
  access: AccessControl;

  // Database (Kysely instance for direct queries when needed)
  db: Kysely<Database>;

  // Current tool being executed (set by defineTool wrapper)
  toolName?: string;

  // Observability (OpenTelemetry)
  tracer: Tracer;
  meter: Meter;

  // Base URL (derived from request, for OAuth callbacks, etc.)
  baseUrl: string;

  // Request metadata (non-HTTP specific)
  metadata: RequestMetadata;

  // AI Provider factory
  aiProviders: AIProviderFactory;

  // Utility for creating MCP Proxies
  createMCPProxy: (
    conn: Parameters<typeof createMCPProxy>[0],
  ) => ReturnType<typeof createMCPProxy>;

  // Client pool for STDIO connection reuse (LRU cache)
  getOrCreateClient: <T extends Transport>(
    transport: T,
    key: string,
  ) => Promise<Client>;

  // Invalidate cached member role (call after role mutations)
  invalidateMemberRole?: (userId: string, organizationId: string) => void;

  // Revalidation promises from SWR cache — awaited in middleware before ctx goes out of scope
  pendingRevalidations: Promise<void>[];

  // AI Provider keys storage

  // Object storage (S3-compatible) — null when S3 isn't configured or no org scope
  objectStorage: BoundObjectStorage | null;

  // Org filesystem (path/tree view over object storage) — null when there's no
  // object storage or no org scope. See `.context/org-filesystem-proposal.md`.
  orgFs: OrgFs | null;

  // External API keys (optional, from settings)
  firecrawlApiKey?: string;

  // Automation runner — fires an automation manually (wired in app.ts)
  automationRunner?: (
    automationId: string,
    orgId: string,
    userId: string,
  ) => Promise<FireAutomationOutcome>;

  /**
   * Sandbox dispatch preference for the in-flight run, populated by
   * `prepareRun` from the resolved `DispatchTarget`:
   *   - `"agent-sandbox"` — force hosted sandbox provider behavior for this run.
   *   - `"cluster-default"` — legacy/env-default hint: use whichever sandbox
   *     kind `STUDIO_SANDBOX_PROVIDER` resolves to.
   *   - `"user-desktop"` — use the user's link daemon for sandbox provider
   *     behavior.
   */
  sandboxPreference?: "agent-sandbox" | "cluster-default" | "user-desktop";

  /**
   * Live desktop-link status probe (cluster → daemon over the tunnel).
   * Replaces the claim-registry read for presence. Returns `{ online: false }`
   * when no link/connection answers within the probe timeout.
   */
  linkStatusProbe?: import("@/links/tunnel-status-probe").LinkStatusProbe;

  /**
   * Publish a control frame onto a user's active link. Fire-and-forget: a no-op
   * when no live tunnel claim exists. Deliberately narrower than the
   * CancelBroadcast it delegates to — tools only ever publish (LINK_DISCONNECT
   * sends `shutdown`); start/stop/broadcast stay with the app wiring. Undefined
   * in test contexts without a broadcast.
   */
  publishLinkControlFrame?: (userSub: string, frame: ControlFrame) => void;
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if context has organization scope
 */
export function hasOrganization(ctx: StudioContext): boolean {
  return ctx.organization !== undefined;
}

/**
 * Get organization ID or null
 */
export function getOrganizationId(ctx: StudioContext): string | null {
  return ctx.organization?.id ?? null;
}

/**
 * Require organization scope (throws if not organization-scoped)
 */
export function requireOrganization(ctx: StudioContext): OrganizationScope {
  if (!ctx.organization) {
    throw new Error("This operation requires organization scope");
  }
  return ctx.organization;
}

/**
 * Get user ID (from user or API key)
 */
export function getUserId(ctx: StudioContext): string | undefined {
  return ctx.auth.user?.id ?? ctx.auth.apiKey?.userId;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(ctx: StudioContext): boolean {
  return !!(ctx.auth.user || ctx.auth.apiKey);
}

/**
 * Require authentication (throws if not authenticated)
 */
export function requireAuth(ctx: StudioContext): void {
  if (!isAuthenticated(ctx)) {
    throw new Error("Authentication required");
  }
}
