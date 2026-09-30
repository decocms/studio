import { describe, expect, test } from "bun:test";
import { createWindowLimiter } from "./rate-limit";

describe("createWindowLimiter", () => {
  test("allows max hits per window, then refuses until it resets", () => {
    const limiter = createWindowLimiter({ max: 2, windowMs: 1000 });
    expect(limiter.hit("a", 0)).toBe(true);
    expect(limiter.hit("a", 10)).toBe(true);
    expect(limiter.hit("a", 20)).toBe(false);
    expect(limiter.hit("b", 20)).toBe(true);
    expect(limiter.hit("a", 1001)).toBe(true);
  });

  test("stays bounded by maxKeys", () => {
    const limiter = createWindowLimiter({ max: 1, windowMs: 1000, maxKeys: 2 });
    expect(limiter.hit("a", 0)).toBe(true);
    expect(limiter.hit("b", 0)).toBe(true);
    // "c" evicts the oldest key ("a"), whose counter restarts.
    expect(limiter.hit("c", 0)).toBe(true);
    expect(limiter.hit("a", 0)).toBe(true);
    expect(limiter.hit("c", 0)).toBe(false);
  });
});
