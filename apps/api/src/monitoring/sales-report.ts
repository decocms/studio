/**
 * The sales report email: the org's stores added up the way the Monitor's
 * "Sales today" reads, what's captured so far against W-1, M-1 and Y-1 at the
 * same time of day, the projection for the close, and the next hours.
 */

import {
  addSalesDays,
  type OrderMonitorDay,
  type OrderMonitorSales,
} from "@decocms/shared/order-monitor";
import {
  emailButton,
  emailParagraph,
  emailTemplate,
} from "@/auth/email-template";

/** Hours ahead the email lists. */
const NEXT_HOURS = 3;
const REFS = [
  ["w1", "W-1"],
  ["m1", "M-1"],
  ["y1", "Y-1"],
] as const;

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
const clock = (bucket: number) =>
  `${String(Math.floor(bucket / 4) % 24).padStart(2, "0")}:${String((bucket % 4) * 15).padStart(2, "0")}`;
const hourList = (hours: readonly number[]) =>
  hours.map((h) => `${h}h`).join(", ");

const CELL =
  "padding:8px 0 8px 12px;border-bottom:1px solid #E5E2DC;font-size:13px;text-align:right;white-space:nowrap;font-family:Inter,system-ui,sans-serif;";

function change(now: number | null, then: number | null): string {
  if (now === null || then === null || then === 0) {
    return `<span style="color:#A09890;">—</span>`;
  }
  const pct = Math.round(((now - then) / then) * 1000) / 10;
  const color = pct > 0 ? "#1A7F37" : pct < 0 ? "#CF222E" : "#7A7570";
  return `<span style="color:${color};">${pct > 0 ? "+" : ""}${pct}%</span>`;
}

export function buildSalesReportEmail(
  days: readonly OrderMonitorDay[],
  opts: { orgName: string; link: string; hours: readonly number[] },
): { subject: string; html: string } | null {
  if (days.length === 0) return null;
  const sum = addSalesDays(days);
  const { currency, today, projection } = sum;
  const money = (n: number, fraction = 0) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency ?? "USD",
      minimumFractionDigits: fraction,
      maximumFractionDigits: fraction,
    }).format(n);
  const count = (n: number) => Math.round(n).toLocaleString("en-US");
  // Stores in different currencies don't add up: orders stand in for revenue.
  const main = (x: { orders: number; revenue: number }) =>
    currency ? money(x.revenue) : count(x.orders);
  const until = sum.done >= 95 ? "23:59" : clock(sum.done);
  const org = escapeHtml(opts.orgName);

  const ticket = (s: OrderMonitorSales) =>
    s.orders > 0 ? s.revenue / s.orders : null;
  type Row = [string, (s: OrderMonitorSales) => number | null, string];
  const rows: Row[] = [
    ["Orders", (s) => s.orders, count(today.orders)],
    ["Items", (s) => s.items, count(today.items)],
  ];
  if (currency) {
    const t = ticket(today);
    rows.unshift(["Revenue", (s) => s.revenue, money(today.revenue)]);
    rows.splice(2, 0, [
      "Average ticket",
      ticket,
      t === null ? "—" : money(t, 2),
    ]);
  }
  const table = `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 24px 0;border-collapse:collapse;">
  <tr>
    <td style="${CELL}text-align:left;padding-left:0;color:#A09890;"></td>
    <td style="${CELL}color:#A09890;">Today</td>
    ${REFS.map(([, label]) => `<td style="${CELL}color:#A09890;">${label}</td>`).join("")}
  </tr>
  ${rows
    .map(
      ([label, value, shown]) => `<tr>
    <td style="${CELL}text-align:left;padding-left:0;color:#7A7570;">${label}</td>
    <td style="${CELL}color:#141413;font-weight:500;">${shown}</td>
    ${REFS.map(([r]) => `<td style="${CELL}">${change(value(today), sum[r] ? value(sum[r]) : null)}</td>`).join("")}
  </tr>`,
    )
    .join("")}
</table>`;

  const first = Math.floor(sum.done / 4);
  const ahead = projection
    ? Array.from({ length: NEXT_HOURS }, (_, i) => first + i)
        .filter((h) => h < 24)
        .map((h) => ({
          h,
          orders: projection.orders[h] ?? 0,
          revenue: projection.revenue[h] ?? 0,
        }))
    : [];
  // Where the close could land: today so far plus the quietest and busiest reference day's rest.
  const edge = (side: "low" | "high") => ({
    orders: today.orders + (projection?.range.orders[side][23] ?? 0),
    revenue: today.revenue + (projection?.range.revenue[side][23] ?? 0),
  });
  const projectionBlock =
    projection && sum.done < 95
      ? emailParagraph(
          `<strong>Projection for 23:59: ${main(projection.close)}</strong>, opened at ${main(projection.initial)} (${change(
            currency ? projection.close.revenue : projection.close.orders,
            currency ? projection.initial.revenue : projection.initial.orders,
          )} since 00:00). Likely between ${main(edge("low"))} and ${main(edge("high"))}.`,
        ) +
        (ahead.length > 0
          ? emailParagraph(
              `The next hours should bring ${ahead
                .map(
                  (x) =>
                    `${main(x)} ${x.h === first ? `until ${clock((x.h + 1) * 4)}` : `at ${clock(x.h * 4)}`}`,
                )
                .join(", ")}.`,
              true,
            )
          : "")
      : "";

  const captured = main(today);
  return {
    subject: projection
      ? `Sales today · ${opts.orgName}: ${captured} by ${until}, ${main(projection.close)} projected`
      : `Sales today · ${opts.orgName}: ${captured} by ${until}`,
    html: emailTemplate({
      preheader: `${captured} captured by ${until}`,
      heading: `Sales today · ${org}`,
      subheading: `Captured 00:00 → ${until}, store time: <strong style="color:#141413;">${captured}</strong> (${change(
        currency ? today.revenue : today.orders,
        sum.w1 ? (currency ? sum.w1.revenue : sum.w1.orders) : null,
      )} vs W-1 at this hour)`,
      body:
        table + projectionBlock + emailButton("Open the Monitor", opts.link),
      footnote: `You get this report at ${hourList(opts.hours)}, store time, because you subscribed to it in the Monitor. Change the hours or stop it there.`,
    }),
  };
}
