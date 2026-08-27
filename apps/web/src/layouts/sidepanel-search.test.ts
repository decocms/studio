import { describe, expect, test } from "bun:test";
import { sidePanelSearchSchema } from "./sidepanel-search";

const parse = (value: unknown) => sidePanelSearchSchema.parse(value);

describe("sidePanelSearchSchema", () => {
  test("passes booleans through unchanged", () => {
    expect(parse(true)).toBe(true);
    expect(parse(false)).toBe(false);
  });

  test("absent means no opinion, so the route/agent default decides", () => {
    expect(parse(undefined)).toBeUndefined();
  });

  test("translates the legacy `chat`/`0` pair instead of rejecting it", () => {
    expect(parse("chat")).toBe(true);
    expect(parse(0)).toBe(false);
  });

  test("falls back to the default rather than throwing on anything else", () => {
    for (const value of ["", "0", "true", "files", 1, null, {}, []]) {
      expect(parse(value)).toBeUndefined();
    }
  });
});
