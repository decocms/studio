import { telosBus } from "./bus";

// The agent's latest thought for an org — its live reasoning while researching or
// pursuing. Pushed over SSE the instant it's produced, and cached so a reload
// mid-stream still shows the last one (the GET surfaces it). Single-pod cache,
// ephemeral by design: a lost thought only costs a line of trace, never data.
export interface TelosThought {
  text: string;
  phase: "research" | "pursuit";
  version?: number;
}

const latestThought = new Map<string, TelosThought>();

export function getLatestThought(organizationId: string): TelosThought | null {
  return latestThought.get(organizationId) ?? null;
}

// Cache + live-notify in one call. SSE-only (no capability enqueue, no durability).
export function publishThought(
  organizationId: string,
  thought: TelosThought,
): void {
  latestThought.set(organizationId, thought);
  telosBus.notify({ type: "goal.thought", organizationId, ...thought });
}
