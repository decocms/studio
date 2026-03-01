/**
 * Better Auth Configuration for MCP Mesh
 *
 * Provides:
 * - MCP OAuth 2.1 server (via MCP plugin)
 * - API Key management (via API Key plugin)
 * - Role-based access control (via Admin plugin)
 *
 * Configuration is file-based (auth-config.json), not environment variables.
 */

import { getToolsByCategory } from "@/tools/registry";
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
import {
  adminAc,
  defaultStatements,
} from "better-auth/plugins/organization/access";

import { config } from "@/core/config";
import { getBaseUrl } from "@/core/server-constants";
import { createAccessControl, Role } from "@decocms/better-auth/plugins/access";
import { getDatabaseUrl, getDbDialect } from "../database";
import { createEmailSender, findEmailProvider } from "./email-providers";
import { createMagicLinkConfig } from "./magic-link";
import { seedOrgDb } from "./org";
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

export const authConfig = config.auth;

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
      const acceptUrl = `${getBaseUrl()}/auth/accept-invitation?invitationId=${data.invitation.id}&redirectTo=/`;

      await sendEmail({
        to: data.email,
        subject: `Invitation to join ${data.organization.name}`,
        html: `
          <h2>You've been invited!</h2>
          <p>${inviterName} has invited you to join <strong>${data.organization.name}</strong>.</p>
          <p><a href="${acceptUrl}">Click here to accept the invitation</a></p>
        `,
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
      void sendEmail({
        to: user.email,
        subject: "Reset your password",
        html: `
          <h2>Reset your password</h2>
          <p>Click the link below to reset your password:</p>
          <p><a href="${url}">Reset password</a></p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
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

  ...(authConfig.magicLinkConfig &&
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
];

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
  const url = new URL(baseUrl);
  if (url.hostname === "localhost") {
    origins.push(baseUrl.replace("localhost", "127.0.0.1"));
  } else if (url.hostname === "127.0.0.1") {
    origins.push(baseUrl.replace("127.0.0.1", "localhost"));
  }
  return origins;
}

export const auth = betterAuth({
  // Base URL for OAuth - will be overridden by request context
  baseURL: baseUrl,

  trustedOrigins: getTrustedOrigins(),

  // Better Auth can use the dialect directly
  database,

  // Load optional configuration from file
  ...authConfig,

  emailAndPassword: {
    enabled: true,
    ...authConfig.emailAndPassword,
    ...(sendResetPassword ? { sendResetPassword } : {}),
  },

  // Disable rate limiting in development (set DISABLE_RATE_LIMIT=true)
  // Must be AFTER authConfig spread to ensure it takes precedence
  rateLimit: {
    enabled: process.env.DISABLE_RATE_LIMIT !== "true",
    window: 60,
    max: 10000, // Very high limit as fallback
  },

  plugins,

  // Database hooks for automatic organization creation on signup
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          // Check if auto-creation is enabled (default: true)
          if (config.autoCreateOrganizationOnSignup === false) {
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
              await auth.api.createOrganization({
                body: {
                  name: orgName,
                  slug: orgSlug,
                  userId: user.id,
                },
              });
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
  },
});

export type BetterAuthInstance = typeof auth;

// ============================================================================
// Helper Functions
// ============================================================================
