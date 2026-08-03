import type { HarnessId } from "@decocms/shared/harness/types";

export type AgentOption =
  | "decopilot"
  | "claude-code-desktop"
  | "codex-desktop"
  | "opencode-desktop";
export type LocalAgentOption = Exclude<AgentOption, "decopilot">;
export type AgentHarnessId = HarnessId | "opencode";
export type LocalHarnessId = Exclude<AgentHarnessId, "decopilot">;

/**
 * Canonical harness for each `AgentOption`. Sandbox selection belongs to the
 * current app surface and persisted thread output, not to this fresh-run
 * choice.
 */
export const AGENT_OPTION_HARNESSES: Record<AgentOption, AgentHarnessId> = {
  decopilot: "decopilot",
  "claude-code-desktop": "claude-code",
  "codex-desktop": "codex",
  "opencode-desktop": "opencode",
};

/**
 * Inverse of `AGENT_OPTION_HARNESSES`. Maps a persisted thread harness back to
 * the canonical `AgentOption`.
 *
 * Returns `null` when the harness does not correspond to any known option (which
 * can happen for legacy or trigger-created rows that wrote a harness without
 * going through this picker).
 */
export function agentOptionFor(harness: string | null): AgentOption | null {
  if (!harness) return null;
  for (const [option, pinnedHarness] of Object.entries(
    AGENT_OPTION_HARNESSES,
  ) as [AgentOption, AgentHarnessId][]) {
    if (pinnedHarness === harness) return option;
  }
  return null;
}

/**
 * Resolve the only agent options a native build may expose.
 *
 * Native has no cloud runtime, so a stale persisted Decopilot pick must never
 * win. A locked local harness also wins by harness alone: early native builds
 * could pin a coding-agent thread before `sandbox_provider_kind` was
 * available, and requiring the full tuple would misclassify that local thread
 * as cloud.
 *
 * Returns null until the user makes an explicit local choice. CLI detection
 * annotates the picker but never chooses an agent on the user's behalf.
 */
export function resolveNativeAgentOption({
  pendingOption,
  lockedHarness,
}: {
  pendingOption: AgentOption | null;
  lockedHarness: string | null;
}): LocalAgentOption | null {
  if (lockedHarness === "claude-code") return "claude-code-desktop";
  if (lockedHarness === "codex") return "codex-desktop";
  if (lockedHarness === "opencode") return "opencode-desktop";
  if (pendingOption === "claude-code-desktop") return pendingOption;
  if (pendingOption === "codex-desktop") return pendingOption;
  if (pendingOption === "opencode-desktop") return pendingOption;
  return null;
}
