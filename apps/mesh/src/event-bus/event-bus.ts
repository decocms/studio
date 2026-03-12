/**
 * Event Bus Implementation
 *
 * Single, unified EventBus class that handles:
 * - Publishing events
 * - Managing subscriptions
 * - Background event delivery via EventBusWorker
 * - Optional immediate notification via NotifyStrategy
 *
 * Architecture:
 * - EventBusStorage: Database operations (unified for PGlite/PostgreSQL via Kysely)
 * - EventBusWorker: Polling and delivery logic
 * - NotifyStrategy: Optional - wakes up worker immediately (e.g., PostgreSQL LISTEN/NOTIFY)
 */

import { Cron } from "croner";
import type {
  EventBusStorage,
  SyncSubscriptionsInput,
  SyncSubscriptionsResult,
} from "../storage/event-bus";
import type { Event, EventSubscription } from "../storage/types";
import type {
  EventBusConfig,
  IEventBus,
  PublishEventInput,
  SubscribeInput,
} from "./interface";
import type { NotifyStrategy } from "./notify-strategy";
import { sseHub, toSSEEvent } from "./sse-hub";
import { EventBusWorker } from "./worker";

/**
 * Configuration for creating an EventBus instance
 */
export interface EventBusOptions {
  /** Database storage operations */
  storage: EventBusStorage;
  /** Optional event bus configuration */
  config?: EventBusConfig;
  /** Optional notify strategy for immediate wake-up (e.g., PostgreSQL LISTEN/NOTIFY) */
  notifyStrategy?: NotifyStrategy;
}

/**
 * Unified EventBus implementation
 *
 * Works with any database (PGlite, PostgreSQL) via EventBusStorage.
 * Supports optional immediate notification via NotifyStrategy.
 */
export class EventBus implements IEventBus {
  private storage: EventBusStorage;
  private worker: EventBusWorker;
  private notifyStrategy?: NotifyStrategy;
  private running = false;

  constructor(options: EventBusOptions) {
    this.storage = options.storage;
    this.notifyStrategy = options.notifyStrategy;
    this.worker = new EventBusWorker(this.storage, options.config);
  }

  /**
   * Set the event trigger engine on the underlying worker.
   * Allows automations to react to processed events.
   */
  setEventTriggerEngine(
    engine: Parameters<EventBusWorker["setEventTriggerEngine"]>[0],
  ): void {
    this.worker.setEventTriggerEngine(engine);
  }

  async publish(
    organizationId: string,
    sourceConnectionId: string,
    input: PublishEventInput,
  ): Promise<Event> {
    // Validate that deliverAt and cron aren't both set
    if (input.deliverAt && input.cron) {
      throw new Error(
        "Cannot set both deliverAt and cron. Use one or the other.",
      );
    }

    // Validate cron expression if provided
    let firstDeliveryTime: string | undefined;
    if (input.cron) {
      try {
        const cron = new Cron(input.cron);
        const nextRun = cron.nextRun();
        if (!nextRun) {
          throw new Error("Cron expression does not produce a next run time");
        }
        firstDeliveryTime = nextRun.toISOString();
      } catch (error) {
        throw new Error(
          `Invalid cron expression: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      // Idempotent cron publishing: check if an active cron event already exists
      const existingCron = await this.storage.findActiveCronEvent(
        organizationId,
        input.type,
        sourceConnectionId,
        input.cron,
      );

      if (existingCron) {
        // Return existing cron event - idempotent
        return existingCron;
      }
    }

    const eventId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Create the event in the database
    const event = await this.storage.publishEvent({
      id: eventId,
      organizationId,
      type: input.type,
      source: sourceConnectionId,
      subject: input.subject,
      time: now,
      data: input.data,
      cron: input.cron,
    });

    // Fan out to SSE /watch connections (non-blocking, best-effort)
    sseHub.emit(organizationId, toSSEEvent(event));

    // Find matching subscriptions and create delivery records
    const subscriptions = await this.storage.getMatchingSubscriptions(event);
    if (subscriptions.length > 0) {
      // Determine when to deliver:
      // - deliverAt: use specified time
      // - cron: use calculated first delivery time
      // - neither: immediate delivery (undefined)
      const deliverAt = input.deliverAt ?? firstDeliveryTime;

      await this.storage.createDeliveries(
        eventId,
        subscriptions.map((s) => s.id),
        deliverAt,
      );

      // Only notify strategy for immediate delivery (no scheduled time and no cron)
      // Scheduled events will be picked up by the polling worker at the right time
      if (this.notifyStrategy && !deliverAt) {
        await this.notifyStrategy.notify(eventId).catch((error) => {
          console.warn("[EventBus] Notify failed (non-critical):", error);
        });
      }
    }

    return event;
  }

  async subscribe(
    organizationId: string,
    input: SubscribeInput,
  ): Promise<EventSubscription> {
    return this.storage.subscribe({
      id: crypto.randomUUID(),
      organizationId,
      connectionId: input.connectionId,
      publisher: input.publisher,
      eventType: input.eventType,
      filter: input.filter,
    });
  }

  async unsubscribe(
    organizationId: string,
    subscriptionId: string,
  ): Promise<{ success: boolean }> {
    return this.storage.unsubscribe(subscriptionId, organizationId);
  }

  async listSubscriptions(
    organizationId: string,
    connectionId?: string,
  ): Promise<EventSubscription[]> {
    return this.storage.listSubscriptions(organizationId, connectionId);
  }

  async getSubscription(
    organizationId: string,
    subscriptionId: string,
  ): Promise<EventSubscription | null> {
    return this.storage.getSubscription(subscriptionId, organizationId);
  }

  async getEvent(
    organizationId: string,
    eventId: string,
  ): Promise<Event | null> {
    return this.storage.getEvent(eventId, organizationId);
  }

  async cancelEvent(
    organizationId: string,
    eventId: string,
    sourceConnectionId: string,
  ): Promise<{ success: boolean }> {
    return this.storage.cancelEvent(
      eventId,
      organizationId,
      sourceConnectionId,
    );
  }

  async ackEvent(
    organizationId: string,
    eventId: string,
    connectionId: string,
  ): Promise<{ success: boolean }> {
    return this.storage.ackDelivery(eventId, organizationId, connectionId);
  }

  async syncSubscriptions(
    organizationId: string,
    input: Omit<SyncSubscriptionsInput, "organizationId">,
  ): Promise<SyncSubscriptionsResult> {
    return this.storage.syncSubscriptions({
      organizationId,
      ...input,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start the worker (resets stuck deliveries from previous crashes)
    await this.worker.start();

    // Start notify strategy if available
    // Use compose() to combine multiple strategies (e.g., polling + postgres notify)
    if (this.notifyStrategy) {
      await this.notifyStrategy.start(() => {
        // When notified, trigger immediate processing
        this.worker.processNow().catch((error) => {
          console.error("[EventBus] Error processing after notify:", error);
        });
      });
    }

    // Process any pending events from before startup
    // This ensures we don't wait for new events to trigger processing
    await this.worker.processNow().catch((error) => {
      console.error(
        "[EventBus] Error processing pending events on startup:",
        error,
      );
    });
  }

  async stop(): Promise<void> {
    if (!this.running) return;

    this.running = false;
    this.worker.stop();

    // Stop notify strategy if available
    if (this.notifyStrategy) {
      try {
        await this.notifyStrategy.stop();
      } catch (error) {
        console.error("[EventBus] Error stopping notify strategy:", error);
      }
    }

    console.log("[EventBus] Stopped");
  }

  isRunning(): boolean {
    return this.running;
  }
}
