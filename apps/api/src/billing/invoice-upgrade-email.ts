/**
 * "An org put a plan on its invoice" — the email finance gets for every
 * AI_PLAN_INVOICE_UPGRADE. The plan is live the moment the org clicks and
 * nothing charges for it until it lands on the org's next invoice, so a missed
 * upgrade is a plan given away.
 *
 * The gateway's pending list (Organizations › To bill in the admin) is the
 * record finance bills from; this email is the nudge to look at it. So it is
 * best-effort: a mail failure never undoes or fails an upgrade.
 */

import { emailTemplate } from "@/auth/email-template";
import { createEmailSender, findEmailProvider } from "@/auth/email-providers";
import { getConfig } from "@/core/config";
import { getSettings } from "../settings";
import { loadPlanPrices } from "../tools/organization/billing-plan-prices";

const PLAN_NAMES: Record<string, string> = {
  free: "No plan",
  starter: "Starter",
  business: "Business",
  custom: "Custom",
  ai_service: "AI Services",
};

function planName(id: string): string {
  return PLAN_NAMES[id] ?? id;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

interface InvoiceUpgradeEmailParams {
  orgName: string;
  orgSlug: string;
  organizationId: string;
  fromPlanId: string;
  toPlanId: string;
  requestedBy: string;
  at: Date;
}

interface MonthlyPrice {
  /** Minor units, as Stripe states them. */
  amountCents: number;
  currency: string;
}

const FONT = "font-family:Inter,system-ui,sans-serif;";
const INK = "#141413";
const MUTED = "#7A7570";
const LINE = "#E5E2DC";

function formatMonthly(price: MonthlyPrice): string {
  return (price.amountCents / 100).toLocaleString("en-US", {
    style: "currency",
    currency: price.currency.toUpperCase(),
    maximumFractionDigits: 0,
  });
}

function detailRow(label: string, valueHtml: string, first: boolean): string {
  const border = first ? "" : `border-top:1px solid ${LINE};`;
  return `<tr>
  <td style="${border}padding:10px 16px 10px 0;width:132px;vertical-align:top;font-size:13px;color:${MUTED};${FONT}">${escapeHtml(label)}</td>
  <td style="${border}padding:10px 0;vertical-align:top;font-size:14px;color:${INK};${FONT}">${valueHtml}</td>
</tr>`;
}

function stepRow(n: number, textHtml: string): string {
  return `<tr>
  <td style="padding:0 12px 10px 0;width:24px;vertical-align:top;">
    <div style="width:22px;height:22px;border-radius:11px;background:${INK};color:#FAFAF9;font-size:12px;font-weight:600;line-height:22px;text-align:center;${FONT}">${n}</div>
  </td>
  <td style="padding:1px 0 10px 0;vertical-align:top;font-size:14px;color:${INK};line-height:1.5;${FONT}">${textHtml}</td>
</tr>`;
}

/** Pure, so the copy is unit-tested without a context. */
export function buildInvoiceUpgradeEmail(
  params: InvoiceUpgradeEmailParams,
  price?: MonthlyPrice,
): {
  subject: string;
  html: string;
} {
  const to = planName(params.toPlanId);
  const from = planName(params.fromPlanId);
  const org = escapeHtml(params.orgName);
  const plan = escapeHtml(to);
  const when = `${params.at.toISOString().slice(0, 16).replace("T", " ")} UTC`;

  const summary = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;background:#F5F4F1;border-radius:10px;">
  <tr>
    <td style="padding:18px 20px;">
      <p style="margin:0 0 6px 0;font-size:11px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;color:${MUTED};${FONT}">Plan change</p>
      <p style="margin:0;font-size:20px;font-weight:600;letter-spacing:-0.02em;color:${INK};${FONT}">${escapeHtml(from)} &rarr; ${plan}</p>
      ${price ? `<p style="margin:4px 0 0 0;font-size:14px;color:${MUTED};${FONT}">${escapeHtml(formatMonthly(price))} / month, from today</p>` : ""}
    </td>
  </tr>
</table>`;

  const details = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 28px 0;">
${detailRow("Organization", org, true)}
${detailRow("Slug", escapeHtml(params.orgSlug), false)}
${detailRow("Organization ID", `<span style="font-family:ui-monospace,Menlo,monospace;font-size:12px;">${escapeHtml(params.organizationId)}</span>`, false)}
${detailRow("Requested by", escapeHtml(params.requestedBy), false)}
${detailRow("When", escapeHtml(when), false)}
</table>`;

  const steps = `<p style="margin:0 0 12px 0;font-size:14px;font-weight:600;color:${INK};${FONT}">What to do</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0">
${stepRow(1, `Add ${plan} to ${org}&rsquo;s next deco invoice.`)}
${stepRow(2, `Mark it billed in the AI Gateway admin, under <strong>Organizations &rsaquo; To bill</strong>.`)}
</table>`;

  return {
    subject: `Add ${to} to ${params.orgName}'s next invoice`,
    html: emailTemplate({
      preheader: escapeHtml(
        `${params.orgName} moved to ${to} with “Add to my invoice”. Nothing has been charged yet.`,
      ),
      heading: `Add ${plan} to the next invoice`,
      subheading: `${org} moved itself to ${plan} with &ldquo;Add to my invoice&rdquo;. Nothing has been charged yet.`,
      body: `${summary}${details}${steps}`,
      footnote:
        "You received this because this address is set to hear about invoice upgrades on deco Studio.",
    }),
  };
}

/** Same provider the invitations use. Null when none is configured. */
function resolveSender() {
  const auth = getConfig().auth;
  const providers = auth.emailProviders ?? [];
  const provider = auth.inviteEmailProviderId
    ? findEmailProvider(providers, auth.inviteEmailProviderId)
    : providers[0];
  return provider ? createEmailSender(provider) : null;
}

export async function emailFinanceInvoiceUpgrade(
  params: InvoiceUpgradeEmailParams,
): Promise<void> {
  const to = getSettings().invoiceUpgradeNotifyEmail;
  if (!to) return;
  try {
    const sender = resolveSender();
    if (!sender) {
      console.warn(
        "[billing] invoice upgrade email skipped: no email provider configured",
      );
      return;
    }
    // The price finance bills, off the same Stripe price the checkout sells.
    // Best-effort: without it the email still says what to bill.
    const price = await loadPlanPrices()
      .then((prices) => prices.find((p) => p.planId === params.toPlanId))
      .catch(() => undefined);
    const { subject, html } = buildInvoiceUpgradeEmail(params, price);
    await sender({ to, subject, html });
  } catch (err) {
    console.error(
      `[billing] invoice upgrade email for ${params.organizationId} failed`,
      err,
    );
  }
}
