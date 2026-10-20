import { describe, expect, test } from "bun:test";
import { normalizeCopilotToken } from "./index";

describe("normalizeCopilotToken", () => {
  test("trims a fine-grained token", () => {
    expect(normalizeCopilotToken("  github_pat_abc\n")).toBe("github_pat_abc");
  });

  test("rejects a classic token, which Copilot ignores", () => {
    expect(() => normalizeCopilotToken("ghp_abc")).toThrow(/fine-grained/);
  });

  test("rejects empty and multi-part input", () => {
    expect(() => normalizeCopilotToken("   ")).toThrow(/empty/);
    expect(() => normalizeCopilotToken("github_pat_a b")).toThrow(/spaces/);
  });
});
