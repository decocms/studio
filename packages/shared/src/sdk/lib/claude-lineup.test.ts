import { describe, expect, it } from "bun:test";
import { isClaudeCodeModel } from "../../harness/claude-code-models";
import {
  CLAUDE_OPUS,
  CLAUDE_SONNET,
  claudeDefaultEffort,
} from "./claude-lineup";

describe("claude lineup", () => {
  it("renders one version in each route's id form", () => {
    for (const [family, ids] of [
      ["opus", CLAUDE_OPUS],
      ["sonnet", CLAUDE_SONNET],
    ] as const) {
      const version = ids.anthropic.replace(`claude-${family}-`, "");
      expect(version).toMatch(/^\d+-\d+$/);
      const dotted = version.replace("-", ".");
      expect(ids.openrouter).toBe(`anthropic/claude-${family}-${dotted}`);
      expect(ids.copilot).toBe(`claude-${family}-${dotted}`);
    }
  });

  it("names ids the claude-code harness accepts on each credential", () => {
    for (const ids of [CLAUDE_OPUS, CLAUDE_SONNET]) {
      expect(isClaudeCodeModel("anthropic", ids.anthropic)).toBe(true);
      expect(isClaudeCodeModel("openrouter", ids.openrouter)).toBe(true);
      expect(isClaudeCodeModel("deco", ids.openrouter)).toBe(true);
    }
  });

  it("gives Sonnet high effort and every other model medium, in each id form", () => {
    for (const id of Object.values(CLAUDE_SONNET)) {
      expect(claudeDefaultEffort(id)).toBe("high");
    }
    for (const id of Object.values(CLAUDE_OPUS)) {
      expect(claudeDefaultEffort(id)).toBe("medium");
    }
    for (const id of ["claude-haiku-4-5", "anthropic/claude-fable-5", ""]) {
      expect(claudeDefaultEffort(id)).toBe("medium");
    }
  });
});
