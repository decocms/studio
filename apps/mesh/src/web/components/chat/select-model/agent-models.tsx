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

const ClaudeCodeIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M13 12L18.5 5M7.63965 3L12.5 12L13.6865 3M4.48381 6.71679L11.9872 12M3 12L11.9872 12.473M12.2244 13.177L7 20M4.84194 16.8682L11.2824 12.9758M11.5 21L12.665 13.177M21 14L13.1846 12.668M21 10.5788L13 12.3223M16.779 19.646L12.8876 13.3772M19.3566 18.207L13.313 12.9893" />
  </svg>
);

const CodexIcon = ({ size = 16 }: { size?: number }) => (
  <svg
    xmlns="http://www.w3.org/2000/svg"
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="currentColor"
    fillRule="evenodd"
    aria-hidden="true"
  >
    <path
      clipRule="evenodd"
      d="M8.086.457a6.105 6.105 0 013.046-.415c1.333.153 2.521.72 3.564 1.7a.117.117 0 00.107.029c1.408-.346 2.762-.224 4.061.366l.063.03.154.076c1.357.703 2.33 1.77 2.918 3.198.278.679.418 1.388.421 2.126a5.655 5.655 0 01-.18 1.631.167.167 0 00.04.155 5.982 5.982 0 011.578 2.891c.385 1.901-.01 3.615-1.183 5.14l-.182.22a6.063 6.063 0 01-2.934 1.851.162.162 0 00-.108.102c-.255.736-.511 1.364-.987 1.992-1.199 1.582-2.962 2.462-4.948 2.451-1.583-.008-2.986-.587-4.21-1.736a.145.145 0 00-.14-.032c-.518.167-1.04.191-1.604.185a5.924 5.924 0 01-2.595-.622 6.058 6.058 0 01-2.146-1.781c-.203-.269-.404-.522-.551-.821a7.74 7.74 0 01-.495-1.283 6.11 6.11 0 01-.017-3.064.166.166 0 00.008-.074.115.115 0 00-.037-.064 5.958 5.958 0 01-1.38-2.202 5.196 5.196 0 01-.333-1.589 6.915 6.915 0 01.188-2.132c.45-1.484 1.309-2.648 2.577-3.493.282-.188.55-.334.802-.438.286-.12.573-.22.861-.304a.129.129 0 00.087-.087A6.016 6.016 0 015.635 2.31C6.315 1.464 7.132.846 8.086.457zm-.804 7.85a.848.848 0 00-1.473.842l1.694 2.965-1.688 2.848a.849.849 0 001.46.864l1.94-3.272a.849.849 0 00.007-.854l-1.94-3.393zm5.446 6.24a.849.849 0 000 1.695h4.848a.849.849 0 000-1.696h-4.848z"
    />
  </svg>
);

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
    iconNode: <ClaudeCodeIcon size={16} />,
  },
  smart: {
    modelId: "claude-code:sonnet",
    label: "Sonnet",
    description: "Balanced quality",
    iconNode: <ClaudeCodeIcon size={16} />,
  },
  thinking: {
    modelId: "claude-code:opus",
    label: "Opus",
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
