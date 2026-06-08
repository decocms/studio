import { describe, expect, it } from "bun:test";
import { CODEX_MODELS } from "./codex-models";

describe("CODEX_MODELS", () => {
  it("matches the current Codex CLI model list", () => {
    expect(
      CODEX_MODELS.map((model) => ({
        id: model.modelId,
        title: model.title,
        description: model.description,
      })),
    ).toEqual([
      {
        id: "codex:gpt-5.5",
        title: "GPT-5.5",
        description:
          "Frontier model for complex coding, research, and real-world work",
      },
      {
        id: "codex:gpt-5.4",
        title: "GPT-5.4",
        description: "Strong model for everyday coding",
      },
      {
        id: "codex:gpt-5.4-mini",
        title: "GPT-5.4 Mini",
        description:
          "Small, fast, and cost-efficient model for simpler coding tasks",
      },
      {
        id: "codex:gpt-5.3-codex-spark",
        title: "GPT-5.3 Codex Spark",
        description: "Ultra-fast coding model",
      },
    ]);
  });
});
