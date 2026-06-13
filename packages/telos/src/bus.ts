import type {
  DomainEvent,
  DomainEventType,
  EventBus,
  EventHandler,
} from "./core";

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
