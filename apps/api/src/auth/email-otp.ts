import type { emailOTP } from "better-auth/plugins/email-otp";
import {
  createEmailSender,
  EmailProviderConfig,
  findEmailProvider,
} from "./email-providers";
import { emailOtpCode, emailParagraph, emailTemplate } from "./email-template";

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

  const expiresInSeconds = config.expiresIn ?? 300;
  const expiryLabel =
    expiresInSeconds >= 60 && expiresInSeconds % 60 === 0
      ? `${expiresInSeconds / 60} minute${expiresInSeconds / 60 !== 1 ? "s" : ""}`
      : `${expiresInSeconds} second${expiresInSeconds !== 1 ? "s" : ""}`;

  return {
    sendVerificationOTP: async ({ email, otp, type }) => {
      const subject =
        type === "sign-in"
          ? "Sign in code"
          : type === "forget-password"
            ? "Password reset code"
            : "Email verification code";

      const subheading =
        type === "sign-in"
          ? "Enter the code below to sign in to your account."
          : type === "forget-password"
            ? "Enter the code below to reset your password."
            : "Enter the code below to verify your email address.";

      await sendEmail({
        to: email,
        subject,
        html: emailTemplate({
          preheader: `Your ${subject.toLowerCase()} is ${otp}`,
          heading: subject,
          subheading,
          body:
            emailOtpCode(otp) +
            emailParagraph(
              `This code expires in <strong>${expiryLabel}</strong>. Do not share it with anyone.`,
              true,
            ),
          footnote:
            "If you didn\u2019t request this code, you can safely ignore this email.",
        }),
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
