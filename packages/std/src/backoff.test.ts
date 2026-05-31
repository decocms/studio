import { describe, expect, test } from "bun:test";
import { exponentialBackoffWithJitter } from "./backoff";

describe("exponentialBackoffWithJitter", () => {
  describe("jitter = 0 (deterministic)", () => {
    test("grows base * multiplier ** attempt", () => {
      expect(exponentialBackoffWithJitter(60000, 1000, 0, 2, 0)).toBe(1000);
      expect(exponentialBackoffWithJitter(60000, 1000, 1, 2, 0)).toBe(2000);
      expect(exponentialBackoffWithJitter(60000, 1000, 2, 2, 0)).toBe(4000);
      expect(exponentialBackoffWithJitter(60000, 1000, 3, 2, 0)).toBe(8000);
    });

    test("attempt 0 is always the base delay", () => {
      expect(exponentialBackoffWithJitter(60000, 500, 0, 2, 0)).toBe(500);
    });

    test("is capped at `cap`", () => {
      // would be 4000 at attempt 2, capped to 1500
      expect(exponentialBackoffWithJitter(1500, 1000, 2, 2, 0)).toBe(1500);
    });

    test("honors a non-2 multiplier", () => {
      expect(exponentialBackoffWithJitter(60000, 100, 3, 3, 0)).toBe(2700); // 100 * 3^3
    });
  });

  describe("jitter ranges (probabilistic, 1000 samples)", () => {
    const samples = (fn: () => number, n = 1000) =>
      Array.from({ length: n }, fn);

    test("jitter = 1 → uniformly within [0, exp]", () => {
      const exp = 1000; // base at attempt 0
      const xs = samples(() =>
        exponentialBackoffWithJitter(60000, 1000, 0, 2, 1),
      );
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(0);
        expect(x).toBeLessThanOrEqual(exp);
      }
      // Sanity: not all clustered at the cap.
      expect(Math.min(...xs)).toBeLessThan(exp / 2);
    });

    test("jitter = 0.5 → 'equal jitter' within [exp/2, exp]", () => {
      const exp = 1000;
      const xs = samples(() =>
        exponentialBackoffWithJitter(60000, 1000, 0, 2, 0.5),
      );
      for (const x of xs) {
        expect(x).toBeGreaterThanOrEqual(exp / 2);
        expect(x).toBeLessThanOrEqual(exp);
      }
    });
  });
});
