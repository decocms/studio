/**
 * Event Bus Module
 *
 * Provides a unified event bus for MCP Mesh.
 *
 * Architecture:
 * - EventBus: Single class handling publish/subscribe and worker management
 * - EventBusStorage: Database operations (unified for SQLite/PostgreSQL via Kysely)
 * - EventBusWorker: Event processing and delivery logic (no internal polling)
 * - NotifyStrategy: Triggers worker processing (selected via NOTIFY_STRATEGY / NATS_URL env vars)
 *   - nats:     NatsNotifyStrategy + polling safety net
 *   - postgres: PostgresNotifyStrategy (LISTEN/NOTIFY) + polling safety net
 *   - polling:  PollingStrategy only
 *
 * Usage:
 * ```ts
 * const eventBus = createEventBus(database, config);
 * await eventBus.start();
 * ```
 */

import type { MeshDatabase } from "../database";
import { createEventBusStorage } from "../storage/event-bus";
import { EventBus as EventBusImpl } from "./event-bus";
import {
  DEFAULT_EVENT_BUS_CONFIG,
  type EventBus,
  type EventBusConfig,
} from "./interface";
import { NatsNotifyStrategy } from "./nats-notify";
import { compose } from "./notify-strategy";
import { PollingStrategy } from "./polling";
import { PostgresNotifyStrategy } from "./postgres-notify";

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
 * Create an EventBus instance.
 *
 * Notify strategy is selected based on NOTIFY_STRATEGY and NATS_URL env vars.
 * See resolveNotifyStrategy for full selection logic.
 *
 * @param database - MeshDatabase instance (discriminated union)
 * @param config - Optional event bus configuration
 * @returns EventBus instance
 */
export function createEventBus(
  database: MeshDatabase,
  config?: EventBusConfig,
): EventBus {
  const storage = createEventBusStorage(database.db);
  const pollIntervalMs =
    config?.pollIntervalMs ?? DEFAULT_EVENT_BUS_CONFIG.pollIntervalMs;

  const strategyName = resolveNotifyStrategy(database);
  const polling = new PollingStrategy(pollIntervalMs);

  let notifyStrategy;
  switch (strategyName) {
    case "nats": {
      const natsUrl = process.env.NATS_URL;
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
      console.log(`[EventBus] Using NATS notify strategy (${natsHost})`);
      notifyStrategy = compose(
        polling,
        new NatsNotifyStrategy({ servers: natsUrl }),
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

  return new EventBusImpl({
    storage,
    config,
    notifyStrategy,
  });
}
