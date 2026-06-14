import { sseHub } from "@/event-bus";
import type { TelosEvent, TelosEventOf, TelosEventType } from "./events";
import { enqueueCapabilities } from "./registry";

// The durable telos bus. `publish` fans an event across three tiers:
//   1) DURABLE   — enqueue subscribed capabilities (DBOS; crash-safe, OAOO).
//   2) REACTIVE  — cheap synchronous in-process handlers (registered via `on`).
//   3) NOTIFY    — best-effort live push to the org's connected clients (SSE).
//
// Durability and notification stay separate: DBOS owns the work, the SSE hub
// owns the live nudge. A missed nudge is harmless — the data is already durable,
// so the client catches up on its next fetch/reconnect.

type ReactiveHandler = (event: TelosEvent) => void | Promise<void>;

class DbosTelosBus {
  private reactive = new Map<TelosEventType, Set<ReactiveHandler>>();

  /** Register a cheap synchronous reaction. For durable ones use defineCapability. */
  on<K extends TelosEventType>(
    type: K,
    handler: (event: TelosEventOf<K>) => void | Promise<void>,
  ): void {
    const set = this.reactive.get(type) ?? new Set<ReactiveHandler>();
    set.add(handler as ReactiveHandler);
    this.reactive.set(type, set);
  }

  async publish(event: TelosEvent): Promise<void> {
    await enqueueCapabilities(event);
    for (const handler of this.reactive.get(event.type) ?? []) {
      await handler(event);
    }
    this.notify(event);
  }

  private notify(event: TelosEvent): void {
    try {
      sseHub.emit(event.organizationId, {
        id: crypto.randomUUID(),
        type: `telos.${event.type}`,
        source: "telos",
        subject: event.organizationId,
        data: event,
        time: new Date().toISOString(),
      });
    } catch (err) {
      console.warn("[telos] sse notify failed", err);
    }
  }
}

export const telosBus = new DbosTelosBus();
