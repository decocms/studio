import { describe, expect, it } from "bun:test";
import {
  aggregateUsage,
  clampUntil,
  dateRange,
  monthInterval,
  nextBillingDate,
  planTypeOf,
  toInvoices,
} from "./infra-billing";
import { mergePageviews, toOneDollarHostname } from "./onedollarstats";

describe("monthInterval", () => {
  it("spans the full UTC month", () => {
    expect(monthInterval(new Date("2026-03-17T22:00:00Z"))).toEqual({
      since: "2026-03-01",
      until: "2026-03-31",
    });
  });

  it("handles february in a leap year", () => {
    expect(monthInterval(new Date("2024-02-05T00:00:00Z"))).toEqual({
      since: "2024-02-01",
      until: "2024-02-29",
    });
  });

  it("does not roll into the next year on december", () => {
    expect(monthInterval(new Date("2025-12-31T23:59:59Z"))).toEqual({
      since: "2025-12-01",
      until: "2025-12-31",
    });
  });
});

describe("planTypeOf", () => {
  it("is free without a subscription row", () => {
    expect(planTypeOf(undefined)).toBe("free");
    expect(planTypeOf({ plan: null, status: "Live" })).toBe("free");
  });

  it("maps live pro and enterprise plans", () => {
    expect(planTypeOf({ plan: 5, status: "Live" })).toBe("pro");
    expect(planTypeOf({ plan: 6, status: "Live" })).toBe("enterprise");
  });

  it("downgrades a paid plan that is no longer live", () => {
    expect(planTypeOf({ plan: 5, status: "Churned" })).toBe("free");
    expect(planTypeOf({ plan: 6, status: null })).toBe("free");
  });

  it("keeps full access regardless of status", () => {
    expect(planTypeOf({ plan: 420, status: "Churned" })).toBe("enterprise");
  });

  it("treats an unknown plan id as free", () => {
    expect(planTypeOf({ plan: 99, status: "Live" })).toBe("free");
  });
});

describe("nextBillingDate", () => {
  const now = new Date("2026-08-16T12:00:00Z");

  it("bills enterprise on the first of next month", () => {
    expect(nextBillingDate("enterprise", undefined, now)).toBe("2026-09-01");
  });

  it("rolls the enterprise date into the next year from december", () => {
    expect(
      nextBillingDate(
        "enterprise",
        undefined,
        new Date("2026-12-31T00:00:00Z"),
      ),
    ).toBe("2027-01-01");
  });

  it("uses the stripe period end for paid non-enterprise plans", () => {
    const periodEnd = Math.floor(Date.UTC(2026, 8, 3) / 1000);
    expect(nextBillingDate("pro", periodEnd, now)).toBe("2026-09-03");
  });

  it("has no date when stripe schedules nothing", () => {
    expect(nextBillingDate("pro", undefined, now)).toBeNull();
    expect(nextBillingDate("free", undefined, now)).toBeNull();
  });
});

describe("aggregateUsage", () => {
  it("sums CDN and shared-infra rows landing on the same date", () => {
    const totals = aggregateUsage([
      { date: "2026-08-01", requests: "10", egress_bytes: "100" },
      { date: "2026-08-01", requests: 5, egress_bytes: 50 },
      { date: "2026-08-02", requests: 7, egress_bytes: 70 },
    ]);
    expect(totals.get("2026-08-01")).toEqual({ requests: 15, bytes: 150 });
    expect(totals.get("2026-08-02")).toEqual({ requests: 7, bytes: 70 });
  });

  it("normalizes a DateTime column down to the calendar day", () => {
    const totals = aggregateUsage([
      { date: "2026-08-01 00:00:00", requests: 3, egress_bytes: 30 },
    ]);
    expect(totals.get("2026-08-01")).toEqual({ requests: 3, bytes: 30 });
  });

  it("coerces unparseable sums to zero rather than NaN", () => {
    const totals = aggregateUsage([
      { date: "2026-08-01", requests: "oops", egress_bytes: "" },
    ]);
    expect(totals.get("2026-08-01")).toEqual({ requests: 0, bytes: 0 });
  });

  it("is empty for no rows", () => {
    expect(aggregateUsage([]).size).toBe(0);
  });
});

describe("dateRange", () => {
  it("fills every day inclusive of both ends", () => {
    expect(dateRange("2026-08-01", "2026-08-31")).toHaveLength(31);
    expect(dateRange("2024-02-01", "2024-02-29")).toHaveLength(29);
  });

  it("returns a single day when both ends match", () => {
    expect(dateRange("2026-08-16", "2026-08-16")).toEqual(["2026-08-16"]);
  });
});

describe("clampUntil", () => {
  const now = new Date("2026-08-16T12:00:00Z");

  it("stops the current month at today", () => {
    expect(clampUntil("2026-08-31", now)).toBe("2026-08-16");
  });

  it("leaves a completed month whole", () => {
    expect(clampUntil("2026-07-31", now)).toBe("2026-07-31");
  });
});

describe("toInvoices", () => {
  const row = {
    id: 1,
    status: "Paid",
    due_date: "2026-08-10",
    value: 100,
    reference_month: "2026-08-01",
    nf_url: null,
    bank_slip_url: null,
  };

  it("hides canceled invoices in either spelling", () => {
    const out = toInvoices([
      { ...row, id: 1, status: "canceled" },
      { ...row, id: 2, status: "Cancelled" },
      { ...row, id: 3, status: "Paid" },
    ]);
    expect(out.map((i) => i.id)).toEqual(["3"]);
  });

  it("keeps a row whose status is missing", () => {
    expect(toInvoices([{ ...row, status: null }])).toHaveLength(1);
  });

  it("unwraps a bank slip mirrored as a JSON array", () => {
    const [invoice] = toInvoices([
      { ...row, bank_slip_url: '["https://example.com/a.pdf"]' },
    ]);
    expect(invoice!.bankSlipUrl).toBe("https://example.com/a.pdf");
  });

  it("keeps a plain url containing brackets intact", () => {
    const [invoice] = toInvoices([
      { ...row, bank_slip_url: "https://example.com/a.pdf?ids[]=1" },
    ]);
    expect(invoice!.bankSlipUrl).toBe("https://example.com/a.pdf?ids[]=1");
  });

  it("drops document links that are not https", () => {
    const [invoice] = toInvoices([
      {
        ...row,
        nf_url: "javascript:alert(1)",
        bank_slip_url: "http://example.com/a.pdf",
      },
    ]);
    expect(invoice!.nfUrl).toBeNull();
    expect(invoice!.bankSlipUrl).toBeNull();
  });

  it("renders a null amount as zero", () => {
    expect(toInvoices([{ ...row, value: null }])[0]!.value).toBe(0);
  });
});

describe("toOneDollarHostname", () => {
  it("prefixes a bare custom domain", () => {
    expect(toOneDollarHostname("example.com")).toBe("www.example.com");
  });

  it("does not double-prefix a host that already has www", () => {
    expect(toOneDollarHostname("www.example.com")).toBe("www.example.com");
  });

  it("leaves deco.site subdomains alone", () => {
    expect(toOneDollarHostname("shop.deco.site")).toBe("shop.deco.site");
  });
});

describe("mergePageviews", () => {
  const ok = (rows: { dimensions: string[]; metrics: number[] }[]) =>
    ({ status: "fulfilled", value: rows }) as const;

  it("sums the same day across hosts", () => {
    const merged = mergePageviews([
      ok([{ dimensions: ["2026-08-01"], metrics: [10] }]),
      ok([{ dimensions: ["2026-08-01"], metrics: [5] }]),
    ]);
    expect(merged?.get("2026-08-01")).toBe(15);
  });

  it("normalizes a timestamped dimension to its day", () => {
    const merged = mergePageviews([
      ok([{ dimensions: ["2026-08-01 00:00:00"], metrics: [4] }]),
    ]);
    expect(merged?.get("2026-08-01")).toBe(4);
  });

  it("is null when any host failed, so the UI shows a dash not a low number", () => {
    const merged = mergePageviews([
      ok([{ dimensions: ["2026-08-01"], metrics: [10] }]),
      { status: "rejected", reason: new Error("timeout") },
    ]);
    expect(merged).toBeNull();
  });
});
