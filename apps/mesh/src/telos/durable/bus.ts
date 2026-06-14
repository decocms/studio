import { sseHub } from "@/event-bus";
import type { TelosEvent } from "./events";
import { enqueueCapabilities } from "./registry";

// DBOS owns the durable work; the SSE hub owns the live nudge. A missed nudge is
// harmless — the data is already durable, so the client catches up on next fetch.
class DbosTelosBus {
  async publish(event: TelosEvent): Promise<void> {
    await enqueueCapabilities(event);
    this.notify(event);
  }

  // Live SSE nudge with no durable side effects — for ephemeral events (thoughts)
  // that drive no capability and need not survive a restart.
  notify(event: TelosEvent): void {
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
