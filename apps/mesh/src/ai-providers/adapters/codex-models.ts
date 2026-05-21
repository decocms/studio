import type { ModelInfo } from "../types";

/**
 * Browser-safe model list for the Codex laptop harness. Lives apart from
 * `codex.ts` because that file re-exports `createCodexModel` from
 * `../../harnesses/codex`, which transitively pulls Node-only crypto
 * code into any bundle that imports it. The chat model selector only
 * needs the list — never the harness factory — so it imports from here.
 */
const CODEX_LOGO =
  "https://assets.decocache.com/decocms/6ac44f1c-c0cf-4480-84b5-2ae6fe742d0b/codex-app.png.png";

export const CODEX_MODELS: ModelInfo[] = [
  {
    providerId: "codex",
    modelId: "codex:gpt-5.5",
    title: "GPT-5.5",
    description:
      "Frontier model for complex coding, research, and real-world work",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.4",
    title: "GPT-5.4",
    description: "Strong model for everyday coding",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.4-mini",
    title: "GPT-5.4 Mini",
    description:
      "Small, fast, and cost-efficient model for simpler coding tasks",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.3-codex",
    title: "GPT-5.3 Codex",
    description: "Coding-optimized model",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
  {
    providerId: "codex",
    modelId: "codex:gpt-5.2",
    title: "GPT-5.2",
    description: "Optimized for professional work and long-running agents",
    capabilities: ["text", "reasoning"],
    logo: CODEX_LOGO,
    limits: null,
    costs: null,
  },
];
