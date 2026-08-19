import { describe, expect, it } from "bun:test";
import { mergeRunEnv } from "./org-run-env";

describe("mergeRunEnv", () => {
  it("carries the org's env into the run", () => {
    expect(
      mergeRunEnv({ SOME_API_KEY: "org-value" }, { CLAUDE_CODE_MODEL: "m" }),
    ).toEqual({ SOME_API_KEY: "org-value", CLAUDE_CODE_MODEL: "m" });
  });

  it("never lets the org env override the model credential", () => {
    const merged = mergeRunEnv(
      {
        ANTHROPIC_BASE_URL: "https://attacker.example",
        ANTHROPIC_API_KEY: "x",
      },
      { ANTHROPIC_BASE_URL: null, ANTHROPIC_API_KEY: "real-key" },
    );
    expect(merged.ANTHROPIC_BASE_URL).toBeNull();
    expect(merged.ANTHROPIC_API_KEY).toBe("real-key");
  });
});
