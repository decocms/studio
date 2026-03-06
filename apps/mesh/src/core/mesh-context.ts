/**
 * MeshContext - Core abstraction for all tools
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
import type { CredentialVault } from "../encryption/credential-vault";
import type { Database, Permission } from "../storage/types";
import type { AccessControl } from "./access-control";
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
 * Encapsulates HTTP context internally, keeping MeshContext HTTP-agnostic
 * Return types are derived from BetterAuthInstance.api using Awaited<ReturnType<>>
 */
export interface BoundAuthClient {
  /**
   * Check if the authenticated user has the specified permission
   * Delegates to Better Auth's Organization plugin hasPermission API
   */
  hasPermission(permission: Permission): Promise<boolean>;

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
export interface MeshAuth {
  user?: {
    id: string;
    connectionId?: string;
    email?: string;
    name?: string;
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
  /** Custom properties from x-mesh-properties header (string key-value pairs) */
  properties?: Record<string, string>;
  wellKnownForwardableHeaders?: Record<string, string | null>;
}

// ============================================================================
// Storage Interfaces
// ============================================================================

// Forward declare storage types
import type { createMCPProxy } from "@/api/routes/proxy";
import type { BetterAuthInstance } from "@/auth";
import { SqlThreadStorage } from "@/storage/threads";
import type { EventBus } from "../event-bus/interface";
import type { ConnectionStorage } from "../storage/connection";
import type { SqlMonitoringStorage } from "../storage/monitoring";
import type { SqlMonitoringDashboardStorage } from "../storage/monitoring-dashboards";
import type { OrganizationSettingsStorage } from "../storage/organization-settings";
import type { TagStorage } from "../storage/tags";
import type { UserStorage } from "../storage/user";
import type { VirtualMCPStorage } from "../storage/virtual";
import type { ProjectsStorage } from "../storage/projects";
import type { ProjectConnectionsStorage } from "../storage/project-connections";
import type { ProjectPluginConfigsStorage } from "../storage/project-plugin-configs";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

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
export interface MeshStorage {
  connections: ConnectionStorage;
  organizationSettings: OrganizationSettingsStorage;
  monitoring: SqlMonitoringStorage;
  monitoringDashboards: SqlMonitoringDashboardStorage;
  virtualMcps: VirtualMCPStorage;
  users: UserStorage;
  threads: SqlThreadStorage;
  tags: TagStorage;
  projects: ProjectsStorage;
  projectConnections: ProjectConnectionsStorage;
  projectPluginConfigs: ProjectPluginConfigsStorage;
}

// ============================================================================
// MeshContext Interface
// ============================================================================

export interface Timings {
  measure: <T>(name: string, cb: () => Promise<T>) => Promise<T>;
}

/**
 * MeshContext - The core abstraction passed to every tool handler
 *
 * This provides access to all necessary services without coupling
 * to implementation details.
 */
export interface MeshContext {
  // Connection ID (from url)
  connectionId?: string;

  // Timings for measuring performance
  timings: Timings;

  // Authentication (via Better Auth)
  auth: MeshAuth;

  // Organization scope (from Better Auth organization plugin)
  organization?: OrganizationScope;

  // Storage interfaces (database-agnostic)
  storage: MeshStorage;

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

  // Event bus for publishing and subscribing to events
  eventBus: EventBus;

  // Utility for creating MCP Proxies
  createMCPProxy: (
    conn: Parameters<typeof createMCPProxy>[0],
  ) => ReturnType<typeof createMCPProxy>;

  // Client pool for STDIO connection reuse (LRU cache)
  getOrCreateClient: (<T extends Transport>(
    transport: T,
    key: string,
  ) => Promise<Client>) & {
    [Symbol.asyncDispose]: () => Promise<void>;
  };
}

// ============================================================================
// Utility Functions
// ============================================================================

/**
 * Check if context has organization scope
 */
export function hasOrganization(ctx: MeshContext): boolean {
  return ctx.organization !== undefined;
}

/**
 * Get organization ID or null
 */
export function getOrganizationId(ctx: MeshContext): string | null {
  return ctx.organization?.id ?? null;
}

/**
 * Require organization scope (throws if not organization-scoped)
 */
export function requireOrganization(ctx: MeshContext): OrganizationScope {
  if (!ctx.organization) {
    throw new Error("This operation requires organization scope");
  }
  return ctx.organization;
}

/**
 * Get user ID (from user or API key)
 */
export function getUserId(ctx: MeshContext): string | undefined {
  return ctx.auth.user?.id ?? ctx.auth.apiKey?.userId;
}

/**
 * Check if user is authenticated
 */
export function isAuthenticated(ctx: MeshContext): boolean {
  return !!(ctx.auth.user || ctx.auth.apiKey);
}

/**
 * Require authentication (throws if not authenticated)
 */
export function requireAuth(ctx: MeshContext): void {
  if (!isAuthenticated(ctx)) {
    throw new Error("Authentication required");
  }
}
