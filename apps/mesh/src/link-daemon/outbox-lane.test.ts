import { describe, expect, it } from "bun:test";
import type { DispatchSSEEvent } from "../links/protocol";
import { laneForEvent } from "./outbox-lane";

const chunk = (type: string): DispatchSSEEvent => ({
  type: "ui-message-chunk",
  chunk: { type },
});

describe("laneForEvent", () => {
  it("routes tool + lifecycle chunks to P1", () => {
    for (const t of [
      "tool-input-start",
      "tool-input-delta",
      "tool-input-available",
      "tool-output-available",
      "start",
      "start-step",
      "finish-step",
      "finish",
    ]) {
      expect(laneForEvent(chunk(t))).toBe(1);
    }
  });

  it("routes text/reasoning/data deltas to P2", () => {
    for (const t of ["text-delta", "reasoning-delta", "data-progress"]) {
      expect(laneForEvent(chunk(t))).toBe(2);
    }
  });

  it("routes the terminal done event to P1", () => {
    expect(laneForEvent({ type: "done" })).toBe(1);
  });

  it("routes error events to P1", () => {
    expect(laneForEvent({ type: "error", code: "x", message: "y" })).toBe(1);
  });

  it("defaults unknown ui-message-chunk types to P2 (never starves P1)", () => {
    expect(laneForEvent(chunk("mystery-future-delta"))).toBe(2);
  });
});
