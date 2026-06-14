// Org-activity signal: a decoupled, in-process pub/sub for "something meaningful
// changed in this org". Producers (a state-mutating tool call, an automation
// firing) emit; consumers (telos pursuit) subscribe. It is deliberately:
//   - generic: producers carry no knowledge of who listens, consumers carry no
//     knowledge of what produced — new producers/consumers compose without edits;
//   - best-effort and lossy: a dropped signal only delays a reaction, never loses
//     data — the consumer re-observes durable state as its source of truth, and a
//     safety-net heartbeat covers anything missed.
// This is NOT the durable event bus (CloudEvents) — it's a lightweight nudge.

export interface OrgActivity {
  organizationId: string;
  /** What produced the signal — for logging/telemetry, never control flow. */
  source: "tool" | "automation" | string;
  /** The tool/automation/event name, when known. */
  name?: string;
}

type Listener = (activity: OrgActivity) => void;

const listeners = new Set<Listener>();

export const orgActivity = {
  // Fire-and-forget: a throwing listener can never break the producer's path.
  emit(activity: OrgActivity): void {
    if (!activity.organizationId) return;
    for (const listener of listeners) {
      try {
        listener(activity);
      } catch (err) {
        console.warn("[activity] listener failed", err);
      }
    }
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
};
