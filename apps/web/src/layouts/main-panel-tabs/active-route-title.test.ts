import { describe, expect, test } from "bun:test";
import { resolveActiveRouteTitle } from "./active-route-title";

describe("resolveActiveRouteTitle", () => {
  test("keeps the agent title available for Overview", () => {
    expect(
      resolveActiveRouteTitle({
        activeTab: "overview",
        entityTitle: "Project Alpha",
      }),
    ).toBe("Project Alpha");
  });

  test("resolves a curated app label outside the route body", () => {
    expect(
      resolveActiveRouteTitle({
        activeTab: "app:conn_1:get_orders",
        pinnedViews: [
          {
            connectionId: "conn_1",
            toolName: "get_orders",
            label: "Order Explorer",
          },
        ],
      }),
    ).toBe("Order Explorer");
  });

  test("formats an empty curated label like the app route", () => {
    expect(
      resolveActiveRouteTitle({
        activeTab: "app:conn_1:get_orders",
        pinnedViews: [
          {
            connectionId: "conn_1",
            toolName: "get_orders",
            label: "   ",
          },
        ],
      }),
    ).toBe("Get Orders");
  });

  test("does not borrow a label from a different connection", () => {
    expect(
      resolveActiveRouteTitle({
        activeTab: "app:conn_2:get_orders",
        pinnedViews: [
          {
            connectionId: "conn_1",
            toolName: "get_orders",
            label: "Order Explorer",
          },
        ],
      }),
    ).toBeUndefined();
  });
});
