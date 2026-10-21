import { describe, expect, test } from "bun:test";
import { parseSubscriptionUsage } from "./schema";

const now = new Date("2026-10-20T12:00:00Z");
describe("personal subscription usage parsing", () => {
  test("Codex windows are normalized without account data", () => {
    const result = parseSubscriptionUsage(
      "codex",
      {
        account_id: "account_example",
        email: "user@example.test",
        access_token: "synthetic-secret",
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 42,
            limit_window_seconds: 18000,
            reset_at: 1792501200,
          },
          secondary_window: null,
        },
        code_review_rate_limit: { primary_window: { used_percent: 5 } },
      },
      now,
    );
    expect(result.status).toBe("available");
    expect(result.windows).toEqual([
      {
        id: "primary",
        usedPercent: 42,
        windowSeconds: 18000,
        resetAt: new Date(1792501200 * 1000).toISOString(),
      },
      {
        id: "code_review_primary",
        usedPercent: 5,
        windowSeconds: null,
        resetAt: null,
      },
    ]);
    expect(JSON.stringify(result)).not.toContain("account_example");
    expect(JSON.stringify(result)).not.toContain("example.test");
    expect(JSON.stringify(result)).not.toContain("synthetic-secret");
  });
  test("Claude limits retain zero, exhaustion, and model-specific windows", () => {
    const result = parseSubscriptionUsage(
      "claude",
      {
        five_hour: { utilization: 0, resets_at: "2026-10-20T15:00:00-03:00" },
        seven_day: { utilization: 100, resets_at: null },
        seven_day_sonnet: { utilization: 90.5 },
        seven_day_opus: null,
      },
      now,
    );
    expect(result.limitReached).toBe(true);
    expect(result.windows.map((w) => w.usedPercent)).toEqual([0, 100, 90.5]);
    expect(result.windows[0]?.resetAt).toBe("2026-10-20T18:00:00.000Z");
    expect(result.windows[1]?.resetAt).toBeNull();
  });
  test("absent counters never mean zero usage", () => {
    for (const provider of ["claude", "codex"] as const) {
      expect(parseSubscriptionUsage(provider, {}, now)).toMatchObject({
        status: "unavailable",
        reason: "no_data",
        limitReached: null,
        windows: [],
      });
    }
    expect(
      parseSubscriptionUsage("codex", { rate_limit: { allowed: false } }, now),
    ).toMatchObject({ status: "available", limitReached: true, windows: [] });
  });
  test("invalid data is rejected instead of producing a healthy gauge", () => {
    for (const utilization of [-1, 101, NaN, Infinity, "12", null]) {
      expect(() =>
        parseSubscriptionUsage("claude", { five_hour: { utilization } }, now),
      ).toThrow();
    }
    for (const raw of [
      null,
      [],
      { five_hour: { utilization: 10, resets_at: "invalid" } },
    ]) {
      expect(() => parseSubscriptionUsage("claude", raw, now)).toThrow();
    }
    expect(() =>
      parseSubscriptionUsage(
        "codex",
        {
          rate_limit: {
            primary_window: {
              used_percent: 20,
              reset_at: Number.MAX_SAFE_INTEGER,
            },
          },
        },
        now,
      ),
    ).toThrow();
  });
});
