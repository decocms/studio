import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

export type AgentOption = "decopilot" | "claude-code-laptop" | "codex-laptop";

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
  decopilot: { harness: "decopilot", sandbox: null },
  "claude-code-laptop": { harness: "claude-code", sandbox: "remote-user" },
  "codex-laptop": { harness: "codex", sandbox: "remote-user" },
};

export function pinsForOption(option: AgentOption): AgentPins {
  return AGENT_OPTION_PINS[option];
}

/** Reverse lookup — find the AgentOption matching a persisted
 *  (harness, sandbox) pair. Returns `null` when the pair is unknown. */
export function pinsToOption(
  harness: HarnessId | null,
  sandbox: SandboxProviderKind | null,
): AgentOption | null {
  if (!harness) return null;
  for (const [option, pins] of Object.entries(AGENT_OPTION_PINS) as [
    AgentOption,
    AgentPins,
  ][]) {
    if (pins.harness === harness && pins.sandbox === sandbox) return option;
  }
  return null;
}
