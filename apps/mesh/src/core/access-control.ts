/**
 * Access Control for MCP Mesh
 *
 * Uses Better Auth's permission system for authorization.
 * Follows a grant-based model:
 * 1. Tools call ctx.access.check() to verify permissions
 * 2. If allowed, access is granted internally
 * 3. Middleware verifies that access was granted
 * 4. Tools can manually grant access for custom logic
 */

import { BASIC_USAGE_TOOLS } from "@/tools/registry-metadata";
import type { BoundAuthClient } from "./studio-context";

// ============================================================================
// Types
// ============================================================================

// ============================================================================
// Errors
// ============================================================================

/**
 * Custom error for unauthenticated requests (401)
 */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * Custom error for access denial (403)
 */
export class ForbiddenError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ForbiddenError";
  }
}

// ============================================================================
// AccessControl Class
// ============================================================================

/**
 * AccessControl using Better Auth's permission system
 *
 * Delegates all permission checks to Better Auth's Organization plugin
 * via the BoundAuthClient (which encapsulates HTTP headers)
 */
export interface AccessControlOptions {
  /** Authenticated principal id; undefined for an anonymous caller. */
  userId?: string;
  /** Tool being checked. May be unset here and supplied later via setToolName(). */
  toolName?: string;
  /**
   * Bound auth client. Built by the context factory for EVERY request (even
   * anonymous), so it's a required dependency — an anonymous principal just has
   * no role/perms and is denied by the permission check, not by a missing client.
   */
  boundAuth: BoundAuthClient;
  /** Caller's role for the effective org (drives the built-in admin/owner bypass). */
  role?: string;
  /**
   * Permission resource key: "self" for management tools, "conn_<id>" for a
   * specific connection. Defaults to "self".
   */
  connectionId?: string;
  /** Path-resolved org id (overrides the session's active org). */
  organizationId?: string;
}

export class AccessControl {
  private _granted = false;
  private userId?: string;
  private toolName?: string;
  private boundAuth: BoundAuthClient;
  private role?: string;
  private connectionId: string;
  private organizationId?: string;

  constructor(opts: AccessControlOptions) {
    this.userId = opts.userId;
    this.toolName = opts.toolName;
    this.boundAuth = opts.boundAuth;
    this.role = opts.role;
    this.connectionId = opts.connectionId ?? "self";
    this.organizationId = opts.organizationId;
  }

  setToolName(toolName: string): void {
    this.toolName = toolName;
  }

  /**
   * Set the organization id used for permission checks.
   * Called by `resolveOrgFromPath` middleware after looking up the org from
   * the URL slug, so subsequent `check()` calls forward the path-resolved org
   * to Better Auth instead of relying on the session's active org.
   */
  setOrganizationId(organizationId: string | undefined): void {
    this.organizationId = organizationId;
  }

  getOrganizationId(): string | undefined {
    return this.organizationId;
  }

  /**
   * Set the user's role within the path-resolved organization.
   * Without this, `checkResource` would use the role baked in at construction
   * time, which was derived from the session's active org. When the path
   * targets a different org (or when the session has no active org), the
   * built-in admin/owner bypass would silently fail and tools would 403.
   */
  setRole(role: string | undefined): void {
    this.role = role;
  }

  getRole(): string | undefined {
    return this.role;
  }

  /**
   * Grant access unconditionally
   * Use for manual overrides, admin actions, or custom validation
   */
  grant(): void {
    this._granted = true;
  }

  /**
   * Check permissions and grant access if allowed
   *
   * @param resources - Resources to check (OR logic)
   * If omitted, checks the current tool name
   *
   * @throws ForbiddenError if access is denied (403)
   *
   * @example
   * await ctx.access.check(); // Check current tool
   * await ctx.access.check('conn_<UUID>'); // Check connection access
   * await ctx.access.check('TOOL1', 'TOOL2'); // Check TOOL1 OR TOOL2
   */
  async check(...resources: string[]): Promise<void> {
    // If already granted, skip check
    if (this._granted) {
      return;
    }
    // tool is public with zero IO operations, so we can grant access immediately
    if (this.toolName?.startsWith("MESH_PUBLIC_")) {
      this.grant();
      return;
    }

    // Determine what to check
    const resourcesToCheck =
      resources.length > 0 ? resources : this.toolName ? [this.toolName] : [];

    if (resourcesToCheck.length === 0) {
      throw new ForbiddenError("No resources specified for access check");
    }

    // Try each resource - if ANY succeeds, grant access (OR logic)
    for (const resource of resourcesToCheck) {
      const hasAccess = await this.checkResource(resource);
      if (hasAccess) {
        this.grant();
        return;
      }
    }

    // No permission found
    throw new ForbiddenError(
      `Access denied to: ${resourcesToCheck.join(", ")}`,
    );
  }

  /**
   * Check if user has permission to access a resource
   * Delegates to Better Auth's Organization plugin via boundAuth
   */
  private async checkResource(resource: string): Promise<boolean> {
    // Two kinds of principal, each with its OWN self-contained rule:
    //   - API key   → the key's stored allowlist is the whole decision. It is a
    //     capability, not a member: no role, no basic-usage, no Better Auth.
    //   - everyone else (session / MCP OAuth / mesh JWT) → membership floor +
    //     admin/owner bypass + Better Auth grants.
    return this.boundAuth.isApiKeyPrincipal
      ? this.checkApiKeyAccess(resource)
      : this.checkMemberAccess(resource);
  }

  /**
   * API-key authorization: the key's stored allowlist is the entire decision.
   * Never inherits the owner's role, basic-usage floor, or any Better Auth
   * grant — so a "read-only" key minted by an admin can't act beyond its scope.
   * See auth/api-key-permissions.ts (`checkApiKeyPermission`).
   */
  private async checkApiKeyAccess(resource: string): Promise<boolean> {
    return this.boundAuth.hasPermission({ [this.connectionId]: [resource] });
  }

  /**
   * Member authorization (session / MCP OAuth / mesh JWT).
   *
   * Basic-usage tools are granted to every authenticated org MEMBER regardless
   * of role — resolved here, not baked into each role, so the set evolves with
   * a one-line edit to BASIC_USAGE_TOOLS. Both signals are required: `userId`
   * (a verified principal — `boundAuth` exists for every request, even
   * anonymous, so it must not gate this) and `role` (set only for members).
   * Admin/owner bypass everything; everyone else falls through to the stored /
   * Better Auth grant.
   */
  private async checkMemberAccess(resource: string): Promise<boolean> {
    if (this.userId && this.role && BASIC_USAGE_TOOLS.has(resource)) {
      return true;
    }
    if (this.role === "admin" || this.role === "owner") {
      return true;
    }
    // Pass `this.role` so boundAuth can resolve built-in roles in-memory (no
    // Better Auth round-trip); admin/owner already returned above, so this only
    // accelerates the `user` role. `organizationId` (path-resolved org) makes
    // Better Auth check the right org instead of the session's active one.
    return this.boundAuth.hasPermission(
      { [this.connectionId]: [resource] },
      { organizationId: this.organizationId, role: this.role },
    );
  }

  /**
   * Check if access was granted
   */
  granted(): boolean {
    return this._granted;
  }
}
