export type DomainEvent<T> =
  | { type: "state.changed"; tenant: string }
  | { type: "goal.updated"; tenant: string; target: T }
  | {
      type: "eudaimon.action.applied";
      tenant: string;
      moverVersion: number;
      kind: string;
      payload?: unknown;
    }
  // The Eudaimon's action, forbidden by a Daimonion before it ran (see ../socratic/daimonion).
  | {
      type: "eudaimon.action.vetoed";
      tenant: string;
      moverVersion: number;
      kind: string;
      reason: string;
      payload?: unknown;
    }
  | {
      type: "eudaimon.pursued";
      tenant: string;
      moverVersion: number;
      summary: string;
    }
  | { type: "unmovedMover.reached"; tenant: string; moverVersion: number }
  | {
      type: "eudaimon.goal.proposed";
      tenant: string;
      moverVersion: number;
      target: T;
    }
  | { type: "eudaimon.goal.rejected"; tenant: string; target: T };

export type DomainEventType<T> = DomainEvent<T>["type"];

export type EventHandler<T, K extends DomainEventType<T>> = (
  event: Extract<DomainEvent<T>, { type: K }>,
) => Promise<void>;

export interface EventBus<T> {
  publish(event: DomainEvent<T>): Promise<void>;
  subscribe<K extends DomainEventType<T>>(
    type: K,
    handler: EventHandler<T, K>,
  ): void;
}

// Synchronous, in-order dispatch — stands in for a real broker (Redis/SNS/PubSub).
// A real one is async + at-least-once, so handlers should be idempotent; pursue()
// already is (it re-reads state and stops when satisfied).
export function inMemoryBus<T>(opts: { log?: boolean } = {}): EventBus<T> {
  type AnyHandler = (event: DomainEvent<T>) => Promise<void>;
  const handlers = new Map<DomainEventType<T>, Set<AnyHandler>>();

  return {
    async publish(event) {
      if (opts.log) console.log(`  ▸ ${event.type}`, summarize(event));
      for (const handler of handlers.get(event.type) ?? [])
        await handler(event);
    },
    subscribe<K extends DomainEventType<T>>(
      type: K,
      handler: EventHandler<T, K>,
    ) {
      // The registry is heterogeneous over event types; the per-type handler is
      // widened on the way in, and publish() only ever calls it with its own type.
      const set = handlers.get(type) ?? new Set<AnyHandler>();
      set.add(handler as AnyHandler);
      handlers.set(type, set);
    },
  };
}

function summarize(event: DomainEvent<unknown>): string {
  const { type: _type, ...rest } = event;
  return JSON.stringify(rest);
}
