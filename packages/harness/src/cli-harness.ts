import type { HarnessId } from "./types";

/**
 * Provider name persisted in assistant-message metadata
 * (`codingAgentProvider`) for a CLI harness. Single source of truth for the
 * `HarnessId → provider` map: both the WRITE side (cli stream metadata) and
 * the READ side (`resolveCliSessionRef` / `computeCliDelta`) derive from this,
 * so resume can never silently break on a map mismatch.
 */
export type CliProvider = "claude-code" | "codex";

/**
 * Provider name for a CLI harness, or `undefined` for non-CLI harnesses
 * (`decopilot`, which runs in-process with no resumable on-disk session).
 */
export function cliProviderName(harnessId: HarnessId): CliProvider | undefined {
  if (harnessId === "codex") return "codex";
  if (harnessId === "claude-code") return "claude-code";
  return undefined;
}

/**
 * True for harnesses that run an external CLI subprocess with its own
 * on-disk, resumable session (codex, claude-code). These harnesses receive
 * only the delta + a resume ref per turn instead of the full transcript.
 * `decopilot` runs in-process and keeps the full-transcript dispatch path.
 */
export function isCliHarness(harnessId: HarnessId): boolean {
  return cliProviderName(harnessId) !== undefined;
}
