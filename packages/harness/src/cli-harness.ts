import type { HarnessId } from "./types";

/**
 * True for harnesses that run an external CLI subprocess with its own
 * on-disk, resumable session (codex, claude-code). These harnesses receive
 * only the delta + a resume ref per turn instead of the full transcript.
 * `decopilot` runs in-process and keeps the full-transcript dispatch path.
 */
export function isCliHarness(harnessId: HarnessId): boolean {
  return harnessId === "codex" || harnessId === "claude-code";
}
