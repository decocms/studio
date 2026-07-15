import { describe, expect, it } from "bun:test";
import { stripAnsi } from "./strip-ansi";

describe("stripAnsi", () => {
  it("removes color escape codes", () => {
    expect(stripAnsi("\x1b[32mok\x1b[0m")).toBe("ok");
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsi("plain text")).toBe("plain text");
  });
});
