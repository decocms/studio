import { describe, expect, it, spyOn } from "bun:test";
import { createEmailOTPConfig, type EmailOTPConfig } from "./email-otp";

describe("createEmailOTPConfig", () => {
  it("returns default otpLength of 6 and expiresIn of 300", () => {
    const config: EmailOTPConfig = { enabled: true };
    const result = createEmailOTPConfig(config);

    expect(result.otpLength).toBe(6);
    expect(result.expiresIn).toBe(300);
  });

  it("respects custom otpLength and expiresIn", () => {
    const config: EmailOTPConfig = {
      enabled: true,
      otpLength: 8,
      expiresIn: 600,
    };
    const result = createEmailOTPConfig(config);

    expect(result.otpLength).toBe(8);
    expect(result.expiresIn).toBe(600);
  });

  it("enforces minimum otpLength of 6", () => {
    const config: EmailOTPConfig = { enabled: true, otpLength: 4 };
    const result = createEmailOTPConfig(config);

    expect(result.otpLength).toBe(6);
  });

  it("logs OTP to console in non-production when no email provider configured", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    const config: EmailOTPConfig = { enabled: true };
    const result = createEmailOTPConfig(config);

    await result.sendVerificationOTP!({
      email: "test@example.com",
      otp: "123456",
      type: "sign-in",
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      "[email-otp] Your sign-in code for test@example.com: 123456",
    );

    consoleSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("does NOT log OTP to console in production when no email provider configured", async () => {
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "production";

    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    const config: EmailOTPConfig = { enabled: true };
    const result = createEmailOTPConfig(config);

    await result.sendVerificationOTP!({
      email: "test@example.com",
      otp: "123456",
      type: "sign-in",
    });

    expect(consoleSpy).not.toHaveBeenCalled();

    consoleSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("selects correct subject for sign-in type", async () => {
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const config: EmailOTPConfig = { enabled: true };
    const result = createEmailOTPConfig(config);

    await result.sendVerificationOTP!({
      email: "test@example.com",
      otp: "123456",
      type: "sign-in",
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Your sign-in code"),
    );

    consoleSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("uses default subject for unknown OTP types", async () => {
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    const config: EmailOTPConfig = { enabled: true };
    const result = createEmailOTPConfig(config);

    await result.sendVerificationOTP!({
      email: "test@example.com",
      otp: "123456",
      type: "email-verification",
    });

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Verify your email"),
    );

    consoleSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });

  it("falls back to console when emailProviderId set but providers empty", async () => {
    const config: EmailOTPConfig = {
      enabled: true,
      emailProviderId: "test-provider",
    };

    const result = createEmailOTPConfig(config, []);

    // With empty providers array, should fall back to console
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";

    await result.sendVerificationOTP!({
      email: "test@example.com",
      otp: "123456",
      type: "sign-in",
    });

    expect(consoleSpy).toHaveBeenCalled();

    consoleSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
  });
});
