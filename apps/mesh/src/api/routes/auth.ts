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
 * Domain Lookup Endpoint (authenticated, verified email required)
 *
 * For the onboarding flow: checks if the authenticated user's email domain
 * has a claimed organization. Derives the domain from the session — no
 * query params needed.
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
    return c.json({ found: false });
  }

  const domain = session.user.email?.split("@")[1]?.toLowerCase();
  if (!domain || GENERIC_EMAIL_DOMAINS.has(domain)) {
    return c.json({ found: false });
  }

  try {
    const domainStorage = new OrganizationDomainStorage(getDb().db);
    const record = await domainStorage.getByDomain(domain);

    if (!record) {
      return c.json({ found: false });
    }

    const org = await getDb()
      .db.selectFrom("organization")
      .select(["name", "slug"])
      .where("id", "=", record.organizationId)
      .executeTakeFirst();

    return c.json({
      found: true,
      autoJoinEnabled: record.autoJoinEnabled,
      organization: org ? { name: org.name, slug: org.slug } : null,
    });
  } catch (error) {
    console.error("[Auth] Domain lookup failed:", error);
    return c.json({ success: false, error: "Domain lookup failed" }, 500);
  }
});

/**
 * Domain Auto-Join Endpoint (authenticated, verified email required)
 *
 * Adds the authenticated user to the organization that claimed their
 * email domain, provided auto_join_enabled is true. Everything is
 * derived from the session — no request body needed.
 *
 * Route: POST /api/auth/custom/domain-join
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

  try {
    const domainStorage = new OrganizationDomainStorage(getDb().db);
    const domainRecord = await domainStorage.getByDomain(emailDomain);
    if (!domainRecord || !domainRecord.autoJoinEnabled) {
      return c.json(
        {
          success: false,
          error: "Auto-join is not available for this domain",
        },
        403,
      );
    }

    const org = await getDb()
      .db.selectFrom("organization")
      .select(["id", "slug"])
      .where("id", "=", domainRecord.organizationId)
      .executeTakeFirst();
    if (!org) {
      return c.json({ success: false, error: "Organization not found" }, 404);
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
 * For first-time corporate email users: creates an org named after their
 * email domain, claims the domain with auto-join enabled, and triggers
 * brand extraction via Firecrawl (best-effort — org is created even if
 * extraction fails).
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

  try {
    const db = getDb().db;
    const domainStorage = new OrganizationDomainStorage(db);

    // Check if domain is already claimed
    const existing = await domainStorage.getByDomain(emailDomain);
    if (existing) {
      // Verify the user is actually a member of this org
      const membership = await db
        .selectFrom("member")
        .innerJoin("organization", "organization.id", "member.organizationId")
        .select(["organization.slug"])
        .where("member.userId", "=", session.user.id)
        .where("member.organizationId", "=", existing.organizationId)
        .executeTakeFirst();

      if (membership) {
        return c.json({
          success: true,
          slug: membership.slug,
          alreadyExists: true,
        });
      }

      // Domain claimed but user isn't a member — they can't use this flow
      return c.json(
        {
          success: false,
          error:
            "This domain is already claimed. Ask an admin for an invitation.",
        },
        403,
      );
    }

    // Derive org name/slug from domain (e.g. "acme.com" → "Acme" / "acme")
    const domainName = emailDomain.split(".")[0] ?? emailDomain;
    const baseOrgName =
      domainName.charAt(0).toUpperCase() + domainName.slice(1);
    const baseSlug = domainName.toLowerCase().replace(/[^a-z0-9-]/g, "");

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

    // Claim the domain. Only clean up the org on a domain race (specific
    // "already claimed" error from the storage layer). Transient DB errors
    // should not delete the org — it can be reclaimed later.
    try {
      await domainStorage.setDomain(orgId, emailDomain, true);
    } catch (claimError) {
      const isDomainRace =
        claimError instanceof Error &&
        claimError.message.includes("already claimed");
      if (isDomainRace) {
        try {
          await auth.api.deleteOrganization({
            headers: c.req.raw.headers,
            body: { organizationId: orgId },
          });
        } catch {
          console.error(
            "[Auth] Failed to clean up orphaned org after domain race:",
            orgId,
          );
        }
        return c.json(
          {
            success: false,
            error:
              "This domain was just claimed by another user. Please refresh and try again.",
          },
          409,
        );
      }
      // Transient error — org exists but domain claim failed. Don't delete.
      throw claimError;
    }

    // Brand extraction (best-effort — don't fail the setup if this errors)
    let brandExtracted = false;
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

          // Update org: name from brand, favicon as org logo
          // (favicons are small/reliable; full logos often hit size limits)
          const orgLogo = extracted.favicon ?? extracted.logo ?? null;
          const orgUpdate: Record<string, unknown> = {};
          if (extracted.name !== baseOrgName) orgUpdate.name = extracted.name;
          if (orgLogo) orgUpdate.logo = orgLogo;
          if (Object.keys(orgUpdate).length > 0) {
            await auth.api.updateOrganization({
              headers: c.req.raw.headers,
              body: {
                organizationId: orgId,
                data: orgUpdate,
              },
            });
          }
        }
      }
    } catch (brandError) {
      console.error("[Auth] Brand extraction failed (non-fatal):", brandError);
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

export default app;
