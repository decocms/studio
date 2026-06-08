import { describe, it, expect } from "bun:test";
import { detectGap, reconcileDurable, type RenderedMessage } from "./reconcile";

describe("detectGap (B4 / R5 — gaps are arithmetic, not silent)", () => {
  it("contiguous next seq is ok", () => {
    expect(detectGap(4, 5)).toBe("ok");
  });
  it("a jump is a gap", () => {
    expect(detectGap(4, 7)).toBe("gap");
  });
  it("a lower-or-equal seq is a duplicate", () => {
    expect(detectGap(4, 4)).toBe("duplicate");
    expect(detectGap(4, 2)).toBe("duplicate");
  });
});

describe("reconcileDurable (R6/R7 — durable wins, partial never lingers)", () => {
  const live: RenderedMessage = {
    id: "m1",
    parts: ["partial..."],
    status: "in_progress",
  };
  const durable: RenderedMessage = {
    id: "m1",
    parts: ["complete"],
    status: "complete",
  };

  it("durable unconditionally replaces the live partial with the same id", () => {
    const next = reconcileDurable(new Map([["m1", live]]), durable);
    expect(next.get("m1")).toEqual(durable);
    expect(next.size).toBe(1); // no lingering second row
  });

  it("durable wins regardless of arrival order (durable already present, live arrives late)", () => {
    const next = reconcileDurable(new Map([["m1", durable]]), live);
    // live must NOT overwrite a complete durable message
    expect(next.get("m1")!.status).toBe("complete");
  });
});
