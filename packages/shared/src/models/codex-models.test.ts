import { describe, expect, it } from "bun:test";
import { CODEX_MODELS } from "./codex-models.ts";

describe("CODEX_MODELS", () => {
  it("exposes the GPT-5.6 trio in the visible Codex catalog", () => {
    expect(CODEX_MODELS.map((model) => model.modelId)).toEqual([
      "codex:gpt-5.6-sol",
      "codex:gpt-5.6-terra",
      "codex:gpt-5.6-luna",
      "codex:gpt-5.3-codex-spark",
    ]);
  });
});
