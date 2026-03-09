/**
 * Event Bus Module
 *
 * Provides a unified event bus for MCP Mesh.
 *
 * Architecture:
 * - EventBus: Single class handling publish/subscribe and worker management
 * - EventBusStorage: Database operations (unified for PGlite/PostgreSQL via Kysely)
 * - EventBusWorker: Event processing and delivery logic (no internal polling)
 * - NotifyStrategy: Triggers worker processing (selected via NOTIFY_STRATEGY / NATS_URL env vars)
 *   - nats:     NatsNotifyStrategy + polling safety net
 *   - postgres: PostgresNotifyStrategy (LISTEN/NOTIFY) + polling safety net
 *   - polling:  PollingStrategy only
 * - SSEBroadcastStrategy: Cross-pod SSE fan-out (selected alongside NotifyStrategy)
 *   - nats:     NatsSSEBroadcast (events replicated via NATS pub/sub)
 *   - default:  LocalSSEBroadcast (in-memory only, single process)
 *
 * Usage:
 * ```ts
 * const eventBus = createEventBus(database, config);
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
import { PostgresNotifyStrategy } from "./postgres-notify";
import { LocalSSEBroadcast } from "./sse-broadcast-strategy";
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
 * Notify strategy selection.
 *
 * Explicit via NOTIFY_STRATEGY env var:
 *   - "nats"     → NatsNotifyStrategy (requires NATS_URL)
 *   - "postgres" → PostgresNotifyStrategy (requires postgres DB)
 *   - "polling"  → PollingStrategy only
 *
 * Auto (NOTIFY_STRATEGY not set):
 *   1. NATS_URL set         → nats
 *   2. Postgres DB          → postgres
 *   3. Otherwise            → polling
 *
 * In all cases except "polling", a PollingStrategy is composed as a safety
 * net to pick up scheduled retries and deliveries that may be missed by the
 * primary pubsub mechanism.
 *
 * SSE broadcast strategy follows the same resolution:
 *   - NATS available → NatsSSEBroadcast (cross-pod fan-out)
 *   - Otherwise      → LocalSSEBroadcast (in-memory only)
 */
type NotifyStrategyName = "nats" | "postgres" | "polling";

function resolveNotifyStrategy(database: MeshDatabase): NotifyStrategyName {
  const explicit = process.env.NOTIFY_STRATEGY as
    | NotifyStrategyName
    | undefined;
  if (
    explicit === "nats" ||
    explicit === "postgres" ||
    explicit === "polling"
  ) {
    return explicit;
  }

  // Auto-detect
  if (process.env.NATS_URL) return "nats";
  if (database.type === "postgres") return "postgres";
  return "polling";
}

/**
 * Create an EventBus instance and start the SSE hub with the appropriate
 * broadcast strategy.
 *
 * Notify strategy and SSE broadcast strategy are selected based on
 * NOTIFY_STRATEGY and NATS_URL env vars.
 * See resolveNotifyStrategy for full selection logic.
 *
 * @param database - MeshDatabase instance (discriminated union)
 * @param config - Optional event bus configuration
 * @param natsProvider - Optional shared NATS connection provider (when using NATS strategies)
 * @returns EventBus instance
 */
export function createEventBus(
  database: MeshDatabase,
  config?: EventBusConfig,
  natsProvider?: NatsConnectionProvider | null,
): EventBus {
  const storage = createEventBusStorage(database.db);
  const pollIntervalMs =
    config?.pollIntervalMs ?? DEFAULT_EVENT_BUS_CONFIG.pollIntervalMs;

  const strategyName = resolveNotifyStrategy(database);
  const polling = new PollingStrategy(pollIntervalMs);
  const natsUrl = process.env.NATS_URL;

  let notifyStrategy;
  switch (strategyName) {
    case "nats": {
      if (!natsUrl) {
        throw new Error(
          "[EventBus] NOTIFY_STRATEGY=nats requires NATS_URL to be set",
        );
      }
      const natsHost = (() => {
        try {
          return new URL(natsUrl).host;
        } catch {
          return "unknown";
        }
      })();
      if (!natsProvider) {
        console.warn(
          `[EventBus] NATS unavailable (${natsHost}), falling back to polling`,
        );
        notifyStrategy = polling;
        break;
      }
      console.log(`[EventBus] Using NATS notify strategy (${natsHost})`);
      notifyStrategy = compose(
        polling,
        new NatsNotifyStrategy({
          getConnection: () => natsProvider!.getConnection(),
        }),
      );
      break;
    }
    case "postgres": {
      if (database.type !== "postgres") {
        console.warn(
          "[EventBus] NOTIFY_STRATEGY=postgres requires a PostgreSQL database, falling back to polling",
        );
        notifyStrategy = polling;
        break;
      }
      console.log("[EventBus] Using PostgreSQL LISTEN/NOTIFY strategy");
      notifyStrategy = compose(
        polling,
        new PostgresNotifyStrategy(database.db, database.pool),
      );
      break;
    }
    case "polling":
    default:
      console.log("[EventBus] Using polling notify strategy");
      notifyStrategy = polling;
  }

  // Start SSE hub with the appropriate broadcast strategy.
  // NATS available → cross-pod fan-out; otherwise → local only.
  const sseBroadcast =
    natsUrl && natsProvider
      ? new NatsSSEBroadcast({
          getConnection: () => natsProvider!.getConnection(),
        })
      : new LocalSSEBroadcast();

  sseHub.start(sseBroadcast).catch((err) => {
    console.error("[SSEHub] Failed to start broadcast strategy:", err);
  });

  if (natsUrl && natsProvider) {
    console.log("[SSEHub] Using NATS SSE broadcast (cross-pod)");
  } else {
    console.log("[SSEHub] Using local SSE broadcast (single-pod)");
  }

  return new EventBusImpl({
    storage,
    config,
    notifyStrategy,
  });
}
