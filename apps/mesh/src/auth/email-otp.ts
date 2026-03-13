import type { emailOTP } from "better-auth/plugins";
import {
  createEmailSender,
  EmailProviderConfig,
  findEmailProvider,
} from "./email-providers";

type BetterAuthEmailOTPConfig = Parameters<typeof emailOTP>[0];

const MIN_OTP_LENGTH = 6;

export const createEmailOTPConfig = (
  config: EmailOTPConfig,
  emailProviders?: EmailProviderConfig[],
): BetterAuthEmailOTPConfig => {
  const provider =
    emailProviders && config.emailProviderId
      ? findEmailProvider(emailProviders, config.emailProviderId)
      : undefined;

  const sendEmail = provider ? createEmailSender(provider) : undefined;

  const isProduction = process.env.NODE_ENV === "production";

  if (!sendEmail && isProduction) {
    console.warn(
      "[email-otp] No email provider configured. OTP codes will NOT be logged in production.",
    );
  }

  const otpLength = Math.max(config.otpLength ?? 6, MIN_OTP_LENGTH);

  return {
    sendVerificationOTP: async ({ email, otp, type }) => {
      const subject =
        type === "sign-in" ? "Your sign-in code" : "Verify your email";

      if (sendEmail) {
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
      } else if (!isProduction) {
        // Only log OTP to console in non-production environments
        console.log(`[email-otp] ${subject} for ${email}: ${otp}`);
      }
    },
    otpLength,
    expiresIn: config.expiresIn ?? 300,
  };
};

export interface EmailOTPConfig {
  enabled: boolean;
  emailProviderId?: string;
  otpLength?: number;
  expiresIn?: number;
}
