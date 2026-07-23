/**
 * Shared email template utilities.
 *
 * All transactional emails (invite, OTP, password reset, magic link) use the
 * same base layout so they look and feel consistent out of the box.
 */

interface EmailTemplateOptions {
  /** Short preview text shown in the inbox before opening the email. */
  preheader?: string;
  /** Main headline rendered at the top of the card. */
  heading: string;
  /** Optional one-liner beneath the headline. */
  subheading?: string;
  /** Inner HTML for the card body. Build it with the helpers below. */
  body: string;
  /** Replaces the default fine-print sentence in the footer. */
  footnote?: string;
}

/**
 * Wraps arbitrary body HTML in the branded card shell.
 * Returns a complete, self-contained HTML email string.
 */
export function emailTemplate({
  preheader = "",
  heading,
  subheading,
  body,
  footnote,
}: EmailTemplateOptions): string {
  const defaultFootnote =
    "You received this email because of activity on your deco Studio account. If you weren\u2019t expecting it, you can safely ignore it.";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta http-equiv="X-UA-Compatible" content="IE=edge" />
  <title>${heading}</title>
  <!--[if !mso]><!-->
  <style>
    @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap');
  </style>
  <!--<![endif]-->
  <style>
    * { box-sizing: border-box; }
    body { margin: 0; padding: 0; }
    @media (max-width: 600px) {
      .card { width: 100% !important; border-radius: 0 !important; }
      .card-body { padding: 32px 24px !important; }
      .card-header { padding: 24px !important; }
      .card-footer { padding: 20px 24px !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#F5F4F1;font-family:Inter,system-ui,-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;">

  ${preheader ? `<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${preheader}&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;&zwnj;&nbsp;</div>` : ""}

  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"
    style="background-color:#F5F4F1;">
    <tr>
      <td align="center" style="padding:48px 16px 64px;">

        <!-- Card -->
        <table role="presentation" class="card" width="560" cellpadding="0" cellspacing="0" border="0"
          style="max-width:560px;width:100%;background:#FFFFFF;border-radius:12px;border:1px solid #E5E2DC;">

          <!-- Header: logo -->
          <tr>
            <td class="card-header" style="padding:24px 40px;border-bottom:1px solid #E5E2DC;">
              <img src="https://assets.decocache.com/decocms/989507dd-7830-4b94-8ddb-d99c31ba4f9f/deco-logo-bg.png"
                width="48" height="48" alt="deco Studio" style="display:block;" />
            </td>
          </tr>

          <!-- Body -->
          <tr>
            <td class="card-body" style="padding:40px 40px 36px;">

              <h1 style="margin:0 0 6px 0;font-size:22px;font-weight:600;letter-spacing:-0.03em;color:#141413;line-height:1.3;font-family:Inter,system-ui,sans-serif;">
                ${heading}
              </h1>

              ${
                subheading
                  ? `<p style="margin:0 0 28px 0;font-size:14px;color:#7A7570;line-height:1.6;font-family:Inter,system-ui,sans-serif;">${subheading}</p>`
                  : `<div style="height:28px;"></div>`
              }

              ${body}

            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td class="card-footer" style="padding:20px 40px;border-top:1px solid #E5E2DC;">
              <p style="margin:0;font-size:12px;color:#A09890;line-height:1.65;font-family:Inter,system-ui,sans-serif;">
                ${footnote ?? defaultFootnote}
              </p>
            </td>
          </tr>

        </table>
        <!-- /Card -->

      </td>
    </tr>
  </table>

</body>
</html>`;
}

/**
 * Renders a full-width primary CTA button.
 * Falls back to a plain-text URL line beneath for clients that block images/CSS.
 */
export function emailButton(label: string, url: string): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-bottom:20px;">
  <tr>
    <td style="border-radius:8px;background:#141413;">
      <a href="${url}" target="_blank"
        style="display:inline-block;padding:13px 24px;font-size:14px;font-weight:500;color:#FAFAF9;text-decoration:none;letter-spacing:-0.01em;font-family:Inter,system-ui,sans-serif;border-radius:8px;line-height:1;mso-padding-alt:0;">
        ${label}
      </a>
    </td>
  </tr>
</table>
<p style="margin:0 0 0 0;font-size:12px;color:#A09890;line-height:1.6;font-family:Inter,system-ui,sans-serif;">
  If the button doesn\u2019t work, copy and paste this URL into your browser:<br />
  <a href="${url}" style="color:#7A7570;word-break:break-all;">${url}</a>
</p>`;
}

/**
 * Renders a visually prominent OTP code block.
 */
export function emailOtpCode(otp: string): string {
  return `<div style="background:#F5F4F1;border:1px solid #E5E2DC;border-radius:8px;padding:22px 24px;text-align:center;margin-bottom:20px;">
  <span style="font-size:34px;font-weight:600;letter-spacing:0.25em;color:#141413;font-family:'Courier New',Courier,'Lucida Console',monospace;">
    ${otp}
  </span>
</div>`;
}

/**
 * Renders a body paragraph. Pass `muted: true` for secondary/fine-print text.
 */
export function emailParagraph(text: string, muted = false): string {
  return `<p style="margin:0 0 16px 0;font-size:15px;line-height:1.65;color:${muted ? "#7A7570" : "#3A3735"};font-family:Inter,system-ui,sans-serif;">${text}</p>`;
}
