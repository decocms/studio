import { describe, expect, it } from "bun:test";
import { cliProviderName } from "./cli-harness";

// These strings are a cross-language contract: `apps/native/crates/harness`
// stamps `codingAgentProvider` on the Rust side, and the read side
// (`resolveCliSessionRef` / `computeCliDelta`) matches on these exact values.
// Renaming one here without the other silently breaks session resume.
describe("cliProviderName", () => {
  it("maps codex", () => {
    expect(cliProviderName("codex")).toBe("codex");
  });
  it("maps claude-code", () => {
    expect(cliProviderName("claude-code")).toBe("claude-code");
  });
  it("is undefined for decopilot, which has no on-disk session", () => {
    expect(cliProviderName("decopilot")).toBeUndefined();
  });
});
