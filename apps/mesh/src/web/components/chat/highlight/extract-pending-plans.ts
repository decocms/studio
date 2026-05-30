/**
 * Pure extraction helper for pending propose_plan parts from assistant messages.
 *
 * Extracted as a pure .ts module so it can be imported by bun:test code
 * without dragging in @deco/ui transitively via propose-plan.tsx.
 */

import type { ChatMessage } from "../types.ts";

// ============================================================================
// Types
// ============================================================================

export interface PendingPlan {
  toolCallId: string;
  plan: string;
  state: string;
}

// ============================================================================
// Utility: extract pending propose_plan parts from message
// ============================================================================

export function extractPendingPlans(
  parts: ChatMessage["parts"],
): PendingPlan[] {
  const result: PendingPlan[] = [];

  for (const part of parts) {
    if (
      "type" in part &&
      (part as { type: string }).type === "tool-propose_plan" &&
      "state" in part &&
      (part as { state: string }).state === "input-available" &&
      "toolCallId" in part &&
      "input" in part
    ) {
      const input = (part as { input: { plan: string } }).input;
      result.push({
        toolCallId: (part as { toolCallId: string }).toolCallId,
        plan: input.plan,
        state: (part as { state: string }).state,
      });
    }
  }

  return result;
}
