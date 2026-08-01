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
  if (harness === "decopilot" && normalizedSandbox === null) {
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
 * Runtime availability of each agent option for the current org/session,
 * derived from the public config (`agentSandbox`) and the user's desktop link.
 * This is advisory UI metadata only: it annotates rows with "not detected" or
 * "connect desktop" hints, but it must not prevent selection or rewrite the
 * runtime sent on submit.
 */
export interface AgentOptionAvailability {
  agentSandbox: boolean;
  userDesktop: boolean;
  claudeCode: boolean;
  codex: boolean;
}

/**
 * The local desktop `AgentOption` to default to for the current availability —
 * Claude Code wins when both CLIs are present. Null when no local CLI is
 * available. One canonical home for the "which local runtime" precedence, so
 * the model-selector runtime toggle and the preview runtime switcher can't
 * drift apart.
 */
export function preferredLocalAgentOption(
  availability: AgentOptionAvailability,
): LocalAgentOption | null {
  if (availability.claudeCode) return "claude-code-desktop";
  if (availability.codex) return "codex-desktop";
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
 * Returns null while CLI detection is still unresolved and there is no prior
 * local choice. The native model selector treats that as local-pending rather
 * than falling back to provider models.
 */
export function resolveNativeAgentOption({
  pendingOption,
  lockedHarness,
  availability,
}: {
  pendingOption: AgentOption | null;
  lockedHarness: HarnessId | null;
  availability: AgentOptionAvailability;
}): LocalAgentOption | null {
  if (lockedHarness === "claude-code") return "claude-code-desktop";
  if (lockedHarness === "codex") return "codex-desktop";
  if (pendingOption === "claude-code-desktop") return pendingOption;
  if (pendingOption === "codex-desktop") return pendingOption;
  return preferredLocalAgentOption(availability);
}

/**
 * Auto-switch a desktop pick to cloud when its link is confirmed offline. A
 * `user-desktop` option can't run anywhere while the link is down and nothing
 * prompts the user to reconnect, so it strands them on an impossible "This
 * device" state. Non-desktop picks (and a live/unknown link) pass through
 * unchanged. `desktopOffline` MUST come from a resolved probe (`link.ready`),
 * never the initial unresolved state — otherwise a genuinely-linked user is
 * briefly demoted on load.
 */
export function resolveOfflineAgentOption(
  option: AgentOption | null,
  desktopOffline: boolean,
): AgentOption | null {
  if (
    desktopOffline &&
    option &&
    AGENT_OPTION_PINS[option].sandbox === "user-desktop"
  ) {
    return "decopilot";
  }
  return option;
}

/** Whether `option` can run given the current `availability`. */
export function agentOptionIsAvailable(
  option: AgentOption,
  availability: AgentOptionAvailability,
): boolean {
  switch (option) {
    case "decopilot":
      return availability.agentSandbox;
    case "claude-code-desktop":
      return availability.userDesktop && availability.claudeCode;
    case "codex-desktop":
      return availability.userDesktop && availability.codex;
  }
}
