import { describe, expect, test } from "bun:test";
import { isContentEditingEnabled } from "./content-editing-gate";

describe("isContentEditingEnabled", () => {
  test("enables both content-editing surfaces unless CMS is explicitly off", () => {
    expect(isContentEditingEnabled("on")).toBe(true);
    expect(isContentEditingEnabled("off")).toBe(false);
  });
});
