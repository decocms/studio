import { describe, expect, test } from "bun:test";
import { resolveWindow } from "./monitor";

describe("resolveWindow custom range", () => {
  test("accepts a same-day custom range", () => {
    const w = resolveWindow("custom", "2026-01-01", "2026-01-01");
    expect(w).toEqual({
      since: "2026-01-01",
      until: "2026-01-01",
      granularity: "hourly",
      days: 1,
    });
  });

  test("accepts a custom range up to the 1y cap", () => {
    const w = resolveWindow("custom", "2025-01-01", "2026-01-01");
    expect(w).not.toBeNull();
    expect(w?.granularity).toBe("daily");
  });

  test("rejects a custom range past the cap (unbounded warehouse scan)", () => {
    expect(resolveWindow("custom", "2000-01-01", "2026-01-01")).toBeNull();
  });

  test("rejects a reversed since/until", () => {
    expect(resolveWindow("custom", "2026-01-10", "2026-01-01")).toBeNull();
  });

  test("rejects a malformed date", () => {
    expect(resolveWindow("custom", "not-a-date", "2026-01-01")).toBeNull();
  });

  test("resolves a preset unaffected by the custom-range changes", () => {
    const w = resolveWindow("7d", undefined, undefined);
    expect(w?.days).toBe(7);
    expect(w?.granularity).toBe("daily");
  });
});
