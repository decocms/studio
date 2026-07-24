import type { magicLink } from "better-auth/plugins";
import {
  createEmailSender,
  EmailProviderConfig,
  findEmailProvider,
} from "./email-providers";
import { emailButton, emailTemplate } from "./email-template";

type BetterAuthMagicLinkConfig = Parameters<typeof magicLink>[0];

export const createMagicLinkConfig = (
  config: MagicLinkConfig,
  emailProviders: EmailProviderConfig[],
): BetterAuthMagicLinkConfig => {
  const provider = findEmailProvider(emailProviders, config.emailProviderId);

  if (!provider) {
    throw new Error(
      `Email provider with id '${config.emailProviderId}' not found`,
    );
  }

  const sendEmail = createEmailSender(provider);

  return {
    sendMagicLink: async ({ email, url }) => {
      await sendEmail({
        to: email,
        subject: "Sign in to deco Studio",
        html: emailTemplate({
          preheader: "Click the button to securely sign in to your account.",
          heading: "Sign in to deco Studio",
          subheading: `We received a sign-in request for <strong>${email}</strong>. Click the button below to continue.`,
          body: emailButton("Sign in", url),
          footnote:
            "If you didn\u2019t request this link, you can safely ignore this email. This link expires shortly.",
        }),
      });
    },
  };
};

export interface MagicLinkConfig {
  enabled: boolean;
  emailProviderId: string;
}
