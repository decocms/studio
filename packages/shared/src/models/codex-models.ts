import type { ModelInfo } from "./types.ts";

/**
 * Browser-safe model list for the Codex desktop harness.
 */
const CODEX_LOGO =
  "https://assets.decocache.com/decocms/6ac44f1c-c0cf-4480-84b5-2ae6fe742d0b/codex-app.png.png";

export const CODEX_MODELS: ModelInfo[] = [
  {
    providerId: "codex",
    modelId: "codex:gpt-5.6-sol",
    title: "GPT-5.6 Sol",
    description:
      "Frontier Codex model for deep reasoning, complex coding, and real-world work",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.6-terra",
    title: "GPT-5.6 Terra",
    description: "Balanced Codex model for everyday coding and agent work",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.6-luna",
    title: "GPT-5.6 Luna",
    description: "Fast Codex model for lightweight coding tasks and titles",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.3-codex-spark",
    title: "GPT-5.3 Codex Spark",
    description: "Ultra-fast coding model",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
];
