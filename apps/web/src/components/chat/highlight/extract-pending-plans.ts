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

// The highlight banner only ever shows the most recently proposed plan —
// callers must key off this same plan so a dismiss/expand doesn't get
// reused for a different plan's card once a new one arrives.
export function selectActivePlan(
  plans: PendingPlan[],
): PendingPlan | undefined {
  return plans.at(-1);
}

export function extractPendingPlans(
  parts: ChatMessage["parts"],
): PendingPlan[] {
  const result: PendingPlan[] = [];

  for (const part of parts) {
    if (part.type === "tool-propose_plan" && part.state === "input-available") {
      result.push({
        toolCallId: part.toolCallId,
        plan: part.input.plan,
        state: part.state,
      });
    }
  }

  return result;
}
