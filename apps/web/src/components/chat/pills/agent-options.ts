import type { HarnessId } from "@decocms/shared/harness/types";

export type LocalAgentOption =
  | "claude-code-desktop"
  | "codex-desktop"
  | "opencode-desktop";
export type NativeHarnessId = HarnessId | "opencode";

export const AGENT_OPTION_HARNESSES: Record<LocalAgentOption, NativeHarnessId> =
  {
    "claude-code-desktop": "claude-code",
    "codex-desktop": "codex",
    "opencode-desktop": "opencode",
  };

/** Maps a native thread's locked harness back to its picker option. */
function localAgentOptionFor(harness: string | null): LocalAgentOption | null {
  if (harness === "claude-code") return "claude-code-desktop";
  if (harness === "codex") return "codex-desktop";
  return harness === "opencode" ? "opencode-desktop" : null;
}

/**
 * Resolve the only agent options a native build may expose.
 *
 * Native has no cloud runtime, so a persisted Decopilot pick must never win.
 *
 * Returns null until the user makes an explicit local choice. CLI detection
 * annotates the picker but never chooses an agent on the user's behalf.
 */
export function resolveNativeAgentOption({
  pendingOption,
  lockedHarness,
}: {
  pendingOption: LocalAgentOption | null;
  lockedHarness: string | null;
}): LocalAgentOption | null {
  if (lockedHarness) {
    return localAgentOptionFor(lockedHarness);
  }
  return pendingOption;
}
