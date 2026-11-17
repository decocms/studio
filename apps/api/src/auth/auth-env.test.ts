import { describe, expect, it } from "bun:test";
import { authEnvSchema } from "./auth-env";

describe("authEnvSchema", () => {
  it("accepts an empty env with email/password defaults", () => {
    const config = authEnvSchema.parse({});
    expect(config.emailAndPassword).toEqual({ enabled: true });
    expect(config.emailProviders).toBeUndefined();
  });

  it("accepts a provider reference that matches a configured provider", () => {
    const config = authEnvSchema.parse({
      AUTH_RESEND_API_KEY: "key",
      AUTH_INVITE_EMAIL_PROVIDER: "resend",
    });
    expect(config.inviteEmailProviderId).toBe("resend");
  });

  it("rejects a provider reference to an unconfigured provider", () => {
    expect(() =>
      authEnvSchema.parse({
        AUTH_RESEND_API_KEY: "key",
        AUTH_INVITE_EMAIL_PROVIDER: "sendgrid",
      }),
    ).toThrow(/AUTH_SENDGRID_API_KEY/);
  });

  it("rejects AUTH_MAGIC_LINK_ENABLED with no email provider configured", () => {
    expect(() =>
      authEnvSchema.parse({ AUTH_MAGIC_LINK_ENABLED: "true" }),
    ).toThrow(/AUTH_MAGIC_LINK_ENABLED/);
  });

  it("rejects AUTH_EMAIL_OTP_ENABLED with no email provider configured", () => {
    expect(() =>
      authEnvSchema.parse({ AUTH_EMAIL_OTP_ENABLED: "true" }),
    ).toThrow(/AUTH_EMAIL_OTP_ENABLED/);
  });

  it("accepts AUTH_MAGIC_LINK_ENABLED when an email provider is configured", () => {
    const config = authEnvSchema.parse({
      AUTH_MAGIC_LINK_ENABLED: "true",
      AUTH_SENDGRID_API_KEY: "key",
    });
    expect(config.magicLinkConfig).toEqual({
      enabled: true,
      emailProviderId: "sendgrid",
    });
  });

  it("rejects Microsoft SSO configured without a client secret", () => {
    expect(() =>
      authEnvSchema.parse({
        AUTH_SSO_DOMAIN: "acme.com",
        AUTH_SSO_MS_CLIENT_ID: "client-id",
        AUTH_SSO_MS_TENANT_ID: "tenant-id",
      }),
    ).toThrow(/AUTH_SSO_MS_CLIENT_SECRET/);
  });

  it("rejects Microsoft SSO configured without a tenant id", () => {
    expect(() =>
      authEnvSchema.parse({
        AUTH_SSO_DOMAIN: "acme.com",
        AUTH_SSO_MS_CLIENT_ID: "client-id",
        AUTH_SSO_MS_CLIENT_SECRET: "secret",
      }),
    ).toThrow(/AUTH_SSO_MS_TENANT_ID/);
  });

  it("rejects Google SSO configured without a client secret", () => {
    expect(() =>
      authEnvSchema.parse({
        AUTH_SSO_DOMAIN: "acme.com",
        AUTH_SSO_GOOGLE_CLIENT_ID: "client-id",
      }),
    ).toThrow(/AUTH_SSO_GOOGLE_CLIENT_SECRET/);
  });

  it("rejects a negative AUTH_EMAIL_OTP_LENGTH", () => {
    expect(() => authEnvSchema.parse({ AUTH_EMAIL_OTP_LENGTH: "-5" })).toThrow(
      /AUTH_EMAIL_OTP_LENGTH/,
    );
  });

  it("rejects a non-integer AUTH_EMAIL_OTP_LENGTH", () => {
    expect(() => authEnvSchema.parse({ AUTH_EMAIL_OTP_LENGTH: "6.5" })).toThrow(
      /AUTH_EMAIL_OTP_LENGTH/,
    );
  });

  it("rejects a zero or negative AUTH_EMAIL_OTP_EXPIRES_IN", () => {
    expect(() =>
      authEnvSchema.parse({ AUTH_EMAIL_OTP_EXPIRES_IN: "0" }),
    ).toThrow(/AUTH_EMAIL_OTP_EXPIRES_IN/);
  });

  it("accepts valid AUTH_EMAIL_OTP_LENGTH and AUTH_EMAIL_OTP_EXPIRES_IN", () => {
    const config = authEnvSchema.parse({
      AUTH_EMAIL_OTP_LENGTH: "8",
      AUTH_EMAIL_OTP_EXPIRES_IN: "600",
    });
    expect(config).toBeTruthy();
  });

  it("accepts Microsoft SSO when fully configured", () => {
    const config = authEnvSchema.parse({
      AUTH_SSO_DOMAIN: "acme.com",
      AUTH_SSO_MS_CLIENT_ID: "client-id",
      AUTH_SSO_MS_CLIENT_SECRET: "secret",
      AUTH_SSO_MS_TENANT_ID: "tenant-id",
    });
    expect(config.ssoConfig).toEqual({
      providerId: "microsoft",
      domain: "acme.com",
      MS_TENANT_ID: "tenant-id",
      MS_CLIENT_ID: "client-id",
      MS_CLIENT_SECRET: "secret",
      scopes: ["openid", "email", "profile"],
    });
  });
});
