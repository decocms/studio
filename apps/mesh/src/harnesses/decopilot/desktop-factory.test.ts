import { describe, expect, it } from "bun:test";
import { isDesktopHarnessContext } from "./desktop-factory";
import type { HarnessContext } from "../types";
import { trace, metrics } from "@opentelemetry/api";

const baseCtx: HarnessContext = {
  tracer: trace.getTracer("test"),
  meter: metrics.getMeter("test"),
  metadata: { threadId: "t1", orgId: "o1", userId: "u1" },
};

describe("isDesktopHarnessContext", () => {
  it("returns true for a narrow HarnessContext (no storage/db)", () => {
    expect(isDesktopHarnessContext(baseCtx)).toBe(true);
  });

  it("returns false when storage is present (StudioContext)", () => {
    const ctx = { ...baseCtx, storage: {}, db: {} };
    expect(isDesktopHarnessContext(ctx)).toBe(false);
  });

  it("returns false when only db is present", () => {
    const ctx = { ...baseCtx, db: {} };
    expect(isDesktopHarnessContext(ctx)).toBe(false);
  });

  it("returns false when only storage is present", () => {
    const ctx = { ...baseCtx, storage: {} };
    expect(isDesktopHarnessContext(ctx)).toBe(false);
  });
});
