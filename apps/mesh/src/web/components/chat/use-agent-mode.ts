import type { ChatTier } from "@/tools/organization/schema";
import { resolveAgentTier } from "@/ai-providers/agent-tiers";
import { useChatPrefs } from "./context";
import type { AgentOption } from "./pills/agent-options";

/**
 * The (location, harness) mode the chat input is bound to. Mutually
 * exclusive — one of these values is always the answer.
 *
 * Named `AgentMode` (not `ChatMode`) to avoid colliding with
 * `ChatPrefsContextValue.chatMode`, which is a different concept
 * (interaction mode: "default" | ...).
 */
export type AgentMode =
  | "cloud-decopilot"
  | "local-decopilot"
  | "local-claude-code"
  | "local-codex";

const MODE_TO_OPTION: Record<AgentMode, AgentOption> = {
  "cloud-decopilot": "decopilot",
  "local-decopilot": "decopilot-desktop",
  "local-claude-code": "claude-code-desktop",
  "local-codex": "codex-desktop",
};

const OPTION_TO_MODE: Record<AgentOption, AgentMode> = {
  decopilot: "cloud-decopilot",
  "decopilot-desktop": "local-decopilot",
  "claude-code-desktop": "local-claude-code",
  "codex-desktop": "local-codex",
};

export function agentOptionFromMode(mode: AgentMode): AgentOption {
  return MODE_TO_OPTION[mode];
}

/**
 * Whether a runtime needs a cloud AI provider key to run. Decopilot (cloud or
 * local sandbox) calls models through the org's provider keys, so it can't run
 * without one. Claude Code / Codex bring their own inference, so they never do.
 */
export function agentModeNeedsCloudProvider(mode: AgentMode): boolean {
  return mode === "cloud-decopilot" || mode === "local-decopilot";
}

export function agentModeFromOption(option: AgentOption | null): AgentMode {
  if (option === null) return "cloud-decopilot";
  return OPTION_TO_MODE[option];
}

/** Current agent mode derived from the persisted pending option. */
export function useAgentMode(): AgentMode {
  const { pendingAgentOption } = useChatPrefs();
  return agentModeFromOption(pendingAgentOption);
}

/** Persist a new agent mode (writes through to `pendingAgentOption`). */
export function useSetAgentMode(): (mode: AgentMode) => void {
  const { setPendingAgentOption } = useChatPrefs();
  return (mode: AgentMode) => setPendingAgentOption(agentOptionFromMode(mode));
}

/** Current chat tier from prefs. Defaults to "smart" via prefs. */
export function useChatTier(): ChatTier {
  return useChatPrefs().simpleModeTier;
}

export function useSetChatTier(): (tier: ChatTier) => void {
  return useChatPrefs().setSimpleModeTier;
}

/**
 * User-friendly tier descriptions shown under each tier row in the
 * Decopilot popover. Decopilot users are typically non-technical and
 * benefit from intent labels ("Quicker responses") over model names —
 * the actual model the server picks depends on org settings + provider
 * keys and would be noise here.
 */
const DECOPILOT_TIER_DESCRIPTIONS: Record<ChatTier, string> = {
  fast: "Quicker responses",
  smart: "Balanced quality",
  thinking: "Deeper reasoning",
};

/**
 * Per-tier subtitle shown in the TierTrigger popover. Pure — no React
 * hooks, no async I/O.
 *
 * - Local (Claude Code / Codex): returns the harness-mapped model name
 *   with version (e.g. "Sonnet 5", "GPT-5.5") from
 *   `ai-providers/agent-tiers.ts`. Desktop-CLI users are technical and
 *   want to know which model is about to run.
 * - Decopilot (cloud or local): returns a non-technical intent description
 *   from `DECOPILOT_TIER_DESCRIPTIONS`. The server picks the actual model
 *   via `resolveTier` at send time based on org admin config.
 */
export function resolveTierSubtitle(
  mode: AgentMode,
  tier: ChatTier,
  /** Org `simple_mode.cli` override title for this harness/tier, when set. */
  overrideTitle?: string | null,
): string | null {
  if (mode === "local-claude-code") {
    return (
      overrideTitle ?? resolveAgentTier("claude-code", tier)?.label ?? null
    );
  }
  if (mode === "local-codex") {
    return overrideTitle ?? resolveAgentTier("codex", tier)?.label ?? null;
  }
  return DECOPILOT_TIER_DESCRIPTIONS[tier];
}

/** Maps a chat mode to the CLI harness whose tier overrides apply, or null. */
export function cliHarnessForMode(
  mode: AgentMode,
): "claude-code" | "codex" | null {
  if (mode === "local-claude-code") return "claude-code";
  if (mode === "local-codex") return "codex";
  return null;
}
