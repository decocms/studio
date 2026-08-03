import type { HarnessId } from "@decocms/shared/harness/types";
import {
  normalizeSandboxProviderKind,
  type LegacySandboxProviderKind,
  type SandboxProviderKind,
} from "@/sdk";

export type AgentOption = "decopilot" | "claude-code-desktop" | "codex-desktop";
export type LocalAgentOption = Exclude<AgentOption, "decopilot">;

export interface AgentPins {
  harness: HarnessId;
  sandbox: SandboxProviderKind | null;
}

/**
 * Canonical (harness, sandbox) pair for each `AgentOption`. The persisted
 * pending-agent value is the source of truth; everything else (chat
 * dispatch, VM start, model selector) reads through here so the pair can
 * not drift.
 */
export const AGENT_OPTION_PINS: Record<AgentOption, AgentPins> = {
  decopilot: { harness: "decopilot", sandbox: "agent-sandbox" },
  "claude-code-desktop": { harness: "claude-code", sandbox: "user-desktop" },
  "codex-desktop": { harness: "codex", sandbox: "user-desktop" },
};

/**
 * Inverse of `AGENT_OPTION_PINS`. Maps a (harness, sandbox) tuple — typically
 * sourced from `threads.harness_id` + `threads.sandbox_provider_kind` on a
 * locked thread — back to the canonical `AgentOption`.
 *
 * Returns `null` when the pair does not correspond to any known option (which
 * can happen for legacy or trigger-created rows that wrote a harness without
 * going through this picker).
 */
export function agentOptionFor(
  harness: HarnessId | null,
  sandbox: LegacySandboxProviderKind | null,
): AgentOption | null {
  if (!harness) return null;
  const normalizedSandbox = sandbox
    ? normalizeSandboxProviderKind(sandbox)
    : null;
  if (
    harness === "decopilot" &&
    (normalizedSandbox === null || normalizedSandbox === "user-desktop")
  ) {
    return "decopilot";
  }
  for (const [option, pins] of Object.entries(AGENT_OPTION_PINS) as [
    AgentOption,
    AgentPins,
  ][]) {
    if (pins.harness === harness && pins.sandbox === normalizedSandbox) {
      return option;
    }
  }
  return null;
}

/**
 * Resolve the only agent options a native build may expose.
 *
 * Native has no cloud runtime, so a stale persisted Decopilot pick must never
 * win. A locked local harness also wins by harness alone: early native builds
 * could pin a Claude Code/Codex thread before `sandbox_provider_kind` was
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
  lockedHarness: HarnessId | null;
}): LocalAgentOption | null {
  if (lockedHarness === "claude-code") return "claude-code-desktop";
  if (lockedHarness === "codex") return "codex-desktop";
  if (pendingOption === "claude-code-desktop") return pendingOption;
  if (pendingOption === "codex-desktop") return pendingOption;
  return null;
}
