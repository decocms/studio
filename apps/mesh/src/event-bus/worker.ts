/**
 * Event Bus Worker
 *
 * Base worker implementation for processing and delivering events.
 * Handles batching events per subscriber and calling ON_EVENTS.
 */

import type { CloudEvent } from "@decocms/bindings";
import { Cron } from "croner";
import type { EventBusStorage, PendingDelivery } from "../storage/event-bus";
import type { Event } from "../storage/types";
import { PermanentDeliveryError } from "./errors";
import {
  DEFAULT_EVENT_BUS_CONFIG,
  type EventBusConfig,
  type NotifySubscriberFn,
} from "./interface";
import { createNotifySubscriber } from "./notify";

/**
 * Convert internal Event to CloudEvent format
 */
function toCloudEvent(event: Event): CloudEvent {
  return {
    specversion: "1.0",
    id: event.id,
    source: event.source,
    type: event.type,
    time: event.time,
    subject: event.subject ?? undefined,
    datacontenttype: event.datacontenttype,
    dataschema: event.dataschema ?? undefined,
    data: event.data ?? undefined,
  };
}

/**
 * Group pending deliveries by connection (not subscription)
 * Deduplicates events by ID to avoid sending the same event multiple times
 * when multiple subscriptions match the same event.
 *
 * Returns a map of connectionId -> { deliveryIds, events }
 */
function groupByConnection(pendingDeliveries: PendingDelivery[]): Map<
  string,
  {
    connectionId: string;
    deliveryIds: string[];
    events: CloudEvent[];
  }
> {
  const grouped = new Map<
    string,
    {
      connectionId: string;
      deliveryIds: string[];
      events: CloudEvent[];
      seenEventIds: Set<string>;
    }
  >();

  for (const pending of pendingDeliveries) {
    // Group by connectionId (not subscription.id)
    const key = pending.subscription.connectionId;
    const existing = grouped.get(key);

    if (existing) {
      // Always track the delivery ID (for marking delivered/failed)
      existing.deliveryIds.push(pending.delivery.id);

      // Only add unique events (deduplicate by event ID)
      if (!existing.seenEventIds.has(pending.event.id)) {
        existing.seenEventIds.add(pending.event.id);
        existing.events.push(toCloudEvent(pending.event));
      }
    } else {
      grouped.set(key, {
        connectionId: pending.subscription.connectionId,
        deliveryIds: [pending.delivery.id],
        events: [toCloudEvent(pending.event)],
        seenEventIds: new Set([pending.event.id]),
      });
    }
  }

  // Return without seenEventIds (internal tracking only)
  const result = new Map<
    string,
    { connectionId: string; deliveryIds: string[]; events: CloudEvent[] }
  >();
  for (const [key, value] of grouped) {
    result.set(key, {
      connectionId: value.connectionId,
      deliveryIds: value.deliveryIds,
      events: value.events,
    });
  }
  return result;
}

/**
 * EventBusWorker handles the background processing of events
 *
 * The worker doesn't manage its own timing - it relies on a NotifyStrategy
 * to trigger processing. This allows:
 * - Polling: Timer-based polling (safety net)
 * - PostgreSQL: Event-based via LISTEN/NOTIFY
 * - NATS: Event-based via NATS pub/sub
 */
export class EventBusWorker {
  private notifySubscriber: NotifySubscriberFn;
  private running = false;
  private processing = false;
  private pendingNotify = false;
  private config: Required<EventBusConfig>;
  private eventTriggerEngine?: {
    notifyEvents(
      events: Array<{
        source: string;
        type: string;
        data: unknown;
        organizationId: string;
      }>,
    ): void;
  };

  constructor(
    private storage: EventBusStorage,
    config?: EventBusConfig,
    notifySubscriberOverride?: NotifySubscriberFn,
  ) {
    this.notifySubscriber =
      notifySubscriberOverride ?? createNotifySubscriber();
    this.config = {
      ...DEFAULT_EVENT_BUS_CONFIG,
      ...config,
    };
  }

  /**
   * Set the event trigger engine for automation firing.
   * Called once during app startup to wire automations into the event bus.
   */
  setEventTriggerEngine(engine: EventBusWorker["eventTriggerEngine"]): void {
    this.eventTriggerEngine = engine;
  }

  /**
   * Start the worker
   * Resets any stuck deliveries from previous crashes and recovers orphaned cron events.
   */
  async start(): Promise<void> {
    if (this.running) return;

    // Reset any deliveries that were stuck in 'processing' state from previous crash
    await this.storage.resetStuckDeliveries();

    // Recover orphaned cron events: "delivered" with no pending future deliveries.
    // This happens when the process crashes between updateEventStatus and
    // scheduleNextCronDelivery, leaving the cron dead with no future runs scheduled.
    const orphanedCrons = await this.storage.findOrphanedCronEvents();
    for (const event of orphanedCrons) {
      await this.scheduleNextCronDelivery(event);
    }

    this.running = true;
  }

  /**
   * Stop the worker
   */
  stop(): void {
    this.running = false;
  }

  /**
   * Check if worker is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Trigger event processing.
   * Called by the NotifyStrategy when events are available.
   *
   * The coalescing loop below means that notifications arriving while we're
   * already processing don't wait for the next poll interval — they get picked
   * up immediately in the next iteration of the do/while loop. Under frequent
   * work this keeps the worker continuously busy instead of idling between
   * polls. Won't scale forever but fine for now.
   */
  async processNow(): Promise<void> {
    if (!this.running) return;

    // Prevent concurrent processing
    if (this.processing) {
      this.pendingNotify = true;
      return;
    }

    this.processing = true;
    try {
      do {
        this.pendingNotify = false;
        await this.processEvents();
      } while (this.pendingNotify);
    } catch (error) {
      console.error("[EventBus] Error processing events:", error);
    } finally {
      this.processing = false;
    }
  }

  /**
   * Process pending events
   */
  private async processEvents(): Promise<void> {
    // Atomically claim pending deliveries
    // This ensures only one worker processes each delivery
    const pendingDeliveries = await this.storage.claimPendingDeliveries(
      this.config.batchSize,
    );
    if (pendingDeliveries.length === 0) return;

    // Group by subscription (connection)
    const grouped = groupByConnection(pendingDeliveries);

    // Process each subscriber's batch in parallel -- deliveries to different
    // connections are independent, so a slow/dead connection doesn't block others.

    interface BatchOutcome {
      eventIds: Set<string>;
      permanentlyFailed: Set<string>;
    }

    const settled = await Promise.allSettled(
      Array.from(grouped.entries()).map(
        async ([subscriptionId, batch]): Promise<BatchOutcome> => {
          const permanentlyFailed = new Set<string>();

          try {
            // Call ON_EVENTS on the subscriber connection
            const result = await this.notifySubscriber(
              batch.connectionId,
              batch.events,
            );

            // Check if per-event results were provided
            if (result.results && Object.keys(result.results).length > 0) {
              // Per-event mode: process each event individually
              await this.processPerEventResults(batch, result);
            } else if (result.success) {
              // Batch mode: mark all deliveries as delivered
              await this.storage.markDeliveriesDelivered(batch.deliveryIds);
            } else if (result.retryAfter && result.retryAfter > 0) {
              // Batch mode: subscriber wants re-delivery after a delay
              await this.storage.scheduleRetryWithoutAttemptIncrement(
                batch.deliveryIds,
                result.retryAfter,
              );
            } else {
              // Batch mode: mark as failed with error and apply exponential backoff
              await this.storage.markDeliveriesFailed(
                batch.deliveryIds,
                result.error || "Subscriber returned success=false",
                this.config.maxAttempts,
                this.config.retryDelayMs,
                this.config.maxDelayMs,
              );
            }
          } catch (error) {
            if (error instanceof PermanentDeliveryError) {
              await this.storage.markDeliveriesPermanentlyFailed(
                batch.deliveryIds,
                error.message,
              );
              for (const event of batch.events) {
                permanentlyFailed.add(event.id);
              }
            } else {
              // Network error or other transient failure
              const errorMessage =
                error instanceof Error ? error.message : String(error);
              console.error(
                `[EventBus] Failed to notify subscription ${subscriptionId}:`,
                errorMessage,
              );
              await this.storage.markDeliveriesFailed(
                batch.deliveryIds,
                errorMessage,
                this.config.maxAttempts,
                this.config.retryDelayMs,
                this.config.maxDelayMs,
              );
            }
          }

          // Collect event IDs touched by this batch
          const eventIds = new Set<string>();
          for (const pending of pendingDeliveries) {
            if (batch.deliveryIds.includes(pending.delivery.id)) {
              eventIds.add(pending.event.id);
            }
          }

          return { eventIds, permanentlyFailed };
        },
      ),
    );

    // Collect results from all settled promises
    const eventIdsToUpdate = new Set<string>();
    const permanentlyFailedEventIds = new Set<string>();
    for (const result of settled) {
      if (result.status === "fulfilled") {
        for (const id of result.value.eventIds) eventIdsToUpdate.add(id);
        for (const id of result.value.permanentlyFailed) {
          permanentlyFailedEventIds.add(id);
        }
      }
    }

    // Update event statuses and handle cron scheduling
    for (const eventId of eventIdsToUpdate) {
      try {
        await this.storage.updateEventStatus(eventId);

        // For cron events, schedule the next delivery after all current deliveries are done
        const event = pendingDeliveries.find(
          (p) => p.event.id === eventId,
        )?.event;
        if (event?.cron && !permanentlyFailedEventIds.has(eventId)) {
          await this.scheduleNextCronDelivery(event);
        }
      } catch (error) {
        console.error(
          `[EventBus] Failed to update event status ${eventId}:`,
          error,
        );
      }
    }

    // Notify the event trigger engine (fire-and-forget) so automations can react.
    // Deduplicate events by ID before notifying.
    if (this.eventTriggerEngine) {
      const seenIds = new Set<string>();
      const uniqueEvents: Array<{
        source: string;
        type: string;
        data: unknown;
        organizationId: string;
      }> = [];

      for (const pending of pendingDeliveries) {
        // Skip retried deliveries to avoid re-triggering automations
        if (pending.delivery.attempts > 0) continue;
        if (!seenIds.has(pending.event.id)) {
          seenIds.add(pending.event.id);
          uniqueEvents.push({
            source: pending.event.source,
            type: pending.event.type,
            data: pending.event.data,
            organizationId: pending.event.organizationId,
          });
        }
      }

      if (uniqueEvents.length > 0) {
        this.eventTriggerEngine.notifyEvents(uniqueEvents);
      }
    }
  }

  /**
   * Process per-event results from ON_EVENTS response.
   * Handles mixed results where some events succeed and others fail or need retry.
   */
  private async processPerEventResults(
    batch: {
      connectionId: string;
      deliveryIds: string[];
      events: CloudEvent[];
    },
    result: {
      success?: boolean;
      error?: string;
      retryAfter?: number;
      results?: Record<
        string,
        { success?: boolean; error?: string; retryAfter?: number }
      >;
    },
  ): Promise<void> {
    const delivered: string[] = [];
    const retryWithDelay: Map<number, string[]> = new Map(); // delay -> deliveryIds
    const failed: { deliveryId: string; error: string }[] = [];

    // Map event IDs to delivery IDs
    const eventToDelivery = new Map<string, string>();
    for (let i = 0; i < batch.events.length; i++) {
      const event = batch.events?.[i];
      if (!event) continue;
      const deliveryId = batch.deliveryIds?.[i];
      if (!deliveryId) continue;
      eventToDelivery.set(event.id, deliveryId);
    }

    // Process each event's result
    for (const event of batch.events) {
      const deliveryId = eventToDelivery.get(event.id);
      if (!deliveryId) continue;

      const eventResult = result.results?.[event.id];

      if (eventResult) {
        // Per-event result provided
        if (eventResult.success) {
          delivered.push(deliveryId);
        } else if (eventResult.retryAfter && eventResult.retryAfter > 0) {
          const existing = retryWithDelay.get(eventResult.retryAfter) || [];
          existing.push(deliveryId);
          retryWithDelay.set(eventResult.retryAfter, existing);
        } else {
          failed.push({
            deliveryId,
            error: eventResult.error || "Event processing failed",
          });
        }
      } else {
        // Fall back to batch-level result
        if (result.success) {
          delivered.push(deliveryId);
        } else if (result.retryAfter && result.retryAfter > 0) {
          const existing = retryWithDelay.get(result.retryAfter) || [];
          existing.push(deliveryId);
          retryWithDelay.set(result.retryAfter, existing);
        } else {
          failed.push({
            deliveryId,
            error: result.error || "Batch processing failed",
          });
        }
      }
    }

    // Apply results
    if (delivered.length > 0) {
      await this.storage.markDeliveriesDelivered(delivered);
    }

    for (const [delay, deliveryIds] of retryWithDelay) {
      await this.storage.scheduleRetryWithoutAttemptIncrement(
        deliveryIds,
        delay,
      );
    }

    if (failed.length > 0) {
      // Group by error message for batch processing
      const errorGroups = new Map<string, string[]>();
      for (const { deliveryId, error } of failed) {
        const existing = errorGroups.get(error) || [];
        existing.push(deliveryId);
        errorGroups.set(error, existing);
      }

      for (const [error, deliveryIds] of errorGroups) {
        await this.storage.markDeliveriesFailed(
          deliveryIds,
          error,
          this.config.maxAttempts,
          this.config.retryDelayMs,
          this.config.maxDelayMs,
        );
      }
    }
  }

  /**
   * Schedule the next delivery for a cron event.
   * Called after all current deliveries are processed.
   */
  private async scheduleNextCronDelivery(event: Event): Promise<void> {
    if (!event.cron) return;

    // Check if the event is still active (not cancelled/failed)
    // We can't query the DB here since we don't have the latest status,
    // but the cron event was just delivered, so it should be active.
    // If it was cancelled, no new deliveries will be created.

    try {
      const cron = new Cron(event.cron, { timezone: "UTC" });
      const nextRun = cron.nextRun();

      if (!nextRun) {
        return;
      }

      const nextDeliveryTime = nextRun.toISOString();

      // Get the subscriptions that match this event
      const subscriptions = await this.storage.getMatchingSubscriptions(event);
      if (subscriptions.length === 0) {
        return;
      }

      // Create new deliveries scheduled for the next cron run
      await this.storage.createDeliveries(
        event.id,
        subscriptions.map((s) => s.id),
        nextDeliveryTime,
      );
    } catch (error) {
      console.error(
        `[EventBus] Failed to schedule next cron delivery for event ${event.id}:`,
        error,
      );
    }
  }
}
