import { describe, expect, it } from "bun:test";
import type { OrderMonitorVerdict } from "@decocms/shared/order-monitor";
import { alertBody, alertLink, alertTitle, bucketTime } from "./order-alerts";
import { toDailyMarkers, toMarkers } from "./order-pushes";

describe("alert text", () => {
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
    expect(alertTitle("orders_drop", "Store", verdict({}))).toBe(
      "Orders at Store are 85 % below expected since 14:15",
    );
  });

  it("gives counts for a spike", () => {
    expect(
      alertTitle(
        "denied_spike",
        "Store",
        verdict({ observed: 30, expected: 2 }),
      ),
    ).toBe(
      "Unpaid cancellations at Store: 30 in an hour vs 2 expected, since 14:15",
    );
  });

  it("states the window's numbers", () => {
    expect(alertBody("cancel_spike", verdict({ observed: 1234 }))).toBe(
      "Cancellations: 1,234 between 14:15 and 15:15 vs 40 expected.",
    );
  });

  it("links the store's chart at the window's start, in the store's day", () => {
    const link = alertLink(
      "my org",
      "conn_1",
      new Date("2026-10-19T18:20:00Z"),
      verdict({}),
    );
    expect(link).toBe(
      "/my%20org/settings/monitor?tab=stores&store=conn_1&at=2026-10-19T17%3A15%3A00.000Z",
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

  it("keeps the same slot on different days as separate pushes", () => {
    const markers = toDailyMarkers(
      [
        commit("new", "2026-10-29T14:05:00Z"),
        commit("old", "2026-10-18T14:10:00Z"),
      ],
      "UTC",
    );
    expect(markers.map((m) => [m.time, m.commits.map((c) => c.sha)])).toEqual([
      ["2026-10-29T14:05:00Z", ["new"]],
      ["2026-10-18T14:10:00Z", ["old"]],
    ]);
  });
});

it("bucketTime reads a window that starts the day before", () => {
  expect(bucketTime(-2)).toBe("23:30");
  expect(bucketTime(0)).toBe("00:00");
  expect(bucketTime(95)).toBe("23:45");
});
