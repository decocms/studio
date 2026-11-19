import { describe, expect, it } from "bun:test";
import {
  buildDayView,
  BUCKETS_PER_DAY,
  DAYS_AGO,
  type DayAgo,
  type DaySeries,
  type StoreDay,
} from "./order-rules";
import { buildSalesReportEmail } from "./sales-report";

const flat = (n: number) => new Array<number>(BUCKETS_PER_DAY).fill(n);
const at = new Date("2026-10-19T12:05:00Z");

/** Today at 1.5× the usual orders, R$ 150 a bucket; the reference days at 10 orders, R$ 1000. */
function store(currency: string): StoreDay {
  const day = (placed: number, revenue: number): DaySeries => ({
    placed: flat(placed),
    revenue: flat(revenue),
    items: flat(20),
    canceled: flat(0),
    denied: flat(0),
  });
  return {
    timezone: "UTC",
    done: 48,
    currency,
    firstEventDaysAgo: 60,
    days: Object.fromEntries(
      DAYS_AGO.map((d) => [d, d === 0 ? day(15, 150) : day(10, 1000)]),
    ) as Record<DayAgo, DaySeries>,
  };
}

const opts = {
  orgName: "A & B",
  link: "https://x/o/monitoring",
  hours: [9, 12, 18],
};

describe("buildSalesReportEmail", () => {
  it("adds the stores up against W-1 and projects the close", () => {
    const views = [
      buildDayView(store("BRL"), at),
      buildDayView(store("BRL"), at),
    ];
    const email = buildSalesReportEmail(views, opts)!;
    // 2 stores × 48 buckets × R$ 150 so far; the close adds 1.5 × 48 × R$ 1000 each.
    expect(email.subject).toBe(
      "Sales today · A & B: R$14,400 by 12:00, R$158,400 projected",
    );
    expect(email.html).toContain("Sales today · A &amp; B");
    // Orders today vs W-1 at the same time: 1440 vs 960.
    expect(email.html).toContain("+50%");
    expect(email.html).toContain("9h, 12h, 18h");
    // Flat reference days: the cloud closes on the projection.
    expect(email.html).toContain("Likely between R$158,400 and R$158,400.");
    expect(email.html).toContain("https://x/o/monitoring");
  });

  it("counts orders when the stores' currencies don't add up", () => {
    const views = [
      buildDayView(store("BRL"), at),
      buildDayView(store("USD"), at),
    ];
    const email = buildSalesReportEmail(views, opts)!;
    expect(email.subject).toBe(
      "Sales today · A & B: 1,440 by 12:00, 2,880 projected",
    );
    expect(email.html).not.toContain("Average ticket");
  });

  it("has nothing to say without a store", () => {
    expect(buildSalesReportEmail([], opts)).toBeNull();
  });
});
