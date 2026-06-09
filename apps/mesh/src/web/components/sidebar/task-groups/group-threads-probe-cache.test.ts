import { afterEach, describe, expect, it } from "bun:test";
import {
  clearGroupThreadsProbeCacheForTests,
  ensureGroupProbe,
  getCachedGroupProbeResult,
  inferServerHasMoreWithoutProbe,
} from "./group-threads-probe-cache";
import { resetGroupThreadsFetchQueueForTests } from "./group-threads-fetch-queue";
import { GROUP_PAGE_SIZE } from "./next-page-offset";

afterEach(() => {
  clearGroupThreadsProbeCacheForTests();
  resetGroupThreadsFetchQueueForTests();
});

describe("inferServerHasMoreWithoutProbe", () => {
  it("returns false when the global list is exhausted", () => {
    expect(inferServerHasMoreWithoutProbe(0, false)).toBe(false);
    expect(inferServerHasMoreWithoutProbe(3, false)).toBe(false);
    expect(inferServerHasMoreWithoutProbe(GROUP_PAGE_SIZE, false)).toBe(false);
  });

  it("returns true when a full page is visible and the global list has more", () => {
    expect(inferServerHasMoreWithoutProbe(GROUP_PAGE_SIZE, true)).toBe(true);
  });

  it("returns null when a network probe is still required", () => {
    expect(inferServerHasMoreWithoutProbe(0, true)).toBe(null);
    expect(inferServerHasMoreWithoutProbe(3, true)).toBe(null);
  });
});

describe("ensureGroupProbe", () => {
  it("deduplicates concurrent probes for the same identity", async () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return Promise.resolve(true);
    };

    const results: boolean[] = [];
    ensureGroupProbe("org|agent|vm-a|all|all|", probe, (value) => {
      results.push(value);
    });
    ensureGroupProbe("org|agent|vm-a|all|all|", probe, (value) => {
      results.push(value);
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(calls).toBe(1);
    expect(results).toEqual([true, true]);
    expect(getCachedGroupProbeResult("org|agent|vm-a|all|all|")).toBe(true);
  });

  it("reuses cached results without calling the probe again", async () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return Promise.resolve(false);
    };

    ensureGroupProbe("cached", probe, () => {});
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(calls).toBe(1);

    let secondResult: boolean | undefined;
    ensureGroupProbe("cached", probe, (value) => {
      secondResult = value;
    });
    expect(secondResult).toBe(false);
    expect(calls).toBe(1);
  });

  it("does not cache failed probes so a later call can retry", async () => {
    let calls = 0;
    const probe = () => {
      calls++;
      return Promise.reject(new Error("network"));
    };

    const results: boolean[] = [];
    ensureGroupProbe("retry", probe, (value) => {
      results.push(value);
    });
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(calls).toBe(1);
    expect(results).toEqual([false]);
    expect(getCachedGroupProbeResult("retry")).toBeUndefined();

    ensureGroupProbe(
      "retry",
      async () => {
        calls++;
        return true;
      },
      (value) => {
        results.push(value);
      },
    );
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(calls).toBe(2);
    expect(results).toEqual([false, true]);
  });
});
