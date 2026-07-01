import { describe, expect, it } from "bun:test";
import { resolveOpenCommand } from "./open-url";

describe("resolveOpenCommand", () => {
  it("uses the right opener per platform", () => {
    expect(resolveOpenCommand("darwin")).toBe("open");
    expect(resolveOpenCommand("win32")).toBe("start");
    expect(resolveOpenCommand("linux")).toBe("xdg-open");
  });
});
