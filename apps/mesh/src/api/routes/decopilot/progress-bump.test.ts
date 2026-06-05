import { describe, it, expect } from "bun:test";
import { ProgressBumpThrottle } from "./progress-bump";

describe("ProgressBumpThrottle", () => {
  it("allows the first bump, then throttles within the interval", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 0)).toBe(true);
    expect(t.shouldBump("task1", 100)).toBe(false);
    expect(t.shouldBump("task1", 2_999)).toBe(false);
  });

  it("allows another bump once the interval has elapsed", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 0)).toBe(true);
    expect(t.shouldBump("task1", 3_000)).toBe(true);
    // resets the window from the last accepted bump
    expect(t.shouldBump("task1", 4_000)).toBe(false);
    expect(t.shouldBump("task1", 6_000)).toBe(true);
  });

  it("is independent per task", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("a", 0)).toBe(true);
    expect(t.shouldBump("b", 0)).toBe(true);
    expect(t.shouldBump("a", 100)).toBe(false);
    expect(t.shouldBump("b", 100)).toBe(false);
  });

  it("clear() forgets a task so the next bump is allowed immediately", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 0)).toBe(true);
    expect(t.shouldBump("task1", 100)).toBe(false);
    t.clear("task1");
    expect(t.shouldBump("task1", 200)).toBe(true);
  });

  it("boundary: exactly at the interval is allowed", () => {
    const t = new ProgressBumpThrottle(3_000);
    expect(t.shouldBump("task1", 1_000)).toBe(true);
    // now - last === interval → not < interval → allowed
    expect(t.shouldBump("task1", 4_000)).toBe(true);
  });
});
