/**
 * Event Bus Module
 *
 * Provides a unified event bus for MCP Mesh.
 *
 * Architecture:
 * - EventBus: Single class handling publish/subscribe and worker management
 * - EventBusStorage: Database operations (PostgreSQL via Kysely)
 * - EventBusWorker: Event processing and delivery logic (no internal polling)
 * - NotifyStrategy: NATS notify + polling safety net (polling handles scheduled/cron delivery)
 * - SSEBroadcastStrategy: Cross-pod SSE fan-out via NATS pub/sub
 *
 * Usage:
 * ```ts
 * const eventBus = createEventBus(database, natsProvider, config);
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
 * Create an EventBus instance and start the SSE hub with NATS broadcast.
 *
 * Uses NATS for both notify (immediate wake-up) and SSE broadcast (cross-pod
 * fan-out). A PollingStrategy is always composed alongside NATS as a safety
 * net for scheduled/cron event delivery.
 *
 * @param database - MeshDatabase instance
 * @param natsProvider - Shared NATS connection provider (required)
 * @param config - Optional event bus configuration
 * @returns EventBus instance
 */
export function createEventBus(
  database: MeshDatabase,
  natsProvider: NatsConnectionProvider,
  config?: EventBusConfig,
): EventBus {
  const storage = createEventBusStorage(database.db);
  const pollIntervalMs =
    config?.pollIntervalMs ?? DEFAULT_EVENT_BUS_CONFIG.pollIntervalMs;

  const notifyStrategy = compose(
    new PollingStrategy(pollIntervalMs),
    new NatsNotifyStrategy({
      getConnection: () => natsProvider.getConnection(),
    }),
  );

  const sseBroadcast = new NatsSSEBroadcast({
    getConnection: () => natsProvider.getConnection(),
  });

  sseHub.start(sseBroadcast).catch((err) => {
    console.error("[SSEHub] Failed to start broadcast strategy:", err);
  });

  return new EventBusImpl({
    storage,
    config,
    notifyStrategy,
  });
}
