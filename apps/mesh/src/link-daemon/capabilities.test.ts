import { describe, expect, it } from "bun:test";
import { detectCapabilities } from "./capabilities";

describe("detectCapabilities", () => {
  it("always includes decopilot-sandbox", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => false,
      detectCodex: async () => false,
    });
    expect(caps).toEqual(["decopilot-sandbox"]);
  });

  it("includes claude-code when probe succeeds", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => true,
      detectCodex: async () => false,
    });
    expect(caps).toEqual(["decopilot-sandbox", "claude-code"]);
  });

  it("includes codex when probe succeeds", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => false,
      detectCodex: async () => true,
    });
    expect(caps).toEqual(["decopilot-sandbox", "codex"]);
  });

  it("includes both when both probes succeed", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => true,
      detectCodex: async () => true,
    });
    expect(caps).toEqual(["decopilot-sandbox", "claude-code", "codex"]);
  });

  it("treats throwing probes as false", async () => {
    const caps = await detectCapabilities({
      detectClaudeCode: async () => {
        throw new Error("not found");
      },
      detectCodex: async () => {
        throw new Error("oops");
      },
    });
    expect(caps).toEqual(["decopilot-sandbox"]);
  });
});
