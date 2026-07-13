import { describe, expect, it } from "bun:test";
import { buildCodexDefaultSettings, resolveCodexModelId } from "./index";

describe("resolveCodexModelId", () => {
  it("resolves current Codex CLI model IDs", () => {
    expect(resolveCodexModelId("codex:gpt-5.6-sol")).toBe("gpt-5.6-sol");
    expect(resolveCodexModelId("codex:gpt-5.6-terra")).toBe("gpt-5.6-terra");
    expect(resolveCodexModelId("codex:gpt-5.6-luna")).toBe("gpt-5.6-luna");
    expect(resolveCodexModelId("codex:gpt-5.3-codex-spark")).toBe(
      "gpt-5.3-codex-spark",
    );
  });

  it("keeps previous Codex CLI model IDs resolvable for persisted threads", () => {
    expect(resolveCodexModelId("codex:gpt-5.5")).toBe("gpt-5.5");
    expect(resolveCodexModelId("codex:gpt-5.4")).toBe("gpt-5.4");
    expect(resolveCodexModelId("codex:gpt-5.4-mini")).toBe("gpt-5.4-mini");
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

describe("buildCodexDefaultSettings", () => {
  it("runs Codex without sandbox restrictions", () => {
    expect(buildCodexDefaultSettings({}).sandboxPolicy).toBe(
      "danger-full-access",
    );
  });
});
