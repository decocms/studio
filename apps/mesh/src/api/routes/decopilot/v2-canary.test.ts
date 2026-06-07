import { describe, it, expect } from "bun:test";
import { parseV2Percent, shouldPinV2 } from "./v2-canary";

describe("parseV2Percent", () => {
  it("defaults to 0 (off) for missing/invalid input", () => {
    expect(parseV2Percent(undefined)).toBe(0);
    expect(parseV2Percent("")).toBe(0);
    expect(parseV2Percent("nope")).toBe(0);
  });

  it("clamps to [0, 100]", () => {
    expect(parseV2Percent("-5")).toBe(0);
    expect(parseV2Percent("150")).toBe(100);
    expect(parseV2Percent("100")).toBe(100);
    expect(parseV2Percent("37")).toBe(37);
  });

  it("parses leading-int strings", () => {
    expect(parseV2Percent("10")).toBe(10);
  });
});

describe("shouldPinV2", () => {
  it("is OFF by default (percent 0 → never)", () => {
    for (const id of ["thrd_a", "thrd_b", "thrd_c", "thrd_d"]) {
      expect(shouldPinV2(id, 0)).toBe(false);
    }
  });

  it("percent 100 → always", () => {
    for (const id of ["thrd_a", "thrd_b", "thrd_c", "thrd_d"]) {
      expect(shouldPinV2(id, 100)).toBe(true);
    }
  });

  it("is deterministic and stable per thread id", () => {
    // Same id + same percent must ALWAYS resolve the same way (a re-evaluation
    // can't flip a thread between v1 and v2).
    for (const id of ["thrd_x", "thrd_y", "thrd_z"]) {
      const first = shouldPinV2(id, 50);
      for (let i = 0; i < 100; i++) {
        expect(shouldPinV2(id, 50)).toBe(first);
      }
    }
  });

  it("monotonic in percent: once selected at p, stays selected for all p' > p", () => {
    const id = "thrd_mono";
    let firstTrue = -1;
    for (let p = 0; p <= 100; p++) {
      const sel = shouldPinV2(id, p);
      if (sel && firstTrue === -1) firstTrue = p;
      if (firstTrue !== -1 && p >= firstTrue) {
        expect(sel).toBe(true);
      }
    }
  });

  it("spreads ids roughly uniformly across buckets", () => {
    // Sanity: ~10% of a large id population lands in the 10% canary slice.
    let selected = 0;
    const n = 5000;
    for (let i = 0; i < n; i++) {
      if (shouldPinV2(`thrd_${i}`, 10)) selected++;
    }
    const ratio = selected / n;
    // Generous tolerance — this is a smoke test of the hash spread, not a
    // statistical guarantee.
    expect(ratio).toBeGreaterThan(0.05);
    expect(ratio).toBeLessThan(0.15);
  });
});
