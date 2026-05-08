import { z } from "zod";
import type { EmailProviderConfig } from "./email-providers";
import type { EmailOtpConfig } from "./email-otp";
import type { MagicLinkConfig } from "./magic-link";
import type { SSOConfig } from "./sso";

// ── Zod helpers ──────────────────────────────────────────────────────

const bool = (fallback: boolean) =>
  z
    .enum(["true", "false", "1", "0"])
    .optional()
    .transform((v) => (v === undefined ? fallback : v === "true" || v === "1"));

const csv = (fallback: string[]) =>
  z
    .string()
    .optional()
    .transform((v) => (v ? v.split(",").map((s) => s.trim()) : fallback));

// ── Schema ───────────────────────────────────────────────────────────

export const authEnvSchema = z
  .object({
    AUTH_EMAIL_PASSWORD_ENABLED: bool(true),

    // Google OAuth
    AUTH_GOOGLE_CLIENT_ID: z.string().optional(),
    AUTH_GOOGLE_CLIENT_SECRET: z.string().optional(),

    // GitHub OAuth
    AUTH_GITHUB_CLIENT_ID: z.string().optional(),
    AUTH_GITHUB_CLIENT_SECRET: z.string().optional(),

    // Resend email provider
    AUTH_RESEND_API_KEY: z.string().optional(),
    AUTH_RESEND_FROM_EMAIL: z.string().optional(),

    // SendGrid email provider
    AUTH_SENDGRID_API_KEY: z.string().optional(),
    AUTH_SENDGRID_FROM_EMAIL: z.string().optional(),

    // Email provider references
    AUTH_INVITE_EMAIL_PROVIDER: z.enum(["resend", "sendgrid"]).optional(),
    AUTH_RESET_PASSWORD_EMAIL_PROVIDER: z
      .enum(["resend", "sendgrid"])
      .optional(),

    // Magic link
    AUTH_MAGIC_LINK_ENABLED: bool(false),
    AUTH_MAGIC_LINK_EMAIL_PROVIDER: z.enum(["resend", "sendgrid"]).optional(),

    // Email OTP
    AUTH_EMAIL_OTP_ENABLED: bool(false),
    AUTH_EMAIL_OTP_EMAIL_PROVIDER: z.enum(["resend", "sendgrid"]).optional(),
    AUTH_EMAIL_OTP_LENGTH: z.coerce.number().optional(),
    AUTH_EMAIL_OTP_EXPIRES_IN: z.coerce.number().optional(),

    // SSO (Microsoft)
    AUTH_SSO_DOMAIN: z.string().optional(),
    AUTH_SSO_MS_TENANT_ID: z.string().optional(),
    AUTH_SSO_MS_CLIENT_ID: z.string().optional(),
    AUTH_SSO_MS_CLIENT_SECRET: z.string().optional(),
    AUTH_SSO_SCOPES: csv(["openid", "email", "profile"]),

    // SSO (Google)
    AUTH_SSO_GOOGLE_CLIENT_ID: z.string().optional(),
    AUTH_SSO_GOOGLE_CLIENT_SECRET: z.string().optional(),
  })
  .transform((env) => {
    // ── Social providers ───────────────────────────────────────────
    const socialProviders: Record<
      string,
      { clientId: string; clientSecret: string }
    > = {};

    if (env.AUTH_GOOGLE_CLIENT_ID) {
      socialProviders.google = {
        clientId: env.AUTH_GOOGLE_CLIENT_ID,
        clientSecret: env.AUTH_GOOGLE_CLIENT_SECRET ?? "",
      };
    }
    if (env.AUTH_GITHUB_CLIENT_ID) {
      socialProviders.github = {
        clientId: env.AUTH_GITHUB_CLIENT_ID,
        clientSecret: env.AUTH_GITHUB_CLIENT_SECRET ?? "",
      };
    }

    // ── Email providers ────────────────────────────────────────────
    const emailProviders: EmailProviderConfig[] = [];

    if (env.AUTH_RESEND_API_KEY) {
      emailProviders.push({
        id: "resend",
        provider: "resend",
        config: {
          apiKey: env.AUTH_RESEND_API_KEY,
          fromEmail: env.AUTH_RESEND_FROM_EMAIL ?? "noreply@example.com",
        },
      });
    }
    if (env.AUTH_SENDGRID_API_KEY) {
      emailProviders.push({
        id: "sendgrid",
        provider: "sendgrid",
        config: {
          apiKey: env.AUTH_SENDGRID_API_KEY,
          fromEmail: env.AUTH_SENDGRID_FROM_EMAIL ?? "noreply@example.com",
        },
      });
    }

    const firstEmailId = emailProviders[0]?.id;

    // ── SSO ────────────────────────────────────────────────────────
    let ssoConfig: SSOConfig | undefined;

    if (env.AUTH_SSO_MS_CLIENT_ID && env.AUTH_SSO_DOMAIN) {
      ssoConfig = {
        providerId: "microsoft" as const,
        domain: env.AUTH_SSO_DOMAIN,
        MS_TENANT_ID: env.AUTH_SSO_MS_TENANT_ID ?? "",
        MS_CLIENT_ID: env.AUTH_SSO_MS_CLIENT_ID,
        MS_CLIENT_SECRET: env.AUTH_SSO_MS_CLIENT_SECRET ?? "",
        scopes: env.AUTH_SSO_SCOPES,
      };
    } else if (env.AUTH_SSO_GOOGLE_CLIENT_ID && env.AUTH_SSO_DOMAIN) {
      ssoConfig = {
        providerId: "google" as const,
        domain: env.AUTH_SSO_DOMAIN,
        GOOGLE_CLIENT_ID: env.AUTH_SSO_GOOGLE_CLIENT_ID,
        GOOGLE_CLIENT_SECRET: env.AUTH_SSO_GOOGLE_CLIENT_SECRET ?? "",
        scopes: env.AUTH_SSO_SCOPES,
      };
    }

    // ── Magic link ─────────────────────────────────────────────────
    let magicLinkConfig: MagicLinkConfig | undefined;

    if (env.AUTH_MAGIC_LINK_ENABLED) {
      magicLinkConfig = {
        enabled: true,
        emailProviderId:
          env.AUTH_MAGIC_LINK_EMAIL_PROVIDER ?? firstEmailId ?? "",
      };
    }

    // ── Email OTP ──────────────────────────────────────────────────
    let emailOtpConfig: EmailOtpConfig | undefined;

    if (env.AUTH_EMAIL_OTP_ENABLED) {
      emailOtpConfig = {
        enabled: true,
        emailProviderId:
          env.AUTH_EMAIL_OTP_EMAIL_PROVIDER ?? firstEmailId ?? "",
        ...(env.AUTH_EMAIL_OTP_LENGTH !== undefined && {
          otpLength: env.AUTH_EMAIL_OTP_LENGTH,
        }),
        ...(env.AUTH_EMAIL_OTP_EXPIRES_IN !== undefined && {
          expiresIn: env.AUTH_EMAIL_OTP_EXPIRES_IN,
        }),
      };
    }

    // ── Assembled config ───────────────────────────────────────────
    return {
      emailAndPassword: { enabled: env.AUTH_EMAIL_PASSWORD_ENABLED },
      socialProviders:
        Object.keys(socialProviders).length > 0 ? socialProviders : undefined,
      emailProviders: emailProviders.length > 0 ? emailProviders : undefined,
      inviteEmailProviderId: env.AUTH_INVITE_EMAIL_PROVIDER,
      resetPasswordEmailProviderId: env.AUTH_RESET_PASSWORD_EMAIL_PROVIDER,
      ssoConfig,
      magicLinkConfig,
      emailOtpConfig,
    };
  });

// ── Public API ───────────────────────────────────────────────────────

export type AuthConfig = z.output<typeof authEnvSchema>;

export function loadAuthConfig(): AuthConfig {
  return authEnvSchema.parse(process.env);
}
