import { describe, expect, it } from "bun:test";
import { prStateIsPinnable } from "./enqueue-super-agent";

describe("prStateIsPinnable", () => {
  it("is true for open", () => {
    expect(prStateIsPinnable("open")).toBe(true);
  });

  it("is true for unknown (a GitHub read blip must not un-pin the branch)", () => {
    expect(prStateIsPinnable(null)).toBe(true);
  });

  it("is false for a definitively closed PR", () => {
    expect(prStateIsPinnable("closed")).toBe(false);
  });
});
