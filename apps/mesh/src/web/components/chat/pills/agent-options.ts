import type { HarnessId } from "@/harnesses";
import type { Capability } from "@/links/protocol";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";

export type AgentOption =
  | "decopilot"
  | "decopilot-laptop"
  | "claude-code-laptop"
  | "codex-laptop";

export interface AgentPins {
  harness: HarnessId;
  sandbox: SandboxProviderKind | null;
}

/**
 * Canonical (harness, sandbox) pair for each `AgentOption`. The pill is
 * the source of truth for the user's choice; everything else (chat
 * dispatch, VM start, model selector) reads through here so the pair
 * can't drift.
 */
export const AGENT_OPTION_PINS: Record<AgentOption, AgentPins> = {
  decopilot: { harness: "decopilot", sandbox: null },
  "decopilot-laptop": { harness: "decopilot", sandbox: "remote-user" },
  "claude-code-laptop": { harness: "claude-code", sandbox: "remote-user" },
  "codex-laptop": { harness: "codex", sandbox: "remote-user" },
};

export function pinsForOption(option: AgentOption): AgentPins {
  return AGENT_OPTION_PINS[option];
}

/** Reverse lookup — find the AgentOption matching a persisted
 *  (harness, sandbox) pair (e.g. from a thread row). Returns `null` when
 *  the pair doesn't correspond to any known option. */
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

export interface AgentOptionsInput {
  hasAnyKey: boolean;
  link: { online: boolean; capabilities: readonly Capability[] };
}

const ORDER: AgentOption[] = [
  "decopilot",
  "decopilot-laptop",
  "claude-code-laptop",
  "codex-laptop",
];

/**
 * Pure eligibility function. UI components consume this and render the
 * resulting list. Order is stable so the popover doesn't reshuffle when
 * capabilities flip.
 *
 * The two Decopilot options route through cloud AI providers and need
 * `hasAnyKey`. The two CLI options (Claude Code / Codex desktop) run
 * against the user's local CLI credentials and don't require a cluster
 * provider key — so they surface as soon as the link is online with the
 * matching capability, even on a fresh org with no providers connected.
 *
 * Gates:
 *   decopilot          → hasAnyKey
 *   decopilot-laptop   → hasAnyKey && link.online && caps.includes(decopilot-sandbox)
 *   claude-code-laptop → link.online && caps.includes(claude-code)
 *   codex-laptop       → link.online && caps.includes(codex)
 */
export function computeAgentOptions(input: AgentOptionsInput): AgentOption[] {
  const { hasAnyKey, link } = input;
  const has = (c: Capability) => link.capabilities.includes(c);
  const opts: AgentOption[] = [];
  if (hasAnyKey) opts.push("decopilot");
  if (hasAnyKey && link.online && has("decopilot-sandbox"))
    opts.push("decopilot-laptop");
  if (link.online && has("claude-code")) opts.push("claude-code-laptop");
  if (link.online && has("codex")) opts.push("codex-laptop");
  return opts.sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
}

export const AGENT_OPTION_LABELS: Record<AgentOption, string> = {
  decopilot: "Decopilot",
  "decopilot-laptop": "Decopilot desktop",
  "claude-code-laptop": "Claude Code desktop",
  "codex-laptop": "Codex desktop",
};
