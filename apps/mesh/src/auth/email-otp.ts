import type { emailOTP } from "better-auth/plugins";
import {
  createEmailSender,
  EmailProviderConfig,
  findEmailProvider,
} from "./email-providers";

type BetterAuthEmailOTPConfig = Parameters<typeof emailOTP>[0];

export const createEmailOTPConfig = (
  config: EmailOTPConfig,
  emailProviders?: EmailProviderConfig[],
): BetterAuthEmailOTPConfig => {
  const provider =
    emailProviders && config.emailProviderId
      ? findEmailProvider(emailProviders, config.emailProviderId)
      : undefined;

  const sendEmail = provider ? createEmailSender(provider) : undefined;

  return {
    sendVerificationOTP: async ({ email, otp, type }) => {
      const subject =
        type === "sign-in"
          ? "Your sign-in code"
          : type === "forget-password"
            ? "Your password reset code"
            : "Verify your email";

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
      } else {
        // Log OTP to console when no email provider is configured (dev mode)
        console.log(`[email-otp] ${subject} for ${email}: ${otp}`);
      }
    },
    otpLength: config.otpLength ?? 6,
    expiresIn: config.expiresIn ?? 300,
  };
};

export interface EmailOTPConfig {
  enabled: boolean;
  emailProviderId?: string;
  otpLength?: number;
  expiresIn?: number;
}
