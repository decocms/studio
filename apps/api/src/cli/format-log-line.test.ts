import { describe, expect, it } from "bun:test";
import { formatLogLine } from "./format-log-line";

describe("formatLogLine", () => {
  it("joins string args with spaces", () => {
    expect(formatLogLine(["a", "b", "c"])).toBe("a b c");
  });

  it("coerces non-string args with String()", () => {
    expect(formatLogLine(["n=", 42, true])).toBe("n= 42 true");
  });

  it("returns an empty string for no args", () => {
    expect(formatLogLine([])).toBe("");
  });
});
