import type { emailOTP } from "better-auth/plugins/email-otp";
import {
  createEmailSender,
  EmailProviderConfig,
  findEmailProvider,
} from "./email-providers";

type BetterAuthEmailOTPConfig = Parameters<typeof emailOTP>[0];

export const createEmailOtpConfig = (
  config: EmailOtpConfig,
  emailProviders: EmailProviderConfig[],
): BetterAuthEmailOTPConfig => {
  const provider = findEmailProvider(emailProviders, config.emailProviderId);

  if (!provider) {
    throw new Error(
      `Email provider with id '${config.emailProviderId}' not found`,
    );
  }

  const sendEmail = createEmailSender(provider);

  return {
    sendVerificationOTP: async ({ email, otp, type }) => {
      const subject =
        type === "sign-in"
          ? "Sign in code"
          : type === "forget-password"
            ? "Password reset code"
            : "Email verification code";

      await sendEmail({
        to: email,
        subject,
        html: `
          <h2>${subject}</h2>
          <p>Your verification code is: <strong>${otp}</strong></p>
          <p>This code expires in 5 minutes.</p>
          <p>If you didn't request this, you can safely ignore this email.</p>
        `,
      });
    },
    ...(config.otpLength ? { otpLength: config.otpLength } : {}),
    ...(config.expiresIn ? { expiresIn: config.expiresIn } : {}),
  };
};

export interface EmailOtpConfig {
  enabled: boolean;
  emailProviderId: string;
  /** Length of the OTP code. @default 6 */
  otpLength?: number;
  /** Expiry time of the OTP in seconds. @default 300 */
  expiresIn?: number;
}
