import type { HarnessId } from "@/harnesses";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

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
  decopilot: { harness: "decopilot", sandbox: null },
  "claude-code-desktop": { harness: "claude-code", sandbox: "desktop" },
  "codex-desktop": { harness: "codex", sandbox: "desktop" },
};
