import type { HarnessId } from "@/harnesses";
import {
  normalizeSandboxProviderKind,
  type LegacySandboxProviderKind,
  type SandboxProviderKind,
} from "@decocms/mesh-sdk";

export type AgentOption = "decopilot" | "claude-code-desktop" | "codex-desktop";

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
