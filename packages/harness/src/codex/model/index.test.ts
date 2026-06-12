import { describe, expect, it } from "bun:test";
import { resolveCodexModelId } from "./index";

describe("resolveCodexModelId", () => {
  it("resolves current Codex CLI model IDs", () => {
    expect(resolveCodexModelId("codex:gpt-5.5")).toBe("gpt-5.5");
    expect(resolveCodexModelId("codex:gpt-5.4")).toBe("gpt-5.4");
    expect(resolveCodexModelId("codex:gpt-5.4-mini")).toBe("gpt-5.4-mini");
    expect(resolveCodexModelId("codex:gpt-5.3-codex-spark")).toBe(
      "gpt-5.3-codex-spark",
    );
  });

  it("rejects removed Codex model IDs", () => {
    expect(() => resolveCodexModelId("codex:gpt-5.3-codex")).toThrow(
      "Unknown Codex model ID",
    );
    expect(() => resolveCodexModelId("codex:gpt-5.2")).toThrow(
      "Unknown Codex model ID",
    );
  });
});
