import { describe, expect, it } from "bun:test";
import { isCliHarness } from "./cli-harness";

describe("isCliHarness", () => {
  it("is true for codex", () => {
    expect(isCliHarness("codex")).toBe(true);
  });
  it("is true for claude-code", () => {
    expect(isCliHarness("claude-code")).toBe(true);
  });
  it("is false for decopilot", () => {
    expect(isCliHarness("decopilot")).toBe(false);
  });
});
