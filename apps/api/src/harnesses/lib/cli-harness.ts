import type { HarnessId } from "./types";

/**
 * Provider name persisted in assistant-message metadata
 * (`codingAgentProvider`) for a CLI harness. The READ side
 * (`resolveCliSessionRef` / `computeCliDelta`) derives from this map.
 *
 * The WRITE side is no longer here: CLI runs happen in the Tauri app, and
 * `apps/native/crates/harness` stamps this metadata in Rust. This map and
 * that crate must agree — a mismatch silently breaks session resume.
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
