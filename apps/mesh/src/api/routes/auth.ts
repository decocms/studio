/**
 * Custom Auth Routes
 *
 * Provides custom authentication endpoints that work better with OAuth flows
 * by returning callback URLs in response body instead of using 302 redirects.
 */

import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { posthog } from "../../posthog";
import { getSettings } from "../../settings";
import {
  auth,
  authConfig,
  GENERIC_EMAIL_DOMAINS,
  resetPasswordEnabled,
} from "../../auth";
import { getDb } from "../../database";
import { extractBrandFromDomain } from "../../auth/extract-brand";
import { BrandContextStorage } from "../../storage/brand-context";
import { OrganizationDomainStorage } from "../../storage/organization-domains";
import { KNOWN_OAUTH_PROVIDERS, OAuthProvider } from "@/auth/oauth-providers";
import {
  getLocalAdminUser,
  getLocalAdminPassword,
  isLocalMode,
} from "@/auth/local-mode";
import {
  allCapabilitiesGranted,
  resolveCapabilities,
  USER_ROLE_TOOLS,
} from "@/tools/registry-metadata";

const app = new Hono();

export type AuthConfig = {
  emailAndPassword: {
    enabled: boolean;
  };
  magicLink: {
    enabled: boolean;
  };
  emailOtp: {
    enabled: boolean;
  };
  socialProviders: {
    enabled: boolean;
    providers: {
      name: string;
      icon?: string;
    }[];
  };
  resetPassword: {
    enabled: boolean;
  };
  sso:
    | {
        enabled: true;
        providerId: string;
      }
    | {
        enabled: false;
      };
  /**
   * Whether STDIO connections are allowed. Only true in local mode, since
   * STDIO transports spawn arbitrary local commands.
   */
  stdioEnabled: boolean;
  /**
   * Whether local mode is active (zero-ceremony developer experience).
   * When true, the frontend should auto-login and skip org selection.
   */
  localMode: boolean;
};

export function buildAuthConfig(): AuthConfig {
  const socialProviders = Object.keys(authConfig.socialProviders ?? {});
  const hasSocialProviders = socialProviders.length > 0;
  const providers = socialProviders.map((name) => ({
    name,
    icon: KNOWN_OAUTH_PROVIDERS[name as OAuthProvider].icon,
  }));

  // STDIO is only available in local mode — see outbound/index.ts STDIO case.
  const stdioEnabled = getSettings().localMode;

  return {
    emailAndPassword: {
      enabled: authConfig.emailAndPassword?.enabled ?? false,
    },
    magicLink: {
      enabled: authConfig.magicLinkConfig?.enabled ?? false,
    },
    emailOtp: {
      enabled: authConfig.emailOtpConfig?.enabled ?? false,
    },
    resetPassword: {
      enabled: resetPasswordEnabled,
    },
    socialProviders: {
      enabled: hasSocialProviders,
      providers: providers,
    },
    sso: authConfig.ssoConfig
      ? {
          enabled: true,
          providerId: authConfig.ssoConfig.providerId,
        }
      : {
          enabled: false,
        },
    stdioEnabled,
    localMode: isLocalMode(),
  };
}

/**
 * Local Mode Auto-Session Endpoint
 *
 * When local mode is active, this endpoint signs in the admin user
 * and returns the session. The frontend calls this to skip the login form.
 *
 * Route: POST /api/auth/custom/local-session
 */
app.post("/local-session", async (c) => {
  if (!isLocalMode()) {
    return c.json({ success: false, error: "Local mode is not active" }, 403);
  }

  // Only allow from loopback to prevent LAN access when bound to 0.0.0.0
  // Uses Bun's socket-level requestIP — not spoofable via headers
  let remoteAddr: string | undefined;
  try {
    const info = getConnInfo(c);
    remoteAddr = info.remote.address;
  } catch {
    // getConnInfo may fail in test environments without a real server
  }
  const isLoopback =
    remoteAddr === "127.0.0.1" ||
    remoteAddr === "::1" ||
    remoteAddr === "::ffff:127.0.0.1";
  if (!isLoopback) {
    return c.json({ success: false, error: "Forbidden" }, 403);
  }

  try {
    // Wait for local-mode seeding to complete before attempting login
    const { waitForSeed } = await import("@/auth/local-mode");
    await waitForSeed();

    const { auth } = await import("../../auth");
    const adminUser = await getLocalAdminUser();
    if (!adminUser) {
      return c.json(
        { success: false, error: "Local admin user not found" },
        500,
      );
    }

    // Sign in as the local admin user
    const password = await getLocalAdminPassword();
    const result = await auth.api.signInEmail({
      body: {
        email: adminUser.email,
        password,
      },
      asResponse: true,
    });

    // Forward the response (includes Set-Cookie headers)
    return result;
  } catch (error) {
    console.error("Failed to create local session:", error);
    return c.json(
      {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Failed to create local session",
      },
      500,
    );
  }
});

/**
 * My Capabilities Endpoint (authenticated)
 *
 * Resolves which permission capabilities the current user has in the given
 * organization, as a capability-id → boolean map. The single source of truth
 * for proactive UI gating, so the client never re-implements role logic.
 *
 * Server-resolved against the role's stored permission using the same wildcard
 * rules AccessControl applies. Better Auth's listRoles is admin-only, so this
 * route reads the caller's own membership + role directly to support every
 * member. The org is taken from the path (not the session's active org, which
 * can be stale or point at a different org than the one being viewed).
 *
 * Route: GET /api/auth/custom/my-capabilities/:slug
 */
app.get("/my-capabilities/:slug", async (c) => {
  const slug = c.req.param("slug");
  const session = (await auth.api.getSession({
    headers: c.req.raw.headers,
  })) as { user?: { id: string } } | null;

  if (!session?.user) {
    return c.json({ error: "Authentication required" }, 401);
  }

  const db = getDb().db;

  const org = await db
    .selectFrom("organization")
    .select(["id"])
    .where("slug", "=", slug)
    .executeTakeFirst();
  if (!org) {
    return c.json({ role: null, capabilities: {} });
  }

  const member = await db
    .selectFrom("member")
    .select(["role"])
    .where("userId", "=", session.user.id)
    .where("organizationId", "=", org.id)
    .executeTakeFirst();

  const role = member?.role ?? null;
  if (!role) {
    return c.json({ role: null, capabilities: {} });
  }

  // owner / admin bypass every permission check — match AccessControl.
  if (role === "owner" || role === "admin") {
    return c.json({ role, capabilities: allCapabilitiesGranted() });
  }

  // The built-in "user" role has no organizationRole row; its gated grants are
  // baked into code (USER_ROLE_TOOLS, empty by default), NOT stored in the DB.
  // Resolve from that set so UI gating matches the role's `self` grant in the
  // auth config. Empty set → no gated capabilities, same as before.
  if (role === "user") {
    return c.json({
      role,
      capabilities: resolveCapabilities({ self: [...USER_ROLE_TOOLS] }),
    });
  }

  // A custom role is resolved from its stored permission.
  const customRole = await db
    .selectFrom("organizationRole")
    .select(["permission"])
    .where("role", "=", role)
    .where("organizationId", "=", org.id)
    .executeTakeFirst();

  let permission: Record<string, string[]> = {};
  const raw = customRole?.permission;
  if (typeof raw === "string") {
    try {
      const parsed: unknown = JSON.parse(raw);
      // Stored permission must be a JSON object map. Anything else (array,
      // primitive, null) is treated as no permissions rather than trusted —
      // resolveCapabilities is also defensive, but we don't pass it garbage.
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        permission = parsed as Record<string, string[]>;
      }
    } catch {
      permission = {};
    }
  }

  return c.json({ role, capabilities: resolveCapabilities(permission) });
});

/**
 * Domain Lookup Endpoint (authenticated, verified email required)
 *
 * For the onboarding flow: returns the list of organizations that have
 * claimed the authenticated user's email domain. A domain can be claimed
 * by multiple orgs, so callers should present a picker when more than
 * one match is returned.
 *
 * Route: GET /api/auth/custom/domain-lookup
 */
app.get("/domain-lookup", async (c) => {
  const session = (await auth.api.getSession({
    headers: c.req.raw.headers,
  })) as {
    user?: { id: string; email: string; emailVerified: boolean };
  } | null;
  if (!session?.user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }
  if (!session.user.emailVerified) {
    return c.json({ found: false, organizations: [] });
  }
  const domain = session.user.email?.split("@")[1]?.toLowerCase();
  if (!domain || GENERIC_EMAIL_DOMAINS.has(domain)) {
    return c.json({ found: false, organizations: [] });
  }

  try {
    const domainStorage = new OrganizationDomainStorage(getDb().db);
    const records = await domainStorage.getAllByDomain(domain);

    if (records.length === 0) {
      return c.json({ found: false, organizations: [] });
    }

    const orgs = await getDb()
      .db.selectFrom("organization")
      .select(["id", "name", "slug", "logo"])
      .where(
        "id",
        "in",
        records.map((r) => r.organizationId),
      )
      .execute();

    const orgById = new Map(orgs.map((o) => [o.id, o]));
    const organizations = records
      .map((r) => {
        const org = orgById.get(r.organizationId);
        if (!org) return null;
        return {
          id: org.id,
          name: org.name,
          slug: org.slug,
          logo: org.logo,
          autoJoinEnabled: r.autoJoinEnabled,
        };
      })
      .filter((o): o is NonNullable<typeof o> => o !== null);

    return c.json({
      found: organizations.length > 0,
      organizations,
    });
  } catch (error) {
    console.error("[Auth] Domain lookup failed:", error);
    return c.json({ success: false, error: "Domain lookup failed" }, 500);
  }
});

/**
 * Domain Auto-Join Endpoint (authenticated, verified email required)
 *
 * Adds the authenticated user to an organization that claimed their
 * email domain, provided that org has auto_join_enabled. With multiple
 * orgs allowed to claim a domain, callers SHOULD pass the target org's
 * slug in the body (e.g. picked from /domain-lookup). When omitted, the
 * endpoint joins the matching org only if exactly one auto-join-eligible
 * org exists for the domain — otherwise it returns 409 with the list.
 *
 * Route: POST /api/auth/custom/domain-join
 * Body (optional): { organizationSlug?: string }
 */
app.post("/domain-join", async (c) => {
  const session = (await auth.api.getSession({
    headers: c.req.raw.headers,
  })) as {
    user?: { id: string; email: string; emailVerified: boolean };
  } | null;
  if (!session?.user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }
  if (!session.user.emailVerified) {
    return c.json(
      { success: false, error: "Email must be verified to join" },
      403,
    );
  }
  const emailDomain = session.user.email?.split("@")[1]?.toLowerCase();
  if (!emailDomain || GENERIC_EMAIL_DOMAINS.has(emailDomain)) {
    return c.json(
      { success: false, error: "Generic email domains cannot auto-join" },
      403,
    );
  }

  const body = (await c.req.json().catch(() => ({}))) as {
    organizationSlug?: unknown;
  };
  const targetSlug =
    typeof body.organizationSlug === "string" && body.organizationSlug.trim()
      ? body.organizationSlug.trim()
      : null;

  try {
    const db = getDb().db;
    const domainStorage = new OrganizationDomainStorage(db);
    const domainRecords = await domainStorage.getAllByDomain(emailDomain);
    const eligible = domainRecords.filter((r) => r.autoJoinEnabled);
    if (eligible.length === 0) {
      return c.json(
        {
          success: false,
          error: "Auto-join is not available for this domain",
        },
        403,
      );
    }

    // Resolve target org. With a slug, look it up directly and confirm it
    // claims the domain with auto-join. Without a slug, only proceed when
    // exactly one match exists so we never silently pick for the user.
    let org: { id: string; slug: string } | undefined;
    if (targetSlug) {
      const candidate = await db
        .selectFrom("organization")
        .select(["id", "slug"])
        .where("slug", "=", targetSlug)
        .executeTakeFirst();
      if (
        !candidate ||
        !eligible.some((r) => r.organizationId === candidate.id)
      ) {
        return c.json(
          {
            success: false,
            error:
              "This organization is not available for auto-join with your email domain.",
          },
          403,
        );
      }
      org = candidate;
    } else if (eligible.length === 1) {
      const only = await db
        .selectFrom("organization")
        .select(["id", "slug"])
        .where("id", "=", eligible[0]!.organizationId)
        .executeTakeFirst();
      if (!only) {
        return c.json({ success: false, error: "Organization not found" }, 404);
      }
      org = only;
    } else {
      return c.json(
        {
          success: false,
          error: "Multiple organizations match this domain. Please pick one.",
          requiresSelection: true,
        },
        409,
      );
    }

    // Add the user as a member — if they're already a member
    // (e.g. the signup hook already auto-joined them), treat as success.
    try {
      await auth.api.addMember({
        body: {
          userId: session.user.id,
          role: "user",
          organizationId: org.id,
        },
      } as any);
    } catch (addError) {
      const msg =
        addError instanceof Error ? addError.message.toLowerCase() : "";
      if (!msg.includes("already a member")) {
        console.error("[Auth] Domain join addMember failed:", addError);
        return c.json(
          { success: false, error: "Failed to join organization" },
          500,
        );
      }
    }

    posthog.capture({
      distinctId: session.user.id,
      event: "organization_domain_joined",
      groups: { organization: org.id },
      properties: {
        organization_id: org.id,
        organization_slug: org.slug,
        email_domain: emailDomain,
      },
    });

    return c.json({ success: true, slug: org.slug });
  } catch (error) {
    posthog.captureException(error, session.user.id);
    console.error("[Auth] Domain join failed:", error);
    return c.json(
      { success: false, error: "Failed to join organization" },
      500,
    );
  }
});

/**
 * Domain Setup Endpoint (authenticated, verified email required)
 *
 * For first-time corporate email users: creates an org (using a custom name
 * and logo if provided, otherwise derived from the domain), optionally claims
 * the domain with auto-join enabled, and triggers brand extraction via
 * Firecrawl (best-effort — org is created even if extraction fails).
 *
 * Body (all optional):
 *   - name: custom org name (else derived from domain)
 *   - logo: custom logo data URL or URL (else uses extracted favicon)
 *   - claimDomain: defaults to true; set false to skip the domain claim
 *
 * Route: POST /api/auth/custom/domain-setup
 */
app.post("/domain-setup", async (c) => {
  const session = (await auth.api.getSession({
    headers: c.req.raw.headers,
  })) as {
    user?: { id: string; email: string; emailVerified: boolean };
  } | null;
  if (!session?.user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }
  if (!session.user.emailVerified) {
    return c.json({ success: false, error: "Email must be verified" }, 403);
  }
  const emailDomain = session.user.email?.split("@")[1]?.toLowerCase();
  if (!emailDomain || GENERIC_EMAIL_DOMAINS.has(emailDomain)) {
    return c.json({ success: false, error: "Corporate email required" }, 403);
  }

  // Parse optional customization fields from the body. Body is optional —
  // missing/invalid JSON is treated as empty so callers can keep the
  // existing parameterless flow.
  const body = (await c.req.json().catch(() => ({}))) as {
    name?: unknown;
    logo?: unknown;
    claimDomain?: unknown;
  };
  const customName =
    typeof body.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : null;
  const customLogo =
    typeof body.logo === "string" && body.logo.length > 0 ? body.logo : null;
  const shouldClaimDomain = body.claimDomain !== false;

  try {
    const db = getDb().db;
    const domainStorage = new OrganizationDomainStorage(db);

    // If the user already belongs to an org that claims this domain, send
    // them there instead of creating a duplicate. Multiple orgs may claim
    // the same domain, so we look at every claim and pick the first one
    // the user is a member of.
    const existingClaims = await domainStorage.getAllByDomain(emailDomain);
    if (existingClaims.length > 0) {
      const existingMembership = await db
        .selectFrom("member")
        .innerJoin("organization", "organization.id", "member.organizationId")
        .select(["organization.slug"])
        .where("member.userId", "=", session.user.id)
        .where(
          "member.organizationId",
          "in",
          existingClaims.map((c) => c.organizationId),
        )
        .executeTakeFirst();

      if (existingMembership) {
        return c.json({
          success: true,
          slug: existingMembership.slug,
          alreadyExists: true,
        });
      }
    }

    // Org name/slug: prefer caller-supplied name, else derive from domain
    // (e.g. "acme.com" → "Acme" / "acme")
    const domainName = emailDomain.split(".")[0] ?? emailDomain;
    const baseOrgName =
      customName ?? domainName.charAt(0).toUpperCase() + domainName.slice(1);
    const baseSlug =
      (customName ?? domainName)
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9\s_-]+/g, "")
        .replace(/[\s_-]+/g, "-")
        .replace(/^-+|-+$/g, "") ||
      domainName.toLowerCase().replace(/[^a-z0-9-]/g, "");

    // Create the org. Retry with random suffix on slug collision.
    let orgResult: { id: string; slug: string } | null = null;
    {
      const maxAttempts = 3;
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const suffix =
          attempt === 0 ? "" : `-${Math.random().toString(36).slice(2, 6)}`;
        const orgName = attempt === 0 ? baseOrgName : `${baseOrgName}${suffix}`;
        const orgSlug = `${baseSlug}${suffix}`;

        try {
          orgResult = (await auth.api.createOrganization({
            body: {
              name: orgName,
              slug: orgSlug,
              userId: session.user.id,
            },
          } as any)) as unknown as { id: string; slug: string } | null;
          break;
        } catch (createError) {
          const isConflict =
            createError instanceof Error &&
            "body" in createError &&
            (createError as { body?: { code?: string } }).body?.code ===
              "ORGANIZATION_ALREADY_EXISTS";
          if (!isConflict || attempt === maxAttempts - 1) {
            throw createError;
          }
        }
      }
    }

    if (!orgResult?.id) {
      throw new Error("Failed to create organization");
    }
    const orgId = orgResult.id;

    // Claim the domain (optional). Multiple orgs may claim the same
    // domain, so there's no race to handle — the storage layer just
    // inserts another row. Transient DB errors leave the org in place so
    // the user can retry claiming later.
    if (shouldClaimDomain) {
      await domainStorage.setDomain(orgId, emailDomain, true);
    }

    // Brand extraction (best-effort — don't fail the setup if this errors).
    // Captures values to apply after the try/catch so user-provided
    // customizations still take effect even if extraction fails.
    let brandExtracted = false;
    let extractedName: string | null = null;
    let extractedLogo: string | null = null;
    try {
      const firecrawlApiKey = getSettings().firecrawlApiKey;

      if (firecrawlApiKey) {
        const extracted = await extractBrandFromDomain(
          emailDomain,
          firecrawlApiKey,
          baseOrgName,
        );

        if (extracted) {
          const brandStorage = new BrandContextStorage(getDb().db);
          const brand = await brandStorage.create(orgId, extracted);
          await brandStorage.setDefault(brand.id, orgId);
          brandExtracted = true;
          if (extracted.name && extracted.name !== baseOrgName) {
            extractedName = extracted.name;
          }
          extractedLogo = extracted.favicon ?? extracted.logo ?? null;
        }
      }
    } catch (brandError) {
      console.error("[Auth] Brand extraction failed (non-fatal):", brandError);
    }

    // Apply org name/logo. User-provided values always win over extraction.
    const orgUpdate: Record<string, unknown> = {};
    if (!customName && extractedName) orgUpdate.name = extractedName;
    if (customLogo) orgUpdate.logo = customLogo;
    else if (extractedLogo) orgUpdate.logo = extractedLogo;
    if (Object.keys(orgUpdate).length > 0) {
      try {
        await auth.api.updateOrganization({
          headers: c.req.raw.headers,
          body: {
            organizationId: orgId,
            data: orgUpdate,
          },
        });
      } catch (updateError) {
        console.error("[Auth] Org update failed (non-fatal):", updateError);
      }
    }

    posthog.identify({
      distinctId: session.user.id,
      properties: {
        email: session.user.email,
        $set: { email: session.user.email },
        $set_once: { first_organization_created_at: new Date().toISOString() },
      },
    });

    posthog.groupIdentify({
      groupType: "organization",
      groupKey: orgId,
      properties: {
        name: orgResult.slug ?? baseSlug,
        slug: orgResult.slug ?? baseSlug,
        email_domain: emailDomain,
        brand_extracted: brandExtracted,
        created_at: new Date().toISOString(),
      },
    });

    posthog.capture({
      distinctId: session.user.id,
      event: "organization_created",
      groups: { organization: orgId },
      properties: {
        organization_id: orgId,
        organization_slug: orgResult.slug ?? baseSlug,
        email_domain: emailDomain,
        brand_extracted: brandExtracted,
      },
    });

    return c.json({
      success: true,
      slug: orgResult.slug ?? baseSlug,
      brandExtracted,
    });
  } catch (error) {
    posthog.captureException(error, session.user?.id);
    console.error("[Auth] Domain setup failed:", error);
    return c.json(
      { success: false, error: "Failed to set up organization" },
      500,
    );
  }
});

/**
 * Org Access Status Endpoint (authenticated)
 *
 * For the shell layout's "you visited /:org/... but aren't a member" branch.
 * Resolves an org by slug and tells the frontend which screen to render:
 *
 *   member            — user is already a member (shell should re-fetch)
 *   pending-invite    — there's a pending invitation for this email
 *   auto-domain-join  — the org has auto_join_enabled for the user's verified domain
 *   no-access         — none of the above
 *   not-found         — slug doesn't resolve
 *
 * Route: GET /api/auth/custom/org-access-status/:slug
 */
app.get("/org-access-status/:slug", async (c) => {
  const slug = c.req.param("slug");
  const session = (await auth.api.getSession({
    headers: c.req.raw.headers,
  })) as {
    user?: { id: string; email: string; emailVerified: boolean };
  } | null;
  if (!session?.user) {
    return c.json({ success: false, error: "Authentication required" }, 401);
  }

  const db = getDb().db;

  const org = await db
    .selectFrom("organization")
    .select(["id", "name", "slug", "logo"])
    .where("slug", "=", slug)
    .executeTakeFirst();

  if (!org) {
    return c.json({ status: "not-found" as const });
  }

  const orgPayload = {
    id: org.id,
    name: org.name,
    slug: org.slug,
    logo: org.logo,
  };

  const membership = await db
    .selectFrom("member")
    .select(["id"])
    .where("userId", "=", session.user.id)
    .where("organizationId", "=", org.id)
    .executeTakeFirst();

  if (membership) {
    return c.json({ status: "member" as const, organization: orgPayload });
  }

  // Pending invite for this user's email targeting this org?
  try {
    const invitations = (await auth.api.listUserInvitations({
      headers: c.req.raw.headers,
    })) as Array<{
      id: string;
      organizationId: string;
      status: string;
      expiresAt: string | Date;
    }>;
    const now = Date.now();
    const match = invitations.find(
      (inv) =>
        inv.organizationId === org.id &&
        inv.status === "pending" &&
        new Date(inv.expiresAt).getTime() > now,
    );
    if (match) {
      return c.json({
        status: "pending-invite" as const,
        invitation: { id: match.id },
        organization: orgPayload,
      });
    }
  } catch (error) {
    // listUserInvitations can fail for unverified emails or transient DB
    // issues — fall through to the auto-domain-join / no-access checks
    // rather than failing the whole status lookup.
    console.error("[Auth] listUserInvitations failed:", error);
  }

  // Auto domain join: org claimed user's domain with auto_join_enabled.
  if (session.user.emailVerified) {
    const emailDomain = session.user.email?.split("@")[1]?.toLowerCase();
    if (emailDomain && !GENERIC_EMAIL_DOMAINS.has(emailDomain)) {
      const domainRecord = await new OrganizationDomainStorage(
        db,
      ).getByOrganizationId(org.id);
      if (
        domainRecord?.autoJoinEnabled &&
        domainRecord.domain === emailDomain
      ) {
        return c.json({
          status: "auto-domain-join" as const,
          organization: { ...orgPayload, domain: emailDomain },
        });
      }
    }
  }

  return c.json({ status: "no-access" as const, organization: orgPayload });
});

export default app;
