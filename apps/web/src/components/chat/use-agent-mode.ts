import type { ChatTier } from "@decocms/shared/organization/schema";
import { resolveAgentTier } from "@decocms/shared/harness/agent-tiers";
import type { TFunction } from "@/i18n/use-t.ts";
import { useChatPrefs } from "./context";
import type { AgentOption } from "./pills/agent-options";

/**
 * The (location, harness) mode a chat is bound to. Mutually exclusive — one of
 * these values is always the answer. Cloud = the org router; the two `local-*`
 * modes run on the user's linked desktop via that CLI. Derived from the
 * persisted `pendingAgentOption`; the runtime is chosen inside the model
 * selector, not a standalone picker.
 *
 * Named `AgentMode` (not `ChatMode`) to avoid colliding with
 * `ChatPrefsContextValue.chatMode`, which is a different concept
 * (interaction mode: "default" | ...).
 */
export type AgentMode = "cloud-decopilot" | "local-claude-code" | "local-codex";

const OPTION_TO_MODE: Record<AgentOption, AgentMode> = {
  decopilot: "cloud-decopilot",
  "claude-code-desktop": "local-claude-code",
  "codex-desktop": "local-codex",
};

export function agentModeFromOption(option: AgentOption | null): AgentMode {
  if (option === null) return "cloud-decopilot";
  return OPTION_TO_MODE[option];
}

/** Current agent mode derived from the persisted pending option. */
export function useAgentMode(): AgentMode {
  const { pendingAgentOption } = useChatPrefs();
  return agentModeFromOption(pendingAgentOption);
}

/**
 * Whether the chat-input selector must use the fixed local CLI catalogs.
 * Native never exposes cloud/provider models, including while local CLI
 * detection is still pending and the effective option is temporarily null.
 */
export function shouldUseLocalModels(
  mode: AgentMode,
  isDesktopApp: boolean,
): boolean {
  return isDesktopApp || mode !== "cloud-decopilot";
}

/** Current chat tier from prefs. Defaults to "smart" via prefs. */
export function useChatTier(): ChatTier {
  return useChatPrefs().simpleModeTier;
}

export function useSetChatTier(): (tier: ChatTier) => void {
  return useChatPrefs().setSimpleModeTier;
}

/**
 * User-friendly tier descriptions shown under each tier row for the org
 * router (cloud). These users are typically non-technical and benefit from
 * intent labels ("Quicker responses") over model names — the actual model the
 * server picks depends on org settings + provider keys and would be noise
 * here. Reuses the same `chat.agentModels.*` keys the desktop-CLI model
 * picker already translates through, instead of a second hardcoded copy.
 */
const CLOUD_TIER_DESCRIPTION_KEYS: Record<ChatTier, Parameters<TFunction>[0]> =
  {
    fast: "chat.agentModels.quickerResponses",
    smart: "chat.agentModels.balancedQuality",
    thinking: "chat.agentModels.deeperReasoning",
  };

/**
 * Per-tier subtitle shown in the TierTrigger popover.
 *
 * - Local (Claude Code / Codex): returns the harness-mapped model name
 *   with version (e.g. "Sonnet 5", "GPT-5.5") from
 *   `@decocms/shared/harness/agent-tiers`. Desktop-CLI users are technical and
 *   want to know which model is about to run.
 * - Cloud (org router): returns a non-technical intent description via `t`.
 *   The server picks the actual model via `resolveTier` at send time based on
 *   org admin config.
 */
export function resolveTierSubtitle(
  mode: AgentMode,
  tier: ChatTier,
  t: TFunction,
): string | null {
  if (mode === "local-claude-code") {
    return resolveAgentTier("claude-code", tier)?.label ?? null;
  }
  if (mode === "local-codex") {
    return resolveAgentTier("codex", tier)?.label ?? null;
  }
  return t(CLOUD_TIER_DESCRIPTION_KEYS[tier]);
}
