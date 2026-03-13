/**
 * Custom Auth Routes
 *
 * Provides custom authentication endpoints that work better with OAuth flows
 * by returning callback URLs in response body instead of using 302 redirects.
 */

import { Hono } from "hono";
import { getConnInfo } from "hono/bun";
import { env } from "../../env";
import { authConfig } from "../../auth";
import { KNOWN_OAUTH_PROVIDERS, OAuthProvider } from "@/auth/oauth-providers";
import {
  getLocalAdminUser,
  getLocalAdminPassword,
  isLocalMode,
} from "@/auth/local-mode";

const app = new Hono();

export type AuthConfig = {
  magicLink: {
    enabled: boolean;
  };
  emailOTP: {
    enabled: boolean;
  };
  socialProviders: {
    enabled: boolean;
    providers: {
      name: string;
      icon?: string;
    }[];
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
   * Whether STDIO connections are allowed.
   * Disabled by default in production unless UNSAFE_ALLOW_STDIO_TRANSPORT=true
   */
  stdioEnabled: boolean;
  /**
   * Whether local mode is active (zero-ceremony developer experience).
   * When true, the frontend should auto-login and skip org selection.
   */
  localMode: boolean;
};

/**
 * Auth Configuration Endpoint
 *
 * Returns information about available authentication methods
 *
 * Route: GET /api/auth/custom/config
 */
app.get("/config", async (c) => {
  try {
    const socialProviders = Object.keys(authConfig.socialProviders ?? {});
    const hasSocialProviders = socialProviders.length > 0;
    const providers = socialProviders.map((name) => ({
      name,
      icon: KNOWN_OAUTH_PROVIDERS[name as OAuthProvider].icon,
    }));

    // STDIO is disabled in production unless explicitly allowed
    const stdioEnabled =
      env.NODE_ENV !== "production" || env.UNSAFE_ALLOW_STDIO_TRANSPORT;

    const config: AuthConfig = {
      magicLink: {
        enabled: authConfig.magicLinkConfig?.enabled ?? false,
      },
      emailOTP: {
        enabled: authConfig.emailOTPConfig?.enabled ?? false,
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

    return c.json({ success: true, config });
  } catch (error) {
    const errorMessage =
      error instanceof Error ? error.message : "Failed to load auth config";

    return c.json(
      {
        success: false,
        error: errorMessage,
      },
      500,
    );
  }
});

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
 * Development-only endpoint to retrieve the latest OTP for a given email.
 * Used by e2e tests to complete the OTP sign-in flow.
 *
 * Route: GET /api/auth/custom/test/latest-otp?email=...&type=sign-in
 */
app.get("/test/latest-otp", async (c) => {
  if (env.NODE_ENV === "production") {
    return c.json(
      { success: false, error: "Not available in production" },
      403,
    );
  }

  const email = c.req.query("email");
  const type = c.req.query("type") || "sign-in";

  if (!email) {
    return c.json({ success: false, error: "email parameter required" }, 400);
  }

  try {
    const { getDb } = await import("@/database");
    const { sql } = await import("kysely");
    const db = getDb();
    const identifier = `${type}-otp-${email}`;

    // Use raw SQL since 'verification' table is managed by Better Auth
    // and not in the Kysely schema types.
    const result = await sql<{ value: string }>`
      SELECT value FROM verification
      WHERE identifier = ${identifier}
      ORDER BY "createdAt" DESC
      LIMIT 1
    `.execute(db.db);

    const row = result.rows[0];
    if (!row) {
      return c.json({ success: false, error: "No OTP found" }, 404);
    }

    // Value format is "otp:attemptCount"
    const otp = String(row.value).split(":")[0];

    return c.json({ success: true, otp });
  } catch (error) {
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Failed to get OTP",
      },
      500,
    );
  }
});

export default app;
