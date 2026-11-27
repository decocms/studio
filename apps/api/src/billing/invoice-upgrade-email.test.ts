import { describe, expect, it } from "bun:test";
import { buildInvoiceUpgradeEmail } from "./invoice-upgrade-email";

const params = {
  orgName: "Acme <Store>",
  orgSlug: "acme",
  organizationId: "org_123",
  fromPlanId: "custom",
  toPlanId: "business",
  requestedBy: "owner@example.com",
  at: new Date("2026-03-04T15:06:00Z"),
};

describe("buildInvoiceUpgradeEmail", () => {
  it("names the org and the plan to bill in the subject", () => {
    expect(buildInvoiceUpgradeEmail(params).subject).toBe(
      "Add Business to Acme <Store>'s next invoice",
    );
  });

  it("shows the monthly price when Stripe has one", () => {
    const { html } = buildInvoiceUpgradeEmail(params, {
      amountCents: 50000,
      currency: "usd",
    });
    expect(html).toContain("$500 / month, from today");
    expect(buildInvoiceUpgradeEmail(params).html).not.toContain("/ month");
  });

  it("carries everything finance needs to bill it", () => {
    const { html } = buildInvoiceUpgradeEmail(params);
    expect(html).toContain("Custom &rarr; Business");
    expect(html).toContain("org_123");
    expect(html).toContain("owner@example.com");
    expect(html).toContain("2026-03-04 15:06 UTC");
    expect(html).toContain("Organizations &rsaquo; To bill");
  });

  it("escapes org-controlled text", () => {
    const { html } = buildInvoiceUpgradeEmail(params);
    expect(html).toContain("Acme &lt;Store&gt;");
    expect(html).not.toContain("Acme <Store>");
  });

  it("falls back to the raw id for a plan it does not know", () => {
    const { html } = buildInvoiceUpgradeEmail({
      ...params,
      toPlanId: "enterprise",
    });
    expect(html).toContain("Custom &rarr; enterprise");
  });
});
