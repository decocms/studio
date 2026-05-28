import type { ReactNode } from "react";
import type { HarnessId } from "@/harnesses";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import type { ChatTier } from "@/tools/organization/schema";
import { CLAUDE_CODE_MODELS } from "@/ai-providers/adapters/claude-code-models";
import { CODEX_MODELS } from "@/ai-providers/adapters/codex-models";
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

const CLAUDE_CODE_TIERS: AgentTierMap = {
  fast: {
    modelId: "claude-code:haiku",
    label: "Haiku 4.5",
    description: "Quicker responses",
    iconNode: <ClaudeCodeIcon size={16} />,
  },
  smart: {
    modelId: "claude-code:sonnet",
    label: "Sonnet 4.6",
    description: "Balanced quality",
    iconNode: <ClaudeCodeIcon size={16} />,
  },
  thinking: {
    modelId: "claude-code:opus",
    label: "Opus 4.8",
    description: "Deeper reasoning",
    iconNode: <ClaudeCodeIcon size={16} />,
  },
};

const CODEX_TIERS: AgentTierMap = {
  fast: {
    modelId: "codex:gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Quicker responses",
    iconNode: <CodexIcon size={16} />,
  },
  smart: {
    modelId: "codex:gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Balanced quality",
    iconNode: <CodexIcon size={16} />,
  },
  thinking: {
    modelId: "codex:gpt-5.5",
    label: "GPT-5.5",
    description: "Deeper reasoning",
    iconNode: <CodexIcon size={16} />,
  },
};

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
