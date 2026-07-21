import type { ReactNode } from "react";
import type { HarnessId } from "@/harnesses";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import type { ChatTier } from "@/tools/organization/schema";
import { CLAUDE_CODE_MODELS } from "@/ai-providers/adapters/claude-code-models";
import { CODEX_MODELS } from "@/ai-providers/adapters/codex-models";
import { useT } from "@/web/i18n/use-t";
import { ClaudeCodeIcon, CodexIcon } from "../agent-icons";

/**
 * Per-tier entry in an agent section. `modelId` is the wire identifier
 * the harness consumes (or `null` for Decopilot, where the server picks
 * the model based on tier + provider key). `iconNode` is the React icon
 * for Decopilot tiers; CLI rows use `iconUrl` instead.
 */
interface AgentTierEntry {
  modelId: string | null;
  label: string;
  description: string;
  iconNode?: ReactNode;
  iconUrl?: string;
}

type AgentTierMap = Record<ChatTier, AgentTierEntry>;

const CLAUDE_CODE_LOGO =
  "https://decoims.com/decocms/93e4059c-e598-412b-87eb-54d72a946ec8/claude-stroke-rounded.svg";
const CODEX_LOGO =
  "https://decoims.com/decocms/9170ffd4-b9cc-4661-ad8f-ae2eea019e00/codex.svg";

function getClaudeCodeTiers(t: ReturnType<typeof useT>): AgentTierMap {
  return {
    fast: {
      modelId: "claude-code:haiku",
      label: t("chat.agentModels.haikuLabel"),
      description: t("chat.agentModels.quickerResponses"),
      iconNode: <ClaudeCodeIcon size={16} />,
    },
    smart: {
      modelId: "claude-code:sonnet",
      label: t("chat.agentModels.sonnetLabel"),
      description: t("chat.agentModels.balancedQuality"),
      iconNode: <ClaudeCodeIcon size={16} />,
    },
    thinking: {
      modelId: "claude-code:opus-1m",
      label: t("chat.agentModels.opusLabel"),
      description: t("chat.agentModels.deeperReasoning"),
      iconNode: <ClaudeCodeIcon size={16} />,
    },
  };
}

function getCodexTiers(t: ReturnType<typeof useT>): AgentTierMap {
  return {
    fast: {
      modelId: "codex:gpt-5.6-luna",
      label: t("chat.agentModels.gptLunaLabel"),
      description: t("chat.agentModels.quickerResponses"),
      iconNode: <CodexIcon size={16} />,
    },
    smart: {
      modelId: "codex:gpt-5.6-terra",
      label: t("chat.agentModels.gptTerraLabel"),
      description: t("chat.agentModels.balancedQuality"),
      iconNode: <CodexIcon size={16} />,
    },
    thinking: {
      modelId: "codex:gpt-5.6-sol",
      label: t("chat.agentModels.gptSolLabel"),
      description: t("chat.agentModels.deeperReasoning"),
      iconNode: <CodexIcon size={16} />,
    },
  };
}

export interface AgentModelSet {
  logo: string;
  tiers: AgentTierMap;
  models: AiProviderModel[];
}

/**
 * Returns the desktop-CLI model set for an agent, or null for Decopilot
 * (which still uses the standard provider-key path on the settings page).
 * Kept for the settings flow that mounts `DesktopCliModelSelectorBody`.
 */
export function getAgentModelSet(
  agent: HarnessId,
  t: ReturnType<typeof useT>,
): AgentModelSet | null {
  if (agent === "claude-code") {
    return {
      logo: CLAUDE_CODE_LOGO,
      tiers: getClaudeCodeTiers(t),
      models: CLAUDE_CODE_MODELS as AiProviderModel[],
    };
  }
  if (agent === "codex") {
    return {
      logo: CODEX_LOGO,
      tiers: getCodexTiers(t),
      models: CODEX_MODELS as AiProviderModel[],
    };
  }
  return null;
}
