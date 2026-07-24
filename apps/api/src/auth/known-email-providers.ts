interface SendEmailParams {
  to: string;
  from: string;
  subject: string;
  html: string;
}

interface EmailProvider {
  sendEmail: (params: SendEmailParams) => Promise<void>;
}

export class Resend implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async sendEmail({ to, from, subject, html }: SendEmailParams): Promise<void> {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ to, from, subject, html }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send email: ${response.statusText}`);
    }
  }
}

export class SendGrid implements EmailProvider {
  constructor(private readonly apiKey: string) {}

  async sendEmail({ to, from, subject, html }: SendEmailParams): Promise<void> {
    const response = await fetch("https://api.sendgrid.com/v3/mail/send", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        personalizations: [
          {
            to: [{ email: to }],
          },
        ],
        from: { email: from },
        subject,
        content: [
          {
            type: "text/html",
            value: html,
          },
        ],
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(
        `Failed to send email via SendGrid: ${response.statusText} - ${errorText}`,
      );
    }
  }
}
