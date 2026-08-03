import type { ChatTier } from "../organization/schema";
import type { HarnessId } from "./types";

/**
 * Per-agent (CLI harness) tier → model mapping, read by both the cluster's
 * dispatch path (`resolvePerRequestModels`) and the web model picker. The
 * cluster never has an `ai_provider_keys` row for these harnesses —
 * capability and credential live on the user's machine (Tauri app).
 */
export type { ChatTier } from "../organization/schema";
export interface AgentTierEntry {
  modelId: string;
  /** Short label shown in the chat input model trigger ("Haiku"). */
  label: string;
}

export type AgentTierMap = Record<ChatTier, AgentTierEntry>;

const CLAUDE_CODE_TIERS: AgentTierMap = {
  fast: { modelId: "claude-code:haiku", label: "Haiku 4.5" },
  smart: { modelId: "claude-code:sonnet", label: "Sonnet 5" },
  thinking: { modelId: "claude-code:opus-1m", label: "Opus 5 1M" },
};

const CODEX_TIERS: AgentTierMap = {
  fast: { modelId: "codex:gpt-5.6-luna", label: "GPT-5.6 Luna" },
  smart: { modelId: "codex:gpt-5.6-terra", label: "GPT-5.6 Terra" },
  thinking: { modelId: "codex:gpt-5.6-sol", label: "GPT-5.6 Sol" },
};

function getAgentTiers(agent: HarnessId): AgentTierMap | null {
  if (agent === "claude-code") return CLAUDE_CODE_TIERS;
  if (agent === "codex") return CODEX_TIERS;
  return null;
}

/** Returns the model the desktop harness should run for the given tier,
 *  or `null` when the harness is Decopilot (uses the AI provider path). */
export function resolveAgentTier(
  agent: HarnessId,
  tier: ChatTier,
): AgentTierEntry | null {
  return getAgentTiers(agent)?.[tier] ?? null;
}
