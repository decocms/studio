/**
 * Email Provider Configuration
 *
 * Centralized email provider setup that can be used by:
 * - Magic Link authentication
 * - Organization invitations
 * - Other email-based features
 */

import { Resend, SendGrid } from "./known-email-providers";

// Provider-specific config types
interface ResendConfig {
  apiKey: string;
  fromEmail: string;
}

interface SendGridConfig {
  apiKey: string;
  fromEmail: string;
}

// Discriminated union for email provider config
export type EmailProviderConfig =
  | {
      id: string;
      provider: "resend";
      config: ResendConfig;
    }
  | {
      id: string;
      provider: "sendgrid";
      config: SendGridConfig;
    };

export interface SendEmailParams {
  to: string;
  subject: string;
  html: string;
}

/**
 * Get an email sender function from a provider config
 */
export function createEmailSender(
  providerConfig: EmailProviderConfig,
): (params: SendEmailParams) => Promise<void> {
  switch (providerConfig.provider) {
    case "resend": {
      const resend = new Resend(providerConfig.config.apiKey);
      return ({ to, subject, html }) =>
        resend.sendEmail({
          to,
          from: providerConfig.config.fromEmail,
          subject,
          html,
        });
    }
    case "sendgrid": {
      const sendGrid = new SendGrid(providerConfig.config.apiKey);
      return ({ to, subject, html }) =>
        sendGrid.sendEmail({
          to,
          from: providerConfig.config.fromEmail,
          subject,
          html,
        });
    }
  }
}

/**
 * Find an email provider by ID
 */
export function findEmailProvider(
  providers: EmailProviderConfig[],
  id: string,
): EmailProviderConfig | undefined {
  return providers.find((p) => p.id === id);
}
