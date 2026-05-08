/**
 * Better Auth Configuration for deco Studio
 *
 * Provides:
 * - MCP OAuth 2.1 server (via MCP plugin)
 * - API Key management (via API Key plugin)
 * - Role-based access control (via Admin plugin)
 *
 * Configuration is file-based (auth-config.json), not environment variables.
 */

import { getSettings } from "../settings";
import { getToolsByCategory } from "@/tools/registry-metadata";
import { sso } from "@better-auth/sso";
import { organization } from "@decocms/better-auth/plugins";
import { betterAuth, BetterAuthOptions } from "better-auth";
import {
  admin as adminPlugin,
  apiKey,
  jwt,
  magicLink,
  mcp,
  openAPI,
  OrganizationOptions,
} from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/organization/access";

import { getConfig } from "@/core/config";
import { posthog } from "@/posthog";
import { getBaseUrl } from "@/core/server-constants";
import { createAccessControl, Role } from "@decocms/better-auth/plugins/access";
import { getDb, getDatabaseUrl, getDbDialect } from "../database";
import { OrganizationDomainStorage } from "../storage/organization-domains";
import { createEmailOtpConfig } from "./email-otp";
import { createEmailSender, findEmailProvider } from "./email-providers";
import { emailButton, emailParagraph, emailTemplate } from "./email-template";
import { createMagicLinkConfig } from "./magic-link";
import { seedOrgDb } from "./org";
import { identifyAuthenticatedUser } from "./posthog-identify";
import { ADMIN_ROLES } from "./roles";
import { createSSOConfig } from "./sso";

/**
 * Convert a string to a URL-friendly slug
 * Removes special characters, converts to lowercase, and replaces spaces with hyphens
 */
function slugify(input: string): string {
  return input
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s_-]+/g, "")
    .replace(/[\s_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Random words to use as suffix when organization name already exists
 */
const ORG_NAME_TECH_SUFFIXES = [
  "labs",
  "agent",
  "studio",
  "workspace",
  "systems",
  "core",
  "cloud",
  "works",
];

const ORG_NAME_BR_SUFFIXES = [
  "capybara",
  "guarana",
  "deco",
  "samba",
  "feijoada",
  "capoeira",
  "carnival",
];

function getRandomSuffix(): string {
  const brIndex = Math.floor(Math.random() * ORG_NAME_BR_SUFFIXES.length);
  const techIndex = Math.floor(Math.random() * ORG_NAME_TECH_SUFFIXES.length);
  const brSuffix = ORG_NAME_BR_SUFFIXES[brIndex] ?? "deco";
  const techSuffix = ORG_NAME_TECH_SUFFIXES[techIndex] ?? "studio";
  return `${brSuffix}-${techSuffix}`;
}

const allTools = Object.values(getToolsByCategory())
  .map((tool) => tool.map((t) => t.name))
  .flat();
const statement = { ...defaultStatements, self: ["*", ...allTools] };

const ac = createAccessControl(statement);

const user = ac.newRole({
  self: ["*"],
  ...adminAc.statements,
}) as Role;

const admin = ac.newRole({
  self: ["*"],
  ...adminAc.statements,
}) as Role;

const owner = ac.newRole({
  self: ["*"],
  ...adminAc.statements,
}) as Role;

const scopes = Object.values(getToolsByCategory())
  .map((tool) => tool.map((t) => `self:${t.name}`))
  .flat();

export const authConfig = getConfig().auth;

let sendInvitationEmail: OrganizationOptions["sendInvitationEmail"] = undefined;

// Configure invitation emails if provider is set
if (
  authConfig.inviteEmailProviderId &&
  authConfig.emailProviders &&
  authConfig.emailProviders.length > 0
) {
  const inviteProvider = findEmailProvider(
    authConfig.emailProviders,
    authConfig.inviteEmailProviderId,
  );

  if (inviteProvider) {
    const sendEmail = createEmailSender(inviteProvider);

    sendInvitationEmail = async (data) => {
      const inviterName = data.inviter.user?.name || data.inviter.user?.email;
      const acceptUrl = `${getBaseUrl()}/auth/accept-invitation?invitationId=${data.invitation.id}&redirectTo=/${data.organization.slug}`;

      await sendEmail({
        to: data.email,
        subject: `You've been invited to join ${data.organization.name}`,
        html: emailTemplate({
          preheader: `${inviterName} has invited you to join ${data.organization.name} on deco Studio.`,
          heading: "You've been invited",
          subheading: `<strong>${inviterName}</strong> has invited you to join <strong>${data.organization.name}</strong> on deco Studio.`,
          body: emailButton("Accept invitation", acceptUrl),
          footnote:
            "If you weren\u2019t expecting an invitation, you can safely ignore this email.",
        }),
      });
    };
  }
}

// Configure password reset emails if provider is set
let sendResetPassword:
  | NonNullable<BetterAuthOptions["emailAndPassword"]>["sendResetPassword"]
  | undefined = undefined;

export let resetPasswordEnabled = false;

if (
  authConfig.resetPasswordEmailProviderId &&
  authConfig.emailProviders &&
  authConfig.emailProviders.length > 0
) {
  const resetProvider = findEmailProvider(
    authConfig.emailProviders,
    authConfig.resetPasswordEmailProviderId,
  );

  if (resetProvider) {
    const sendEmail = createEmailSender(resetProvider);
    resetPasswordEnabled = true;

    sendResetPassword = async ({ user, url }) => {
      await sendEmail({
        to: user.email,
        subject: "Reset your password",
        html: emailTemplate({
          preheader:
            "We received a request to reset the password on your deco Studio account.",
          heading: "Reset your password",
          subheading:
            "We received a password reset request for your account. Click the button below to choose a new password.",
          body:
            emailButton("Reset password", url) +
            emailParagraph(
              "This link expires in 24\u00a0hours. If you didn\u2019t request a password reset, no action is needed.",
              true,
            ),
          footnote:
            "If you didn\u2019t request a password reset, you can safely ignore this email.",
        }),
      });
    };
  }
}

const plugins = [
  // Organization plugin for multi-tenant organization management
  // https://www.better-auth.com/docs/plugins/organization
  organization({
    organizationCreation: {
      afterCreate: async (data) => {
        await seedOrgDb(data.organization.id, data.member.userId);
      },
    },
    ac,
    creatorRole: "owner",
    allowUserToCreateOrganization: true, // Users can create organizations by default
    dynamicAccessControl: {
      enabled: true,
      maximumRolesPerOrganization: 500,
      enableCustomResources: true,
      allowedRolesToCreateResources: ADMIN_ROLES,
      resourceNameValidation: (name: string) => {
        // allow only alphanumeric characters, hyphens and underscores
        return {
          valid: /^[a-zA-Z0-9-_]+$/.test(name),
        };
      },
    },
    roles: {
      user,
      admin,
      owner,
    },
    sendInvitationEmail,
  }),

  // MCP plugin for OAuth 2.1 server
  // https://www.better-auth.com/docs/plugins/mcp
  mcp({
    loginPage: "/login",
    // Note: Authorization page (/authorize) is served as static HTML
    // Better Auth will redirect there based on loginPage flow
    oidcConfig: {
      scopes: scopes,
      metadata: { scopes_supported: scopes },
      loginPage: "/login",
    },
  }),

  // API Key plugin for direct tool access
  // https://www.better-auth.com/docs/plugins/api-key
  apiKey({
    enableMetadata: true,
    maximumNameLength: 64,
    keyExpiration: {
      minExpiresIn: 5 / 1440, // 5 minutes in days (default is 1 day)
    },
    enableSessionForAPIKeys: true,
    customAPIKeyGetter: (ctx) => {
      // Skip API key validation when MCP OAuth session auth is being used
      // The Bearer token in this case is an OAuth access token, not an API key
      const isMcpSessionAuth = ctx.headers?.get("X-MCP-Session-Auth");
      if (isMcpSessionAuth === "true") {
        return null;
      }

      const header = ctx.headers?.get("Authorization");
      if (header?.startsWith("Bearer ")) {
        return header.replace("Bearer ", "").trim();
      }
      return null;
    },
    permissions: {
      defaultPermissions: {
        self: [
          "ORGANIZATION_LIST",
          "ORGANIZATION_GET", // Organization read access
          "ORGANIZATION_MEMBER_LIST", // Member read access
          "COLLECTION_CONNECTIONS_LIST",
          "COLLECTION_CONNECTIONS_GET", // Connection read access
          "API_KEY_CREATE", // API key creation
          "API_KEY_LIST", // API key listing (metadata only)
          // Note: API_KEY_UPDATE and API_KEY_DELETE are not default - users must explicitly request
        ],
      },
    },
    rateLimit: {
      enabled: false,
    },
  }),

  // Admin plugin for system-level super-admins
  // https://www.better-auth.com/docs/plugins/admin
  adminPlugin({
    defaultRole: "user",
    adminRoles: ["admin", "owner"],
  }),

  // OpenAPI plugin for API documentation
  // https://www.better-auth.com/docs/plugins/openAPI
  openAPI(),

  // JWT plugin for issuing tokens with custom payloads
  // https://www.better-auth.com/docs/plugins/jwt
  // Used by proxy routes to issue short-lived tokens with connection metadata
  jwt({
    jwt: {
      // Short expiration for proxy tokens (5 minutes)
      expirationTime: "5m",
    },
  }),

  sso(authConfig.ssoConfig ? createSSOConfig(authConfig.ssoConfig) : undefined),

  ...(authConfig.magicLinkConfig?.enabled &&
  authConfig.emailProviders &&
  authConfig.emailProviders.length > 0
    ? [
        magicLink(
          createMagicLinkConfig(
            authConfig.magicLinkConfig,
            authConfig.emailProviders,
          ),
        ),
      ]
    : []),

  ...(authConfig.emailOtpConfig?.enabled &&
  authConfig.emailProviders &&
  authConfig.emailProviders.length > 0
    ? [
        emailOTP(
          createEmailOtpConfig(
            authConfig.emailOtpConfig,
            authConfig.emailProviders,
          ),
        ),
      ]
    : []),
];

/**
 * Generic email providers that should be skipped for domain-based auto-join.
 */
const GENERIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "yahoo.co.uk",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
  "zoho.com",
  "yandex.com",
  "mail.com",
  "gmx.com",
  "gmx.net",
  "tutanota.com",
  "fastmail.com",
]);

export { GENERIC_EMAIL_DOMAINS };

const databaseUrl = getDatabaseUrl();

// Get dialect without creating the full Kysely instance
// Better Auth can use the dialect directly
const database = getDbDialect(databaseUrl);

/**
 * Better Auth instance with MCP, API Key, and Admin plugins
 */
const baseUrl = getBaseUrl();

// Build trusted origins: include both localhost and 127.0.0.1 variants
function getTrustedOrigins(): string[] {
  const origins = [baseUrl];
  try {
    const url = new URL(baseUrl);
    if (url.hostname === "localhost") {
      origins.push(baseUrl.replace("localhost", "127.0.0.1"));
    } else if (url.hostname === "127.0.0.1") {
      origins.push(baseUrl.replace("127.0.0.1", "localhost"));
    }
  } catch {
    // baseUrl may be invalid during tests when PORT is not set
  }
  return origins;
}

const settings = getSettings();

export const auth = betterAuth({
  secret: settings.betterAuthSecret || "deco-default-secret-k7x9m2p4q8w3n5v6",

  // Base URL for OAuth - will be overridden by request context
  baseURL: baseUrl,

  trustedOrigins: getTrustedOrigins(),

  // Better Auth can use the dialect directly
  database,

  // Auth providers from AUTH_* env vars
  socialProviders: authConfig.socialProviders,

  // Automatic account linking for SSO providers
  ...(authConfig.ssoConfig && {
    account: {
      accountLinking: {
        trustedProviders: [authConfig.ssoConfig.providerId],
      },
    },
  }),

  emailAndPassword: {
    enabled: authConfig.emailAndPassword.enabled,
    ...(sendResetPassword && { sendResetPassword }),
  },

  // Disable rate limiting in development (set DISABLE_RATE_LIMIT=true)
  // Must be AFTER authConfig spread to ensure it takes precedence
  rateLimit: {
    enabled: !settings.disableRateLimit,
    window: 60,
    max: 10000, // Very high limit as fallback
  },

  plugins,

  // Database hooks for automatic organization creation on signup
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Tag the PostHog person record with email/name BEFORE the
          // user_signed_up capture so that event lands on a person record
          // that already has $set: { email } applied.
          identifyAuthenticatedUser({
            id: user.id,
            email: user.email,
            name: user.name ?? null,
            emailVerified: !!user.emailVerified,
          });

          // Top-of-funnel signup event. Fires once per new user account,
          // before any org is created. Use this (not organization_created)
          // to measure raw signup volume.
          posthog.capture({
            distinctId: user.id,
            event: "user_signed_up",
            properties: {
              email: user.email,
              email_domain: user.email?.split("@")[1]?.toLowerCase() ?? null,
              email_verified: !!user.emailVerified,
              has_name: !!user.name,
            },
          });

          // Domain-based handling for verified corporate emails.
          // 1. If an org claimed the domain with auto-join → add as member
          // 2. If corporate but unclaimed → skip default org creation so
          //    the user hits /onboarding to set up their company org
          if (user.emailVerified) {
            const emailDomain = user.email?.split("@")[1]?.toLowerCase();
            if (emailDomain && !GENERIC_EMAIL_DOMAINS.has(emailDomain)) {
              let domainHandled = false;
              try {
                const domainStorage = new OrganizationDomainStorage(getDb().db);
                const domainRecord =
                  await domainStorage.getByDomain(emailDomain);

                if (domainRecord?.autoJoinEnabled) {
                  await auth.api.addMember({
                    body: {
                      userId: user.id,
                      role: "user",
                      organizationId: domainRecord.organizationId,
                    },
                  } as any);
                  return;
                }
                // Corporate email, no auto-join → let /onboarding handle it
                domainHandled = true;
              } catch (error) {
                console.error("[Auth] Domain auto-join check failed:", error);
                // domainHandled stays false → fall through to default org creation
              }

              if (domainHandled) return;
            }
          }

          // Check if auto-creation is enabled (default: true)
          if (getConfig().autoCreateOrganizationOnSignup === false) {
            return;
          }

          const firstName = user.name
            ? user.name.split(" ")[0]
            : user.email.split("@")[0];

          const maxAttempts = 3;
          for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const orgName = `${firstName} ${getRandomSuffix()}`;
            const orgSlug = slugify(orgName);

            try {
              const created = await auth.api.createOrganization({
                body: {
                  name: orgName,
                  slug: orgSlug,
                  userId: user.id,
                },
              });

              // Group identify for team-level analytics.
              const orgId =
                (created as { id?: string } | null)?.id ?? undefined;
              if (orgId) {
                posthog.groupIdentify({
                  groupType: "organization",
                  groupKey: orgId,
                  properties: {
                    name: orgName,
                    slug: orgSlug,
                    created_at: new Date().toISOString(),
                    created_via: "signup_default",
                  },
                });
                posthog.capture({
                  distinctId: user.id,
                  event: "organization_created",
                  groups: { organization: orgId },
                  properties: {
                    organization_id: orgId,
                    organization_slug: orgSlug,
                    created_via: "signup_default",
                  },
                });
              }
              return;
            } catch (error) {
              const isConflictError =
                error instanceof Error &&
                "body" in error &&
                (error as { body?: { code?: string } }).body?.code ===
                  "ORGANIZATION_ALREADY_EXISTS";

              if (!isConflictError || attempt === maxAttempts - 1) {
                console.error("Failed to create default organization:", error);
                return;
              }
            }
          }
        },
      },
    },
    session: {
      create: {
        // Re-identify on every successful login (email/password, OTP,
        // magic link, SSO). PostHog merges person properties server-side,
        // so this is idempotent and provides automatic backfill for
        // existing users whose person records were created before
        // posthog.identify was wired into the auth flow.
        after: async (session) => {
          const row = await getDb()
            .db.selectFrom("user")
            .select(["id", "email", "name", "emailVerified"])
            .where("id", "=", session.userId)
            .executeTakeFirst();

          if (!row) return;

          identifyAuthenticatedUser({
            id: row.id,
            email: row.email,
            name: row.name ?? null,
            emailVerified: !!row.emailVerified,
          });
        },
      },
    },
  },
});

export type BetterAuthInstance = typeof auth;

// ============================================================================
// Helper Functions
// ============================================================================
