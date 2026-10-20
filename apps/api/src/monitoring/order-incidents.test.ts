import { describe, expect, it } from "bun:test";
import type { OrderMonitorVerdict } from "@decocms/shared/order-monitor";
import { incidentAction, incidentTitle } from "./order-incidents";
import { toMarkers } from "./order-pushes";

describe("incidentAction", () => {
  it.each([
    // prev, next, hasCard, action
    [undefined, "warning", false, "open"],
    ["ok", "alert", false, "open"],
    ["low-volume", "warning", false, "open"],
    ["warning", "alert", true, "update"],
    ["alert", "warning", true, "update"],
    ["low-volume", "alert", true, "update"],
    ["alert", "ok", true, "close"],
    ["low-volume", "ok", true, "close"],
    // A person deleted the card mid-incident: don't reopen it.
    ["warning", "alert", false, "none"],
    ["alert", "ok", false, "none"],
    ["ok", "low-volume", false, "none"],
    ["alert", "low-volume", true, "none"],
    ["alert", "alert", true, "none"],
  ] as const)("%s → %s (card: %s) = %s", (prev, next, hasCard, action) => {
    expect(incidentAction(prev, next, hasCard)).toBe(action);
  });
});

describe("incidentTitle", () => {
  const verdict = (
    over: Partial<OrderMonitorVerdict>,
  ): OrderMonitorVerdict => ({
    status: "alert",
    from: 57,
    to: 61,
    observed: 6,
    expected: 40,
    warnAt: 12,
    alertAt: 6,
    level: 1,
    timezone: "America/Sao_Paulo",
    ...over,
  });

  it("says how far below expected orders are, and since when", () => {
    expect(incidentTitle("orders_drop", "Store", verdict({}))).toBe(
      "Orders at Store are 85 % below expected since 14:15",
    );
  });

  it("gives counts for a spike", () => {
    expect(
      incidentTitle(
        "denied_spike",
        "Store",
        verdict({ observed: 30, expected: 2 }),
      ),
    ).toBe(
      "Payment denials at Store: 30 in an hour vs 2 expected, since 14:15",
    );
  });
});

describe("toMarkers", () => {
  const commit = (sha: string, date: string) => ({
    sha,
    date,
    message: `msg ${sha}`,
    author: { name: null, email: null, login: `dev-${sha}` },
  });

  it("collapses commits in the same local 15-minute bucket", () => {
    const markers = toMarkers(
      [
        commit("b", "2026-10-19T17:10:00Z"),
        commit("a", "2026-10-19T17:01:00Z"),
        commit("c", "2026-10-19T17:20:00Z"),
      ],
      "America/Sao_Paulo",
    );
    expect(markers.map((m) => m.bucket)).toEqual([56, 57]);
    expect(markers[0]!.time).toBe("2026-10-19T17:01:00Z");
    expect(markers[0]!.commits.map((c) => c.author)).toEqual([
      "dev-a",
      "dev-b",
    ]);
  });
});
