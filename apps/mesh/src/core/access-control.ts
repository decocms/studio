/**
 * Access Control for Studio
 *
 * Uses Better Auth's permission system for authorization.
 * Follows a grant-based model:
 * 1. Tools call ctx.access.check() to verify permissions
 * 2. If allowed, access is granted internally
 * 3. Middleware verifies that access was granted
 * 4. Tools can manually grant access for custom logic
 */

import { MCP_MESH_KEY } from "@/core/constants";
import { BASIC_USAGE_TOOLS } from "@/tools/registry-metadata";
import { hasAdminRole } from "@/auth/roles";
import type { BoundAuthClient } from "./studio-context";

// ============================================================================
// Types
// ============================================================================

/**
 * Callback to get tool metadata for public tool check.
 * Scoped to the current tool being accessed.
 */
export type GetToolMetaFn = () => Promise<Record<string, unknown> | undefined>;

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

/**
 * The caller's seat is free and the tool would mutate or spend. Extends
 * ForbiddenError so every existing `instanceof ForbiddenError` mapping keeps
 * returning 403 untouched. The `[PAID_SEAT_REQUIRED]` message prefix is the
 * WIRE CONTRACT for the frontend — same convention as `[CREDITS]` (see
 * web/components/chat/is-credit-error.ts): a stable prefix survives every
 * transport (REST JSON, MCP tool error, JSON-RPC) without threading a
 * structured field through each layer. The paywall UI detects it and renders
 * the upgrade CTA (admins/owners) or "ask your admin" (everyone else, using
 * the role it already has) instead of a generic access-denied.
 */
const PAID_SEAT_REQUIRED_PREFIX = "[PAID_SEAT_REQUIRED]";

export class PaidSeatRequiredError extends ForbiddenError {
  constructor() {
    super(
      `${PAID_SEAT_REQUIRED_PREFIX} this action needs a paid seat on this organization`,
    );
    this.name = "PaidSeatRequiredError";
  }
}

/**
 * Non-tool resource keys checked directly by HTTP routes (no defineTool, so
 * no readOnlyHint to consult) that are pure READS — a gated free seat may
 * pass them. Keep this to reads only: anything that writes or spends stays
 * out (ORG_FS_WRITE is deliberately absent).
 */
const SEAT_GATE_READ_RESOURCES: ReadonlySet<string> = new Set(["ORG_FS_READ"]);

// ============================================================================
// AccessControl Class
// ============================================================================

/**
 * AccessControl using Better Auth's permission system
 *
 * Delegates all permission checks to Better Auth's Organization plugin
 * via the BoundAuthClient (which encapsulates HTTP headers)
 */
export class AccessControl {
  private _granted: boolean = false;
  /** True when the caller must be blocked from mutating/spending tools:
   *  billing enforced (deployment flag) AND org not legacy AND the member has
   *  no paid seat. Computed once per request by `resolveOrgFromPath`. */
  private seatGated: boolean = false;
  /** The current tool declared `readOnlyHint: true` (set by defineTool).
   *  Fail-closed: an unannotated read tool is treated as mutating — annotate
   *  it rather than widening the gate. */
  private toolReadOnly: boolean = false;

  constructor(
    private userId?: string,
    private toolName?: string,
    private boundAuth?: BoundAuthClient, // Bound auth client for permission checks
    private role?: string, // From user session (for built-in role bypass)
    private connectionId: string = "self", // For connection-specific checks (matches permission resource key)
    private getToolMeta?: GetToolMetaFn, // Optional callback for public tool check
    private organizationId?: string, // Path-resolved org (overrides session active org)
  ) {}

  setToolName(toolName: string): void {
    this.toolName = toolName;
  }

  /** Set by `resolveOrgFromPath` after loading billing + seat state. */
  setSeatGated(gated: boolean): void {
    this.seatGated = gated;
  }

  /** Set by defineTool from the tool's `annotations.readOnlyHint`. */
  setToolReadOnly(readOnly: boolean): void {
    this.toolReadOnly = readOnly;
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
   * @throws UnauthorizedError if not authenticated (401)
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

    // Check if authenticated first (401)
    if (!this.userId && !this.boundAuth) {
      // Check if tool is public before throwing
      if (this.getToolMeta && (await this.isToolPublic())) {
        this.grant();
        return;
      }
      throw new UnauthorizedError(
        "Authentication required. Please provide a valid OAuth token or API key.",
      );
    }

    // Determine what to check
    const resourcesToCheck =
      resources.length > 0 ? resources : this.toolName ? [this.toolName] : [];

    // Seat gate — monetization, orthogonal to governance, so it fires BEFORE
    // the role paths below (an org OWNER can hold a free seat: the
    // report-funnel onboarding case — admin bypass must not leak through).
    // A free seat sees everything and changes nothing: tools that declare
    // readOnlyHint pass, as do the non-tool READ resource keys checked
    // directly by HTTP routes (SEAT_GATE_READ_RESOURCES).
    if (
      this.seatGated &&
      !this.toolReadOnly &&
      !(
        resourcesToCheck.length > 0 &&
        resourcesToCheck.every((r) => SEAT_GATE_READ_RESOURCES.has(r))
      )
    ) {
      throw new PaidSeatRequiredError();
    }

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
    // No user or bound auth = deny
    if (!this.userId && !this.boundAuth) {
      return false;
    }

    // Two kinds of principal, each with its OWN self-contained rule:
    //   - API key   → the key's stored allowlist is the whole decision. It is a
    //     capability, not a member: no role, no basic-usage, no Better Auth.
    //   - everyone else (session / MCP OAuth / studio JWT) → membership floor +
    //     admin/owner bypass + Better Auth grants.
    return this.boundAuth?.isApiKeyPrincipal
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
    // `isApiKeyPrincipal` is only set on a real bound client, so this is
    // defensive; the dispatcher already routed non-bound principals away.
    if (!this.boundAuth) return false;
    return this.boundAuth.hasPermission({ [this.connectionId]: [resource] });
  }

  /**
   * Member authorization (session / MCP OAuth / studio JWT).
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
    // `this.role` may be Better Auth's comma-joined multi-role string (e.g.
    // "admin,billing-manager") when set via `setRole()` for a path-resolved
    // org — a plain exact-match here would miss it and fall through to the
    // slower `boundAuth.hasPermission` DB round-trip. See `hasAdminRole`.
    if (hasAdminRole(this.role)) {
      return true;
    }
    if (!this.boundAuth) {
      return false;
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
   * Check if the current tool is marked as public via _meta["mcp.mesh"].public_tool
   */
  private async isToolPublic(): Promise<boolean> {
    if (this.toolName?.startsWith("MESH_PUBLIC_")) return true;
    if (!this.getToolMeta) return false;
    try {
      const meta = await this.getToolMeta();
      if (!meta) return false;
      const studioMeta = meta[MCP_MESH_KEY] as
        | Record<string, unknown>
        | undefined;
      const value = studioMeta?.public_tool;
      return value === true || value === "true";
    } catch {
      return false;
    }
  }

  /**
   * Check if access was granted
   */
  granted(): boolean {
    return this._granted;
  }
}
