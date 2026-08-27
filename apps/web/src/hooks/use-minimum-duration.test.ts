import { describe, expect, it } from "bun:test";
import { remainingHoldMs } from "./use-minimum-duration";

describe("remainingHoldMs", () => {
  it("owes nothing when no run is in progress", () => {
    expect(remainingHoldMs(null, 1_000, 300)).toBe(0);
  });

  it("owes the full window the instant a run starts", () => {
    expect(remainingHoldMs(1_000, 1_000, 300)).toBe(300);
  });

  it("owes the remainder partway through", () => {
    expect(remainingHoldMs(1_000, 1_120, 300)).toBe(180);
  });

  it("owes nothing once the window has elapsed", () => {
    expect(remainingHoldMs(1_000, 1_300, 300)).toBe(0);
  });

  it("never owes a negative amount on a long run", () => {
    expect(remainingHoldMs(1_000, 9_999, 300)).toBe(0);
  });

  it("clamps a clock that went backwards rather than owing extra", () => {
    expect(remainingHoldMs(1_000, 900, 300)).toBe(300);
  });
});
