import { describe, expect, it } from "bun:test";
import {
  DEFAULT_TOKEN_SKEW_MS,
  scheduleTokenRefresh,
} from "./uplink-token-ttl";

describe("scheduleTokenRefresh", () => {
  it("schedules a refresh skew before expiry", () => {
    const now = 1_000_000;
    const expiresAt = now + 60 * 60 * 1000; // 60 min out
    const r = scheduleTokenRefresh(expiresAt, { nowMs: now });
    expect(r.refreshAtMs).toBe(expiresAt - DEFAULT_TOKEN_SKEW_MS);
    expect(r.isExpired).toBe(false);
    expect(r.remainingMs).toBe(60 * 60 * 1000 - DEFAULT_TOKEN_SKEW_MS);
  });

  it("flags an already-expired token", () => {
    const now = 1_000_000;
    const r = scheduleTokenRefresh(now - 1, { nowMs: now });
    expect(r.isExpired).toBe(true);
    expect(r.remainingMs).toBe(0);
  });

  it("clamps remaining to 0 when the refresh window is already past", () => {
    const now = 1_000_000;
    // expiresAt is 1 min out but skew is 5 min → refreshAt already past.
    const r = scheduleTokenRefresh(now + 60_000, { nowMs: now });
    expect(r.remainingMs).toBe(0);
    expect(r.isExpired).toBe(false);
  });

  it("honors a custom skew", () => {
    const now = 1_000_000;
    const r = scheduleTokenRefresh(now + 10_000, { nowMs: now, skewMs: 2_000 });
    expect(r.refreshAtMs).toBe(now + 8_000);
    expect(r.remainingMs).toBe(8_000);
  });
});
