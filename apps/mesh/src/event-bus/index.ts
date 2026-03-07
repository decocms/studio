/**
 * Event Bus Module
 *
 * Provides a unified event bus for MCP Mesh.
 *
 * Architecture:
 * - EventBus: Single class handling publish/subscribe and worker management
 * - EventBusStorage: Database operations (unified for PGlite/PostgreSQL via Kysely)
 * - EventBusWorker: Event processing and delivery logic (no internal polling)
 * - NotifyStrategy: NATS for immediate notifications, polling timer as safety net
 * - SSEBroadcastStrategy: NatsSSEBroadcast (cross-pod fan-out via NATS pub/sub)
 *
 * Usage:
 * ```ts
 * const eventBus = createEventBus(database, config, natsProvider);
 * await eventBus.start();
 * ```
 */

import type { NatsConnectionProvider } from "../nats/connection";
import type { MeshDatabase } from "../database";
import { createEventBusStorage } from "../storage/event-bus";
import { EventBus as EventBusImpl } from "./event-bus";
import {
  DEFAULT_EVENT_BUS_CONFIG,
  type EventBus,
  type EventBusConfig,
} from "./interface";
import { NatsNotifyStrategy } from "./nats-notify";
import { NatsSSEBroadcast } from "./nats-sse-broadcast";
import { compose } from "./notify-strategy";
import { PollingStrategy } from "./polling";
import { sseHub } from "./sse-hub";

// Re-export types and interfaces
export {
  type EventBusConfig,
  type IEventBus,
  type NotifySubscriberFn,
  type PublishEventInput,
  type SubscribeInput,
} from "./interface";

// Re-export storage types used in the interface
export type {
  SyncSubscriptionsInput,
  SyncSubscriptionsResult,
} from "../storage/event-bus";

// Export EventBus type alias (for typing in tests/consumers)
export type { EventBus } from "./interface";

export type { NotifyStrategy } from "./notify-strategy";

export { sseHub, type SSEEvent } from "./sse-hub";

/**
 * Create an EventBus instance with NATS notify strategy and SSE broadcast.
 *
 * NATS is mandatory. A polling timer runs alongside as a safety net
 * for scheduled retries and edge cases.
 */
export function createEventBus(
  database: MeshDatabase,
  config: EventBusConfig | undefined,
  natsProvider: NatsConnectionProvider,
): EventBus {
  const storage = createEventBusStorage(database.db);
  const pollIntervalMs =
    config?.pollIntervalMs ?? DEFAULT_EVENT_BUS_CONFIG.pollIntervalMs;

  // NATS for immediate notifications, polling as timer-only safety net
  const notifyStrategy = compose(
    new PollingStrategy(pollIntervalMs),
    new NatsNotifyStrategy({
      getConnection: () => natsProvider.getConnection(),
    }),
  );

  // SSE broadcast — always NATS
  const sseBroadcast = new NatsSSEBroadcast({
    getConnection: () => natsProvider.getConnection(),
  });

  sseHub.start(sseBroadcast).catch((err) => {
    console.error("[SSEHub] Failed to start broadcast strategy:", err);
  });

  console.log("[EventBus] Using NATS notify strategy");
  console.log("[SSEHub] Using NATS SSE broadcast");

  return new EventBusImpl({
    storage,
    config,
    notifyStrategy,
  });
}
