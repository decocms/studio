import { describe, expect, it } from "bun:test";
import { localName } from "./agent-prompts";

describe("agent-prompts localName", () => {
  it("zero-pads the index so filenames sort in authored order", () => {
    const names = [2, 9, 10, 19].map((i) => localName(i, "Prompt"));
    const sorted = [...names].sort();
    expect(sorted).toEqual(names);
  });

  it("falls back to a stable slug when the title has no word characters", () => {
    expect(localName(0, "!!!")).toBe("00-prompt");
  });
});
