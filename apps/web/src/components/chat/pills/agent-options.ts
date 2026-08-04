export type AgentOption =
  | "decopilot"
  | "claude-code-desktop"
  | "codex-desktop"
  | "opencode-desktop";
export type LocalAgentOption = Exclude<AgentOption, "decopilot">;
export type AgentHarnessId = "decopilot" | "claude-code" | "codex" | "opencode";
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
