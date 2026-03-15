import { anthropicAdapter } from "./adapters/anthropic";
import { decoAiGatewayAdapter } from "./adapters/deco-ai-gateway";
import { openrouterAdapter } from "./adapters/openrouter";
import type { ProviderId } from "./provider-ids";
import type { ProviderAdapter } from "./types";

/**
 * Claude Code uses the local CLI — no API key or SDK adapter needed.
 * This placeholder satisfies the registry type; the actual chat path
 * bypasses the adapter entirely via the isClaudeCode branch.
 */
const claudeCodeAdapter: ProviderAdapter = {
  info: {
    id: "claude-code",
    name: "Claude Code",
    description: "Local Claude Code CLI",
    logo: "/logos/Claude Code.svg",
  },
  supportedMethods: [],
  create() {
    throw new Error("Claude Code uses the local CLI, not an API adapter");
  },
};

export const PROVIDERS: Record<ProviderId, ProviderAdapter> = {
  deco: decoAiGatewayAdapter,
  openrouter: openrouterAdapter,
  anthropic: anthropicAdapter,
  "claude-code": claudeCodeAdapter,
};
