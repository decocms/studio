import type { ReactNode } from "react";
import type { HarnessId } from "@/harnesses";
import type { Capability } from "@/links/protocol";
import type { AiProviderModel } from "@/web/hooks/collections/use-ai-providers";
import type { ChatTier } from "@/tools/organization/schema";
import { Atom01, Lightning01, Stars01 } from "@untitledui/icons";
import { CLAUDE_CODE_MODELS } from "@/ai-providers/adapters/claude-code-models";
import { CODEX_MODELS } from "@/ai-providers/adapters/codex-models";

/** The three agents that can appear as sections in the chat-input popover. */
export type AgentKind = "decopilot" | "claude-code" | "codex";

/**
 * Per-tier entry in an agent section. `modelId` is the wire identifier
 * the harness consumes (or `null` for Decopilot, where the server picks
 * the model based on tier + provider key). `iconNode` is the React icon
 * for Decopilot tiers; CLI rows use `iconUrl` instead.
 */
export interface AgentTierEntry {
  modelId: string | null;
  label: string;
  description: string;
  iconNode?: ReactNode;
  iconUrl?: string;
}

export type AgentTierMap = Record<ChatTier, AgentTierEntry>;

/** One section in the merged model selector popover. */
export interface AgentSection {
  kind: AgentKind;
  title: string;
  /** True for desktop-CLI agents (Claude Code, Codex). Drives the green
   *  band + " · on desktop" suffix in the popover, and the green
   *  ring on the closed chat-input trigger. */
  isLocal: boolean;
  tiers: AgentTierMap;
  /** Cached list of models the agent exposes — handy for callers that
   *  need to convert a (kind, tier) into an `AiProviderModel`. */
  models: AiProviderModel[];
}

const CLAUDE_CODE_LOGO =
  "https://decoims.com/decocms/93e4059c-e598-412b-87eb-54d72a946ec8/claude-stroke-rounded.svg";
const CODEX_LOGO =
  "https://decoims.com/decocms/9170ffd4-b9cc-4661-ad8f-ae2eea019e00/codex.svg";

const DECOPILOT_TIERS: AgentTierMap = {
  fast: {
    modelId: null,
    label: "Fast",
    description: "Quicker responses",
    iconNode: <Lightning01 size={16} />,
  },
  smart: {
    modelId: null,
    label: "Smart",
    description: "Balanced quality",
    iconNode: <Stars01 size={16} />,
  },
  thinking: {
    modelId: null,
    label: "Thinking",
    description: "Deeper reasoning",
    iconNode: <Atom01 size={16} />,
  },
};

const CLAUDE_CODE_TIERS: AgentTierMap = {
  fast: {
    modelId: "claude-code:haiku",
    label: "Haiku",
    description: "Quicker responses",
    iconUrl: CLAUDE_CODE_LOGO,
  },
  smart: {
    modelId: "claude-code:sonnet",
    label: "Sonnet",
    description: "Balanced quality",
    iconUrl: CLAUDE_CODE_LOGO,
  },
  thinking: {
    modelId: "claude-code:opus",
    label: "Opus",
    description: "Deeper reasoning",
    iconUrl: CLAUDE_CODE_LOGO,
  },
};

const CODEX_TIERS: AgentTierMap = {
  fast: {
    modelId: "codex:gpt-5.4-mini",
    label: "GPT-5.4 Mini",
    description: "Quicker responses",
    iconUrl: CODEX_LOGO,
  },
  smart: {
    modelId: "codex:gpt-5.3-codex",
    label: "GPT-5.3 Codex",
    description: "Balanced quality",
    iconUrl: CODEX_LOGO,
  },
  thinking: {
    modelId: "codex:gpt-5.5",
    label: "GPT-5.5",
    description: "Deeper reasoning",
    iconUrl: CODEX_LOGO,
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

export interface AgentSectionsInput {
  hasAnyKey: boolean;
  link: { online: boolean; capabilities: readonly Capability[] };
}

const SECTION_ORDER: AgentKind[] = ["decopilot", "claude-code", "codex"];

/**
 * Pure eligibility function for the merged chat-input popover. Returns
 * sections in stable `SECTION_ORDER`. Mirrors the gates that
 * `computeAgentOptions` used to enforce, minus `decopilot-desktop`.
 *
 * Gates:
 *   decopilot   → hasAnyKey
 *   claude-code → link.online && caps.includes("claude-code")
 *   codex       → link.online && caps.includes("codex")
 */
export function getAgentSections(input: AgentSectionsInput): AgentSection[] {
  const { hasAnyKey, link } = input;
  const has = (c: Capability) => link.capabilities.includes(c);
  const out: AgentSection[] = [];
  if (hasAnyKey) {
    out.push({
      kind: "decopilot",
      title: "Decopilot",
      isLocal: false,
      tiers: DECOPILOT_TIERS,
      models: [],
    });
  }
  if (link.online && has("claude-code")) {
    out.push({
      kind: "claude-code",
      title: "Claude Code",
      isLocal: true,
      tiers: CLAUDE_CODE_TIERS,
      models: CLAUDE_CODE_MODELS as AiProviderModel[],
    });
  }
  if (link.online && has("codex")) {
    out.push({
      kind: "codex",
      title: "Codex",
      isLocal: true,
      tiers: CODEX_TIERS,
      models: CODEX_MODELS as AiProviderModel[],
    });
  }
  return out.sort(
    (a, b) => SECTION_ORDER.indexOf(a.kind) - SECTION_ORDER.indexOf(b.kind),
  );
}
