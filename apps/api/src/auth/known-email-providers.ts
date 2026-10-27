interface SendEmailParams {
  to: string;
  from: string;
  subject: string;
  html: string;
}

interface EmailProvider {
  sendEmail: (params: SendEmailParams) => Promise<void>;
}

/** Shared by every provider below: POST JSON, surface the body on failure. */
async function postEmail(
  providerName: string,
  url: string,
  apiKey: string,
  body: unknown,
): Promise<void> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `Failed to send email via ${providerName}: ${response.statusText} - ${errorText}`,
    );
  }
}

export class Resend implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async sendEmail({ to, from, subject, html }: SendEmailParams): Promise<void> {
    await postEmail("Resend", "https://api.resend.com/emails", this.apiKey, {
      to,
      from,
      subject,
      html,
    });
  }
}

export class SendGrid implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async sendEmail({ to, from, subject, html }: SendEmailParams): Promise<void> {
    await postEmail(
      "SendGrid",
      "https://api.sendgrid.com/v3/mail/send",
      this.apiKey,
      {
        personalizations: [{ to: [{ email: to }] }],
        from: { email: from },
        subject,
        content: [{ type: "text/html", value: html }],
      },
    );
  }
}
