import type { ChatTier } from "@/tools/organization/schema";
import {
  useAiProviderKeys,
  useAiProviderModels,
} from "@/web/hooks/collections/use-ai-providers";
import { useSimpleMode } from "@/web/hooks/use-organization-settings";
import { pickSimpleModeDefaults } from "@decocms/mesh-sdk";
import { resolveAgentTier } from "@/ai-providers/agent-tiers";
import { useChatPrefs } from "./context";
import type { AgentOption } from "./pills/agent-options";

/**
 * The (location, harness) mode the chat input is bound to. Mutually
 * exclusive — one of these three values is always the answer.
 *
 * Named `AgentMode` (not `ChatMode`) to avoid colliding with
 * `ChatPrefsContextValue.chatMode`, which is a different concept
 * (interaction mode: "default" | ...).
 */
export type AgentMode = "cloud-decopilot" | "local-claude-code" | "local-codex";

const MODE_TO_OPTION: Record<AgentMode, AgentOption> = {
  "cloud-decopilot": "decopilot",
  "local-claude-code": "claude-code-desktop",
  "local-codex": "codex-desktop",
};

const OPTION_TO_MODE: Record<AgentOption, AgentMode> = {
  decopilot: "cloud-decopilot",
  "claude-code-desktop": "local-claude-code",
  "codex-desktop": "local-codex",
};

export function agentOptionFromMode(mode: AgentMode): AgentOption {
  return MODE_TO_OPTION[mode];
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
 * Mirror of server-side `resolveTier` for label-display purposes.
 *
 * - Cloud (Decopilot): reads `org_settings.simple_mode.tiers[tier]`;
 *   falls back to `pickSimpleModeDefaults` over connected providers.
 * - Local (Claude Code / Codex): reads `resolveAgentTier(harness, tier)`
 *   from the server-safe `ai-providers/agent-tiers.ts`.
 *
 * Returns `null` when nothing is resolvable — the popover row stays
 * selectable; server surfaces `TierUnavailableError` at send time.
 */
export function useTierSubtitle(
  mode: AgentMode,
  tier: ChatTier,
): string | null {
  const simple = useSimpleMode();
  const keys = useAiProviderKeys();
  // Pass the active simple-mode slot's keyId for cache reuse; nothing
  // breaks when it's null (returns an empty model list).
  const slotKeyId = simple.tiers[tier]?.keyId;
  const { models: slotModels } = useAiProviderModels(slotKeyId);

  if (mode === "local-claude-code") {
    return resolveAgentTier("claude-code", tier)?.label ?? null;
  }
  if (mode === "local-codex") {
    return resolveAgentTier("codex", tier)?.label ?? null;
  }

  // mode === "cloud-decopilot"
  const slot = simple.tiers[tier];
  if (slot) return slot.title ?? slot.modelId;

  if (keys.length === 0 || !slotKeyId) return null;

  // Mirrors chat-context.tsx's pickFallbackChatModel: restrict to the
  // effective key only, because the client has loaded models for that
  // key alone. Matches the server when the effective key is also the
  // server's tier pick; diverges only when they differ (server wins).
  const effectiveKey = keys.find((k) => k.id === slotKeyId);
  if (!effectiveKey) return null;

  const defaults = pickSimpleModeDefaults(
    [
      {
        id: effectiveKey.id,
        providerId: effectiveKey.providerId,
        label: effectiveKey.label,
        presetId: effectiveKey.presetId,
        createdBy: effectiveKey.createdBy,
        createdAt: effectiveKey.createdAt,
      },
    ],
    { [slotKeyId]: slotModels },
  );
  const pick =
    tier === "fast"
      ? defaults.chat.fast
      : tier === "thinking"
        ? defaults.chat.thinking
        : defaults.chat.smart;
  return pick?.title ?? pick?.modelId ?? null;
}
