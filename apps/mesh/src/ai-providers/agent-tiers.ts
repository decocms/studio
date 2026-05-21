import type { HarnessId } from "../harnesses";
import type { ChatTier } from "@/tools/organization/schema";

/**
 * Per-agent (laptop-CLI harness) tier → model mapping.
 *
 * Lives in the server-safe `ai-providers/` folder so both the cluster's
 * dispatch path (`resolvePerRequestModels`) and the web `agent-models.ts`
 * can read it. The cluster never has an `ai_provider_keys` row for these
 * harnesses — capability and credential live on the user's laptop link.
 */
export interface AgentTierEntry {
  modelId: string;
  /** Short label shown in the chat input model trigger ("Haiku"). */
  label: string;
}

export type AgentTierMap = Record<ChatTier, AgentTierEntry>;

const CLAUDE_CODE_TIERS: AgentTierMap = {
  fast: { modelId: "claude-code:haiku", label: "Haiku" },
  smart: { modelId: "claude-code:sonnet", label: "Sonnet" },
  thinking: { modelId: "claude-code:opus", label: "Opus" },
};

const CODEX_TIERS: AgentTierMap = {
  fast: { modelId: "codex:gpt-5.4-mini", label: "GPT-5.4 Mini" },
  smart: { modelId: "codex:gpt-5.3-codex", label: "GPT-5.3 Codex" },
  thinking: { modelId: "codex:gpt-5.5", label: "GPT-5.5" },
};

function getAgentTiers(agent: HarnessId): AgentTierMap | null {
  if (agent === "claude-code") return CLAUDE_CODE_TIERS;
  if (agent === "codex") return CODEX_TIERS;
  return null;
}

/** Returns the model the laptop harness should run for the given tier,
 *  or `null` when the harness is Decopilot (uses the AI provider path). */
export function resolveAgentTier(
  agent: HarnessId,
  tier: ChatTier,
): AgentTierEntry | null {
  return getAgentTiers(agent)?.[tier] ?? null;
}
