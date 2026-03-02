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
    parts.push(`${metrics.latencySeconds.toFixed(1)}s`);
  }

  return parts.length > 0 ? parts.join(" · ") : null;
}

/**
 * Convert a tool name to a friendly display name.
 * Converts SCREAMING_SNAKE_CASE or snake_case to Title Case.
 * Edge cases: empty string returns "", single word returns title-cased word.
 */
export function getFriendlyToolName(toolName: string): string {
  if (!toolName) return "";
  return toolName
    .split(/[_-]/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

/**
 * Check if a tool part is awaiting approval and has valid approval data.
 * Returns the approval ID if all conditions are met, otherwise returns null.
 */
export function getApprovalId(part: {
  state: string;
  approval?: { id: string };
}): string | null {
  if (
    part.state === "approval-requested" &&
    "approval" in part &&
    part.approval
  ) {
    return part.approval.id;
  }
  return null;
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
