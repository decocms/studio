import { formatDuration } from "@/web/lib/format-time.ts";

export type ToolPartStatus =
  | "input-streaming"
  | "input-available"
  | "approval-requested"
  | "approval-responded"
  | "output-available"
  | "output-error"
  | "output-denied";

export interface ToolCallMetrics {
  usage?: { tokens: number; cost?: number };
  latencySeconds?: number;
}

/**
 * Format usage and latency for display.
 * Returns "120 tokens · 0.3s" or "120 tokens · $0.0012", etc.
 * Cost is shown only when cost > 0. Returns null when nothing to display.
 */
export function formatToolMetrics(metrics: ToolCallMetrics): string | null {
  const parts: string[] = [];

  if (metrics.usage?.tokens != null) {
    parts.push(`${metrics.usage.tokens.toLocaleString()} tokens`);
    if (metrics.usage.cost != null && metrics.usage.cost > 0) {
      parts.push(`$${metrics.usage.cost.toFixed(4)}`);
    }
  }

  if (metrics.latencySeconds != null) {
    parts.push(formatDuration(metrics.latencySeconds));
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Convert a name to Title Case: replaces `_` and `-` with spaces, lowercases,
 * then capitalizes each word.
 */
export function toTitleCase(name: string): string {
  if (!name) return "";
  return name
    .replace(/[_-]/g, " ")
    .toLowerCase()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Derive the effective UI state for a tool call part.
 * Returns "error", "loading", "approval", or "idle" based on the tool state.
 *
 * @param state - The current state of the tool part
 * @param preliminary - Optional flag indicating streaming output (for subtasks)
 * @returns The effective UI state for display
 */
export function getEffectiveState(
  state: string,
  preliminary?: boolean,
): "loading" | "error" | "idle" | "approval" {
  // Error state takes precedence
  if (state === "output-error") {
    return "error";
  }

  // Approval state — distinct from loading (no shimmer, user action required)
  if (state === "approval-requested") {
    return "approval";
  }

  // Loading states: input generation or streaming output
  if (
    state === "input-streaming" ||
    state === "input-available" ||
    (state === "output-available" && preliminary === true)
  ) {
    return "loading";
  }

  // Default to idle
  return "idle";
}
