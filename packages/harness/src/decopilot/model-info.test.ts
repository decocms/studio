import { describe, expect, it } from "bun:test";
import type { ModelInfo } from "./model-info";

describe("ModelInfo (portable request shape)", () => {
  it("accepts a minimal request-shape model descriptor", () => {
    const m: ModelInfo = { id: "deep-research-preview" };
    expect(m.id).toBe("deep-research-preview");
  });
});
