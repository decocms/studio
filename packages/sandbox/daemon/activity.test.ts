import { describe, expect, it } from "bun:test";
import {
  __resetActivityForTests,
  bumpActivity,
  getIdleStatus,
} from "./activity";

describe("daemon activity", () => {
  it("reports idleMs growing from a fixed reference time", () => {
    const t0 = Date.UTC(2026, 3, 1, 12, 0, 0);
    __resetActivityForTests(t0);
    const a = getIdleStatus(t0 + 250);
    expect(a.lastActivityAt).toBe(new Date(t0).toISOString());
    expect(a.idleMs).toBe(250);
    const b = getIdleStatus(t0 + 1000);
    expect(b.idleMs).toBe(1000);
  });

  it("bump resets idleMs to 0", () => {
    const t0 = Date.UTC(2026, 3, 1, 12, 0, 0);
    __resetActivityForTests(t0);
    expect(getIdleStatus(t0 + 5000).idleMs).toBe(5000);
    bumpActivity(t0 + 5000);
    expect(getIdleStatus(t0 + 5000).idleMs).toBe(0);
    expect(getIdleStatus(t0 + 5500).idleMs).toBe(500);
  });

  it("clock skew (now < lastActivityAt) clamps idleMs to 0", () => {
    const t0 = Date.UTC(2026, 3, 1, 12, 0, 0);
    __resetActivityForTests(t0);
    expect(getIdleStatus(t0 - 1000).idleMs).toBe(0);
  });
});
