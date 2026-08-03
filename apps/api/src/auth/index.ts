/**
 * Better Auth Configuration for deco Studio
 *
 * Provides:
 * - MCP OAuth 2.1 server (via MCP plugin)
 * - API Key management (via API Key plugin)
 * - Role-based access control (via Admin plugin)
 *
 * Configuration comes from AUTH_* environment variables (see auth-env.ts).
 */

import { randomBytes } from "crypto";
import { getSettings } from "../settings";
import { getToolsByCategory } from "@decocms/shared/tools/registry-metadata";
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
import { APIError } from "better-auth/api";
import {
  adminAc as systemAdminAc,
  defaultRoles as systemDefaultRoles,
} from "better-auth/plugins/admin/access";
import { defaultStatements } from "@decocms/better-auth/plugins/organization/access";

import { getConfig } from "@/core/config";
import { posthog } from "@/posthog";
import { getBaseUrl } from "@/core/server-constants";
import { createAccessControl, Role } from "@decocms/better-auth/plugins/access";
import { getDb, getDatabaseUrl, getDbDialect } from "../database";
import { createEmailOtpConfig } from "./email-otp";
import { createEmailSender, findEmailProvider } from "./email-providers";
import { emailButton, emailParagraph, emailTemplate } from "./email-template";
import { createMagicLinkConfig } from "./magic-link";
import { releaseSeat, seedOrgDb } from "./org";
import { hoistOrgLogo } from "./hoist-org-logo";
import { identifyAuthenticatedUser } from "./posthog-identify";
import { ADMIN_ROLES } from "@decocms/shared/auth/roles";
import { getBuiltinRoleStatements } from "./builtin-role-permission";
import { createSSOConfig } from "./sso";
import { GENERIC_EMAIL_DOMAINS } from "./org-assurance-policy";
import { ensureUserOrganization } from "./ensure-user-organization";
import { isReservedOrganizationSlug } from "@decocms/shared/organization-slugs";

function rejectReservedOrganizationSlug(slug: unknown): void {
  if (!isReservedOrganizationSlug(slug)) return;
  throw new APIError("BAD_REQUEST", {
    message: `Organization slug "${String(slug).trim()}" is reserved by Studio`,
  });
}

const allTools = Object.values(getToolsByCategory())
  .map((tool) => tool.map((t) => t.name))
  .flat();
const statement = { ...defaultStatements, self: ["*", ...allTools] };

const ac = createAccessControl(statement);

// Single source of truth for built-in role → statement. The in-memory Flow 2
// matcher (`builtin-role-permission.ts`) consumes the SAME builder, so the
// org-plugin roles below and the in-memory resolution cannot drift.
const builtinRoleStatements = getBuiltinRoleStatements(allTools);

// The role-creating built-in roles (owner/admin) must enumerate every `self`
// tool, not just `["*"]`. Better Auth's access-control `authorize()` matches
// actions literally — `["*"]` authorizes only a request for the literal action
// "*", NOT specific tools. Runtime checks bypass this for owner/admin, but
// `create-role` gates the *creator* on whether they hold each permission they
// grant; with `self: ["*"]` an owner is reported as "missing self:SOME_TOOL"
// and can't create a capability-scoped custom role at all. Enumerating the full
// tool list fixes that.
//
// `user`'s `self` is exactly USER_ROLE_TOOLS — the gated tools granted to every
// member beyond basic-usage (empty by default; see registry-metadata). It is
// enforced at runtime: only owner/admin bypass (see ADMIN_ROLES), so this grant
// IS consulted. It must NEVER contain `"*"` — `createBoundAuthClient` falls back
// to a `{ self: ["*"] }` wildcard probe when the exact check misses, and a `"*"`
// here would satisfy it and hand every member full access (the bypass we removed).
// Specific tool names match only via the exact check. A member otherwise gets
// only basic-usage (granted out-of-band in AccessControl) plus connection-scoped
// grants, and can't create roles (allowedRolesToCreateResources = ADMIN_ROLES).
// `user` spreads `memberAc` (the org plugin's member role), NOT `adminAc`. These
// org statements (organization/member/invitation/team/ac) gate Better Auth's
// native org-plugin endpoints — not MCP tools, which our AccessControl checks on
// `self`/connection buckets. `adminAc` grants org:update + member/invitation/team
// management; spreading it here would let a plain member manage the org via those
// endpoints. `memberAc` grants only `ac: ["read"]` (read roles for the UI).
//
// All three statements come from `getBuiltinRoleStatements` so the runtime
// org-plugin roles and the in-memory Flow 2 matcher share one definition.
// `getBuiltinRoleStatements` returns the loose `Permission` shape
// (Record<string,string[]>); `newRole` wants the statement's literal `Subset`
// type. The runtime values are exactly the statements compiled into `ac`, so
// cast the argument to the parameter type — the result cast to `Role` is the
// same one the original inline definitions used.
type NewRoleArg = Parameters<typeof ac.newRole>[0];

const user = ac.newRole(builtinRoleStatements.user as NewRoleArg) as Role;

const admin = ac.newRole(builtinRoleStatements.admin as NewRoleArg) as Role;

const owner = ac.newRole(builtinRoleStatements.owner as NewRoleArg) as Role;

const scopes = Object.values(getToolsByCategory())
  .map((tool) => tool.map((t) => `self:${t.name}`))
  .flat();

/**
 * Deployment admin user IDs, resolved lazily from `deploymentAdminEmails` by
 * the `/api/_admin/*` middleware (apps/api/src/api/routes/admin.ts) on each
 * verified admin's first request. Better Auth's admin plugin shallow-spreads
 * the options object it's given at plugin-init time, so `adminUserIds` below
 * keeps a reference to THIS array — `hasPermission` (better-auth 1.4.22,
 * plugins/admin/has-permission.mjs) reads `options.adminUserIds.includes(id)`
 * at call time, so pushing here is visible immediately. Push-only and
 * per-process: it rebuilds empty on every restart, so revocation (removing an
 * email from config) is exactly as fresh as a restart. Re-verify this note on
 * any better-auth upgrade that touches the admin plugin's options handling.
 *
 * IMPORTANT: this makes the id a full admin for the ENTIRE admin plugin, so the
 * raw `/api/auth/admin/*` HTTP surface (set-role, set-user-password, ...) is
 * fenced off in app.ts — everything the dashboard needs goes through the
 * curated `/api/_admin/*` routes, which call `auth.api.*` in-process and
 * re-check the email allowlist on every request. Without that fence a pushed id
 * could mint a persistent, restart-surviving admin via set-role.
 */
const deploymentAdminUserIds: string[] = [];

/**
 * Register a verified, allowlisted operator's id for the raw admin-plugin
 * privilege (see above). The `/api/_admin/*` middleware calls this on each such
 * request; the grant logic and the shallow-spread caveat live here in one place
 * rather than the route poking the module array directly. Push-only + deduped.
 */
export function grantDeploymentAdmin(userId: string): void {
  if (!deploymentAdminUserIds.includes(userId)) {
    deploymentAdminUserIds.push(userId);
  }
}

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
    organizationHooks: {
      // This is the canonical creation boundary: it also covers direct calls
      // to Better Auth's /organization/create endpoint, not only Studio's UI
      // and MCP tool wrappers.
      beforeCreateOrganization: async ({ organization }) => {
        rejectReservedOrganizationSlug(organization.slug);
      },
      // Seat lifecycle (per-seat billing) at the canonical membership
      // boundaries — these hooks cover EVERY add/remove path (tools, direct
      // Better Auth endpoints, invitation accepts, join-request approvals),
      // and both are fail-soft: seats must never break membership itself.
      //
      // afterAddMember: invites always land FREE — dropping any stale
      // paid-seat row here means a crash between a removal and its seat
      // release can't resurrect the seat when the user rejoins. (Between
      // those two moments the stale row is harmless: every seat count joins
      // against `member`, so a non-member row never bills.)
      afterAddMember: async ({ member }) => {
        try {
          await releaseSeat(
            member.organizationId,
            member.userId,
            "system:join",
          );
        } catch (err) {
          console.error("Failed to reset seat on member join:", err);
        }
      },
      // afterRemoveMember: a removed member stops counting toward the org's
      // bill and gateway allowance.
      afterRemoveMember: async ({ member }) => {
        try {
          await releaseSeat(
            member.organizationId,
            member.userId,
            "system:member-removed",
          );
        } catch (err) {
          console.error("Failed to release seat on member removal:", err);
        }
      },
      // Keep base64 logos out of the org row (they bloat every
      // organization.list response). Mirrors `backfill-assets
      // --target organizations`; raster only — SVG stays inline.
      beforeUpdateOrganization: async ({ organization, member }) => {
        // Better Auth allows slug changes directly, so creation-only
        // validation could otherwise be bypassed by renaming an existing org.
        rejectReservedOrganizationSlug(organization.slug);

        const logo = organization.logo;
        if (typeof logo !== "string" || !logo.startsWith("data:")) return;
        const hoisted = await hoistOrgLogo(member.organizationId, logo);
        if (hoisted === logo) return;
        return { data: { ...organization, logo: hoisted } };
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
    // No `defaultPermissions`: every key is created with an explicit scope (the
    // API_KEY_CREATE tool requires `permissions`, and the internal minters pass
    // their own). A key is authorized solely by its allowlist — see
    // auth/api-key-permissions.ts. A key with no allowlist grants nothing.
    rateLimit: {
      enabled: false,
    },
  }),

  // Admin plugin for system-level super-admins
  // https://www.better-auth.com/docs/plugins/admin
  adminPlugin({
    defaultRole: "user",
    adminRoles: ["admin", "owner"],
    roles: {
      ...systemDefaultRoles,
      owner: systemAdminAc,
    },
    adminUserIds: deploymentAdminUserIds,
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
      // Only emit identity fields. The default payload is the entire user
      // row, and this plugin attaches the signed JWT to every /get-session
      // response via the `set-auth-jwt` header. A base64 `image` data URL
      // (avatars can be megabytes) blows the header past the edge's limit, so
      // the response is rejected and login breaks. Same class of bug as the
      // Header-token fix (#3716) — never put `image` in a header-bound JWT.
      definePayload: ({ user }) => ({
        id: user.id,
        email: user.email,
        name: user.name,
        role: (user as { role?: string }).role,
      }),
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
export function getTrustedOrigins(): string[] {
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

// Hard cap on inline base64 avatars stored in `user.image`. Avatar upload is
// disabled in the UI, so `image` should only ever be a short OAuth provider
// URL; this cap is a backstop against direct API callers. Oversized data: URLs
// bloat every /get-session response and previously broke login via the
// set-auth-jwt header.
const MAX_INLINE_AVATAR_LENGTH = 256 * 1024;

// Falling back to a fixed string baked into this open-source repo would let
// anyone who forgets to set BETTER_AUTH_SECRET run with a publicly-known
// session/cookie signing secret. Generate a random one instead (same
// trade-off as STUDIO_JWT_SECRET in ./jwt.ts): not persistent across
// restarts, but never a known constant.
const authSecret =
  settings.betterAuthSecret ||
  (() => {
    console.warn(
      "BETTER_AUTH_SECRET not set - generating a random secret (not persistent across restarts)",
    );
    return randomBytes(32).toString("base64");
  })();

export const auth = betterAuth({
  secret: authSecret,

  // customAPIKeyGetter probes every `Authorization: Bearer …` as an API key,
  // so OAuth tokens, studio JWTs and stale keys routinely miss and Better Auth
  // logs an ERROR + full source-mapped stack on each one — flooding prod logs.
  // Drop only that expected 401; forward everything else with the same format.
  logger: {
    log: (level, message, ...args) => {
      if (level === "error" && message.includes("validate API key")) return;
      // Better Auth performs OAuth redirects by *throwing* an APIError with a
      // 3xx status (e.g. "FOUND"/302 + Set-Cookie). A successful login is not
      // a failure — drop these so they don't masquerade as errors in prod logs.
      if (
        level === "error" &&
        args.some((a) => {
          const code = (a as { statusCode?: unknown } | null)?.statusCode;
          return typeof code === "number" && code >= 300 && code < 400;
        })
      ) {
        return;
      }
      const line = `${new Date().toISOString()} ${level.toUpperCase()} [Better Auth]: ${message}`;
      if (level === "error") console.error(line, ...args);
      else if (level === "warn") console.warn(line, ...args);
      else console.log(line, ...args);
    },
  },

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
        after: async (user, context) => {
          // Tag the PostHog person record with email/name BEFORE the
          // user_signed_up capture so that event lands on a person record
          // that already has $set: { email } applied.
          identifyAuthenticatedUser({
            id: user.id,
            email: user.email,
            name: user.name ?? null,
            emailVerified: !!user.emailVerified,
          });

          // WhatsApp Concierge (or any other channel) attribution, set as a
          // first-party cookie by the web client on landing. Absent for the
          // vast majority of signups.
          const signupRef = context?.getCookie("studio_signup_ref") ?? null;
          const signupSrc = context?.getCookie("studio_signup_src") ?? null;

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
              ...(signupRef ? { signup_ref: signupRef } : {}),
              ...(signupSrc ? { signup_src: signupSrc } : {}),
            },
          });

          const allowCreate =
            getConfig().autoCreateOrganizationOnSignup !== false;

          try {
            const result = await ensureUserOrganization({
              db: getDb().db,
              authApi: auth.api,
              user: {
                id: user.id,
                email: user.email,
                name: user.name ?? null,
                emailVerified: !!user.emailVerified,
              },
              allowCreate,
              createdVia: "signup",
            });

            if (result.status === "created") {
              posthog.groupIdentify({
                groupType: "organization",
                groupKey: result.organization.id,
                properties: {
                  name: result.organization.name,
                  slug: result.organization.slug,
                  created_at: new Date().toISOString(),
                  created_via: result.createdVia,
                  email_domain: result.domain,
                },
              });
              posthog.capture({
                distinctId: user.id,
                event: "organization_created",
                groups: { organization: result.organization.id },
                properties: {
                  organization_id: result.organization.id,
                  organization_slug: result.organization.slug,
                  name: result.organization.name,
                  created_via: result.createdVia,
                  email_domain: result.domain,
                },
              });
            }

            if (result.status === "joined") {
              posthog.capture({
                distinctId: user.id,
                event: "organization_domain_joined",
                groups: { organization: result.organization.id },
                properties: {
                  organization_id: result.organization.id,
                  organization_slug: result.organization.slug,
                  email_domain: result.domain,
                  joined_via: result.createdVia,
                },
              });
            }
          } catch (error) {
            posthog.captureException(error, user.id);
            console.error("Failed to ensure organization on signup:", error);
          }
        },
      },
      update: {
        // Defense in depth: never persist an oversized base64 avatar. Upload
        // is disabled in the UI, but a direct API caller could still send a
        // multi-megabyte data: URL. See MAX_INLINE_AVATAR_LENGTH.
        before: async (data) => {
          const image = (data as { image?: unknown }).image;
          if (
            typeof image === "string" &&
            image.startsWith("data:") &&
            image.length > MAX_INLINE_AVATAR_LENGTH
          ) {
            throw new APIError("PAYLOAD_TOO_LARGE", {
              message:
                "Avatar image is too large. Upload an image smaller than 5MB.",
            });
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
