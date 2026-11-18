import { describe, expect, it } from "bun:test";
import { buildStoreSnapshot, change, percent } from "./plan-goal-snapshot";

const prevFrom = Date.parse("2026-09-23T00:00:00Z");
const covered = "2026-09-01 00:00:00";

describe("percent and change", () => {
  it("returns null without a base", () => {
    expect(percent(5, 0)).toBeNull();
    expect(percent(1, 3)).toBe(33.3);
    expect(change(80, 0, true)).toBeNull();
    expect(change(80, 100, false)).toBeNull();
    expect(change(80, 100, true)).toBe(-20);
  });
});

describe("buildStoreSnapshot", () => {
  it("is null when no source has data", () => {
    expect(
      buildStoreSnapshot(
        { row_count: "0", first: "1970-01-01 00:00:00" },
        [],
        { row_count: "0" },
        prevFrom,
      ),
    ).toBeNull();
    expect(buildStoreSnapshot(undefined, [], undefined, prevFrom)).toBeNull();
  });

  it("computes rates, changes and the ticket from the lake rows", () => {
    const snapshot = buildStoreSnapshot(
      {
        row_count: "1300",
        first: covered,
        cur_visitors: "10000",
        prev_visitors: "12500",
        mobile_visitors: "7000",
        mobile_conversions: "56",
        desktop_visitors: "3000",
        desktop_conversions: "63",
        cur_pageviews: "40000",
        cur_errors: "200",
      },
      [
        { event: "view_item", n: 20000 },
        { event: "add_to_cart", n: 2000 },
        { event: "begin_checkout", n: 900 },
        { event: "purchase", n: 360 },
      ],
      {
        row_count: "700",
        first: `${covered}.000`,
        cur_orders: "330",
        prev_orders: "400",
        kept: "300",
        prev_kept: "380",
        revenue: 90000,
        prev_revenue: 114000,
        item_total: "480",
        order_currency: "BRL",
      },
      prevFrom,
    );
    expect(snapshot).toEqual({
      mobile_conversion_rate: 0.8,
      desktop_conversion_rate: 2.1,
      product_to_cart_rate: 10,
      cart_to_checkout_rate: 45,
      checkout_completion_rate: 40,
      visitors: 10000,
      visitors_change: -20,
      orders: 330,
      orders_change: -17.5,
      revenue_change: -21.1,
      average_ticket: 300,
      average_ticket_change: 0,
      items_per_order: 1.6,
      currency: "BRL",
      site_errors: 200,
      site_errors_per_1k_pageviews: 5,
    });
  });

  it("leaves changes out when the lake starts inside the previous window", () => {
    const snapshot = buildStoreSnapshot(
      {
        row_count: "10",
        first: "2026-10-10 00:00:00",
        cur_visitors: "500",
        prev_visitors: "50",
        cur_pageviews: "0",
      },
      [],
      undefined,
      prevFrom,
    );
    expect(snapshot?.visitors).toBe(500);
    expect(snapshot?.visitors_change).toBeNull();
    expect(snapshot?.site_errors_per_1k_pageviews).toBeNull();
    expect(snapshot?.mobile_conversion_rate).toBeNull();
    expect(snapshot?.orders).toBeNull();
    expect(snapshot?.checkout_completion_rate).toBeNull();
  });
});
