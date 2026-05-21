import type { HarnessId } from "@/harnesses";
import { CLAUDE_CODE_MODELS } from "@/ai-providers/adapters/claude-code-models";
import { CODEX_MODELS } from "@/ai-providers/adapters/codex-models";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import type { ChatTier } from "@/tools/organization/schema";

/**
 * Per-tier entry in an agent model set. `label` is the short name shown in
 * the chat input's model trigger (e.g. "Haiku", "GPT-5.5"). `modelId` is
 * the wire identifier the harness consumes.
 */
export interface AgentTierEntry {
  modelId: string;
  label: string;
}

/** Tier slots align with `ChatTier` (the fast/smart/thinking subset of
 *  `SimpleModeTier`) so the existing chat-input `simpleModeTier` state
 *  drives both Decopilot and the CLI variants. */
export type AgentTierMap = Record<ChatTier, AgentTierEntry>;

const CLAUDE_CODE_TIERS: AgentTierMap = {
  thinking: { modelId: "claude-code:opus", label: "Opus" },
  smart: { modelId: "claude-code:sonnet", label: "Sonnet" },
  fast: { modelId: "claude-code:haiku", label: "Haiku" },
};

const CODEX_TIERS: AgentTierMap = {
  thinking: { modelId: "codex:gpt-5.5", label: "GPT-5.5" },
  smart: { modelId: "codex:gpt-5.3-codex", label: "GPT-5.3 Codex" },
  fast: { modelId: "codex:gpt-5.4-mini", label: "GPT-5.4 Mini" },
};

const CLAUDE_CODE_LOGO =
  "https://decoims.com/decocms/93e4059c-e598-412b-87eb-54d72a946ec8/claude-stroke-rounded.svg";
const CODEX_LOGO =
  "https://decoims.com/decocms/9170ffd4-b9cc-4661-ad8f-ae2eea019e00/codex.svg";

export interface AgentModelSet {
  logo: string;
  tiers: AgentTierMap;
  models: AiProviderModel[];
}

/**
 * Returns the laptop-CLI model set for an agent, or null for Decopilot
 * (which uses the standard provider-key path).
 */
export function getAgentModelSet(agent: HarnessId): AgentModelSet | null {
  if (agent === "claude-code") {
    return {
      logo: CLAUDE_CODE_LOGO,
      tiers: CLAUDE_CODE_TIERS,
      models: CLAUDE_CODE_MODELS as AiProviderModel[],
    };
  }
  if (agent === "codex") {
    return {
      logo: CODEX_LOGO,
      tiers: CODEX_TIERS,
      models: CODEX_MODELS as AiProviderModel[],
    };
  }
  return null;
}
