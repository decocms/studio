/**
 * Custom Auth Routes
 *
 * Provides custom authentication endpoints that work better with OAuth flows
 * by returning callback URLs in response body instead of using 302 redirects.
 */

import { Hono } from "hono";
import { authConfig, resetPasswordEnabled } from "../../auth";
import { KNOWN_OAUTH_PROVIDERS, OAuthProvider } from "@/auth/oauth-providers";

const app = new Hono();

export type AuthConfig = {
  emailAndPassword: {
    enabled: boolean;
  };
  magicLink: {
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
   * Whether STDIO connections are allowed.
   * Disabled by default in production unless UNSAFE_ALLOW_STDIO_TRANSPORT=true
   */
  stdioEnabled: boolean;
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
      process.env.NODE_ENV !== "production" ||
      process.env.UNSAFE_ALLOW_STDIO_TRANSPORT === "true";

    const config: AuthConfig = {
      emailAndPassword: {
        enabled: authConfig.emailAndPassword?.enabled ?? false,
      },
      magicLink: {
        enabled: authConfig.magicLinkConfig?.enabled ?? false,
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

export default app;
