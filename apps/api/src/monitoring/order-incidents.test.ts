import { describe, expect, it } from "bun:test";
import type { OrderMonitorVerdict } from "@decocms/shared/order-monitor";
import {
  bucketTime,
  incidentAction,
  incidentTitle,
  RECOVERY_MS,
} from "./order-incidents";
import { toDailyMarkers, toMarkers } from "./order-pushes";

describe("incidentAction", () => {
  const held = RECOVERY_MS;
  it.each([
    // prev, next, hasCard, heldMs, retryOpen, action
    [undefined, "warning", false, 0, false, "open"],
    ["ok", "alert", false, 0, false, "open"],
    ["low-volume", "warning", false, 0, false, "open"],
    ["warning", "alert", true, 0, false, "update"],
    ["alert", "warning", true, 0, false, "update"],
    ["low-volume", "alert", true, 0, false, "update"],
    // Ok has to hold before the card closes, so a flapping window keeps it.
    ["alert", "ok", true, 0, false, "none"],
    ["ok", "warning", true, 0, false, "update"],
    ["ok", "ok", true, held, false, "close"],
    ["low-volume", "ok", true, held, false, "close"],
    // Too few orders mid-incident: noted on the card, not closed.
    ["alert", "low-volume", true, 0, false, "pause"],
    ["low-volume", "low-volume", true, held, false, "none"],
    // A person deleted the card mid-incident: don't reopen it.
    ["warning", "alert", false, 0, false, "none"],
    ["alert", "ok", false, held, false, "none"],
    ["ok", "low-volume", false, 0, false, "none"],
    ["alert", "alert", true, 0, false, "none"],
    // An open waiting on VTEX is retried until a card exists.
    ["warning", "warning", false, 0, true, "open"],
    ["warning", "alert", false, 0, true, "open"],
    ["warning", "warning", true, 0, true, "none"],
  ] as const)(
    "%s → %s (card: %s, held: %s, retry: %s) = %s",
    (prev, next, hasCard, heldMs, retryOpen, action) => {
      expect(incidentAction(prev, next, { hasCard, heldMs, retryOpen })).toBe(
        action,
      );
    },
  );
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
