import type { HarnessId } from "@/harnesses";
import {
  normalizeSandboxProviderKind,
  type LegacySandboxProviderKind,
  type SandboxProviderKind,
} from "@decocms/mesh-sdk";

export type AgentOption =
  | "decopilot"
  | "decopilot-desktop"
  | "claude-code-desktop"
  | "codex-desktop";

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
  "decopilot-desktop": { harness: "decopilot", sandbox: "user-desktop" },
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
 * derived from the public config (`agentSandbox`) and the user's desktop link
 * (`userDesktop` + the CLI capabilities it advertises). Shared by the mode
 * picker (which rows to show, which mode to display) and the chat submit path
 * (which (harness, sandbox) pins to dispatch) so the two can never disagree.
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
    case "decopilot-desktop":
      return availability.userDesktop;
    case "claude-code-desktop":
      return availability.userDesktop && availability.claudeCode;
    case "codex-desktop":
      return availability.userDesktop && availability.codex;
  }
}

/**
 * Preference order used when the selected option is unavailable. Cloud
 * Decopilot first — it's the only runtime that doesn't depend on a desktop
 * link — mirroring the row order in the mode picker.
 */
const AGENT_OPTION_FALLBACK_ORDER: AgentOption[] = [
  "decopilot",
  "decopilot-desktop",
  "claude-code-desktop",
  "codex-desktop",
];

/**
 * Resolve the option that will actually run, applying the same availability
 * fallback the picker uses for display. When the persisted pick points to a
 * runtime that isn't currently available — e.g. a "Claude Code desktop" pick
 * carried over from another org while the desktop link is offline — fall back
 * to the first available option instead of silently dispatching to the dead
 * runtime (which 409s with `user_desktop_link_offline`).
 *
 * Returns `null` only when `option` is null (no explicit pick — let the server
 * choose its default) or when nothing is available at all.
 */
export function resolveAvailableAgentOption(
  option: AgentOption | null,
  availability: AgentOptionAvailability,
): AgentOption | null {
  if (option == null) return null;
  if (agentOptionIsAvailable(option, availability)) return option;
  return (
    AGENT_OPTION_FALLBACK_ORDER.find((o) =>
      agentOptionIsAvailable(o, availability),
    ) ?? null
  );
}
