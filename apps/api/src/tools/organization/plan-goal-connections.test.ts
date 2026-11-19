import { describe, expect, it } from "bun:test";
import type { StoreSnapshot } from "@decocms/shared/organization/schema";
import type { ConnectionEntity } from "../connection/schema";
import { hasNumbers, storeConnections } from "./plan-goal-connections";

const connection = (
  id: string,
  connection_type: ConnectionEntity["connection_type"] = "HTTP",
) => ({ id, connection_type }) as ConnectionEntity;

const empty: StoreSnapshot = {
  mobile_conversion_rate: null,
  desktop_conversion_rate: null,
  product_to_cart_rate: null,
  cart_to_checkout_rate: null,
  checkout_completion_rate: null,
  visitors: null,
  visitors_change: null,
  orders: null,
  orders_change: null,
  revenue_change: null,
  average_ticket: null,
  average_ticket_change: null,
  items_per_order: null,
  currency: null,
  site_errors: null,
  site_errors_per_1k_pageviews: null,
};

describe("storeConnections", () => {
  it("keeps the store's own connections", () => {
    const kept = storeConnections([
      connection("conn_vtex"),
      connection("conn_ga4", "SSE"),
    ]);
    expect(kept.map((c) => c.id)).toEqual(["conn_vtex", "conn_ga4"]);
  });

  it("drops virtual MCPs and Studio's own connections", () => {
    expect(
      storeConnections([
        connection("org_self"),
        connection("org_registry"),
        connection("org_community-registry"),
        connection("org_dev-assets"),
        connection("vir_agent", "VIRTUAL"),
      ]),
    ).toEqual([]);
  });
});

describe("hasNumbers", () => {
  it("needs a number, and a currency alone is not one", () => {
    expect(hasNumbers(empty)).toBe(false);
    expect(hasNumbers({ ...empty, currency: "BRL" })).toBe(false);
    expect(hasNumbers({ ...empty, orders: 0 })).toBe(true);
    expect(hasNumbers({ ...empty, orders_change: -12.5 })).toBe(true);
  });
});
