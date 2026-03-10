import { describe, expect, it, mock } from "bun:test";
import type { EventBusStorage, PendingDelivery } from "../storage/event-bus";
import type { Event, EventSubscription } from "../storage/types";
import { PermanentDeliveryError, isAuthError } from "./errors";
import { EventBusWorker } from "./worker";

// ============================================================================
// isAuthError unit tests
// ============================================================================

describe("isAuthError", () => {
  describe("structured error objects", () => {
    it("detects status: 401", () => {
      expect(isAuthError({ status: 401, message: "Unauthorized" })).toBe(true);
    });

    it("detects code: 401", () => {
      expect(isAuthError({ code: 401 })).toBe(true);
    });

    it("ignores non-auth status codes", () => {
      expect(isAuthError({ status: 500, message: "Internal error" })).toBe(
        false,
      );
      expect(isAuthError({ status: 403, message: "Forbidden" })).toBe(false);
    });
  });

  describe("string messages", () => {
    it("detects '401' with word boundary", () => {
      expect(isAuthError("401 Unauthorized")).toBe(true);
      expect(isAuthError("HTTP 401")).toBe(true);
    });

    it("rejects '401' embedded in larger numbers", () => {
      expect(isAuthError("got 14012 items")).toBe(false);
      expect(isAuthError("error code 2401")).toBe(false);
    });

    it("detects 'unauthorized' (case-insensitive)", () => {
      expect(isAuthError("Unauthorized access")).toBe(true);
      expect(isAuthError("UNAUTHORIZED")).toBe(true);
    });

    it("detects 'invalid_token'", () => {
      expect(isAuthError("Error: invalid_token")).toBe(true);
    });

    it("detects 'invalid api key'", () => {
      expect(isAuthError("Invalid API key provided")).toBe(true);
      expect(isAuthError("invalid api key")).toBe(true);
    });

    it("detects 'api key required'", () => {
      expect(isAuthError("API key required")).toBe(true);
    });

    it("detects 'api-key required'", () => {
      expect(isAuthError("api-key required")).toBe(true);
    });

    it("returns false for transient errors", () => {
      expect(isAuthError("connection refused")).toBe(false);
      expect(isAuthError("timeout")).toBe(false);
      expect(isAuthError("Internal server error")).toBe(false);
      expect(isAuthError("ECONNRESET")).toBe(false);
    });
  });

  describe("Error instances", () => {
    it("reads .message from Error objects", () => {
      expect(isAuthError(new Error("401 Unauthorized"))).toBe(true);
      expect(isAuthError(new Error("connection refused"))).toBe(false);
    });
  });

  describe("edge cases", () => {
    it("handles null/undefined/empty", () => {
      expect(isAuthError(null)).toBe(false);
      expect(isAuthError(undefined)).toBe(false);
      expect(isAuthError("")).toBe(false);
      expect(isAuthError(42)).toBe(false);
    });
  });
});

// ============================================================================
// Helpers
// ============================================================================

function makeEvent(id: string, cron?: string): Event {
  return {
    id,
    organizationId: "org1",
    type: "test.event",
    source: "conn_publisher",
    specversion: "1.0",
    subject: null,
    time: new Date().toISOString(),
    datacontenttype: "application/json",
    dataschema: null,
    data: null,
    status: "pending",
    attempts: 0,
    lastError: null,
    nextRetryAt: null,
    cron: cron ?? null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makeSubscription(connectionId: string): EventSubscription {
  return {
    id: `sub_${connectionId}`,
    organizationId: "org1",
    connectionId,
    eventType: "test.event",
    publisher: null,
    filter: null,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

function makePendingDelivery(
  event: Event,
  connectionId: string,
  deliveryId = "delivery1",
): PendingDelivery {
  return {
    delivery: {
      id: deliveryId,
      eventId: event.id,
      subscriptionId: `sub_${connectionId}`,
      status: "processing",
      attempts: 0,
      nextRetryAt: null,
      lastError: null,
      deliveredAt: null,
      createdAt: new Date().toISOString(),
    },
    event,
    subscription: makeSubscription(connectionId),
  };
}

function makeStorage(
  overrides: Partial<EventBusStorage> = {},
): EventBusStorage {
  return {
    claimPendingDeliveries: mock(() => Promise.resolve([])),
    markDeliveriesDelivered: mock(() => Promise.resolve()),
    markDeliveriesFailed: mock(() => Promise.resolve()),
    markDeliveriesPermanentlyFailed: mock(() => Promise.resolve()),
    scheduleRetryWithoutAttemptIncrement: mock(() => Promise.resolve()),
    resetStuckDeliveries: mock(() => Promise.resolve(0)),
    updateEventStatus: mock(() => Promise.resolve()),
    getMatchingSubscriptions: mock(() => Promise.resolve([])),
    createDeliveries: mock(() => Promise.resolve()),
    ...overrides,
  } as unknown as EventBusStorage;
}

// ============================================================================
// Worker tests
// ============================================================================

describe("EventBusWorker", () => {
  describe("auth failure (permanent)", () => {
    it("calls markDeliveriesPermanentlyFailed", async () => {
      const event = makeEvent("evt1");
      const pendingDelivery = makePendingDelivery(event, "conn_subscriber");

      const storage = makeStorage({
        claimPendingDeliveries: mock(() => Promise.resolve([pendingDelivery])),
        updateEventStatus: mock(() => Promise.resolve()),
      });

      const notifySubscriber = mock(() =>
        Promise.reject(new PermanentDeliveryError("401 Unauthorized")),
      );

      const worker = new EventBusWorker(storage, {}, notifySubscriber);
      await worker.start();
      await worker.processNow();

      expect(storage.markDeliveriesPermanentlyFailed).toHaveBeenCalledWith(
        ["delivery1"],
        "401 Unauthorized",
      );
      expect(storage.markDeliveriesFailed).not.toHaveBeenCalled();
    });
  });

  describe("transient failure (returned)", () => {
    it("calls markDeliveriesFailed with default maxAttempts", async () => {
      const event = makeEvent("evt2");
      const pendingDelivery = makePendingDelivery(
        event,
        "conn_subscriber",
        "delivery2",
      );

      const storage = makeStorage({
        claimPendingDeliveries: mock(() => Promise.resolve([pendingDelivery])),
        updateEventStatus: mock(() => Promise.resolve()),
      });

      const notifySubscriber = mock(() =>
        Promise.resolve({
          success: false as const,
          error: "connection refused",
        }),
      );

      const worker = new EventBusWorker(storage, {}, notifySubscriber);
      await worker.start();
      await worker.processNow();

      expect(storage.markDeliveriesFailed).toHaveBeenCalledWith(
        ["delivery2"],
        "connection refused",
        20,
        expect.any(Number),
        expect.any(Number),
      );
      expect(storage.markDeliveriesPermanentlyFailed).not.toHaveBeenCalled();
    });
  });

  describe("transient failure (thrown)", () => {
    it("calls markDeliveriesFailed with default maxAttempts", async () => {
      const event = makeEvent("evt2b");
      const pendingDelivery = makePendingDelivery(
        event,
        "conn_subscriber",
        "delivery2b",
      );

      const storage = makeStorage({
        claimPendingDeliveries: mock(() => Promise.resolve([pendingDelivery])),
        updateEventStatus: mock(() => Promise.resolve()),
      });

      const notifySubscriber = mock(() =>
        Promise.reject(new Error("ECONNRESET")),
      );

      const worker = new EventBusWorker(storage, {}, notifySubscriber);
      await worker.start();
      await worker.processNow();

      expect(storage.markDeliveriesFailed).toHaveBeenCalledWith(
        ["delivery2b"],
        "ECONNRESET",
        20,
        expect.any(Number),
        expect.any(Number),
      );
      expect(storage.markDeliveriesPermanentlyFailed).not.toHaveBeenCalled();
    });
  });

  describe("cron event with auth failure", () => {
    it("does NOT schedule next cron delivery", async () => {
      const event = makeEvent("evt3", "* * * * *");
      const pendingDelivery = makePendingDelivery(
        event,
        "conn_subscriber",
        "delivery3",
      );

      const storage = makeStorage({
        claimPendingDeliveries: mock(() => Promise.resolve([pendingDelivery])),
        updateEventStatus: mock(() => Promise.resolve()),
        getMatchingSubscriptions: mock(() =>
          Promise.resolve([makeSubscription("conn_subscriber")]),
        ),
        createDeliveries: mock(() => Promise.resolve()),
      });

      const notifySubscriber = mock(() =>
        Promise.reject(new PermanentDeliveryError("Invalid API key")),
      );

      const worker = new EventBusWorker(storage, {}, notifySubscriber);
      await worker.start();
      await worker.processNow();

      expect(storage.createDeliveries).not.toHaveBeenCalled();
    });
  });

  describe("cron event with transient failure", () => {
    it("DOES schedule next cron delivery", async () => {
      const event = makeEvent("evt4", "* * * * *");
      const pendingDelivery = makePendingDelivery(
        event,
        "conn_subscriber",
        "delivery4",
      );
      const sub = makeSubscription("conn_subscriber");

      const storage = makeStorage({
        claimPendingDeliveries: mock(() => Promise.resolve([pendingDelivery])),
        updateEventStatus: mock(() => Promise.resolve()),
        getMatchingSubscriptions: mock(() => Promise.resolve([sub])),
        createDeliveries: mock(() => Promise.resolve()),
      });

      const notifySubscriber = mock(() =>
        Promise.resolve({
          success: false as const,
          error: "connection refused",
        }),
      );

      const worker = new EventBusWorker(storage, {}, notifySubscriber);
      await worker.start();
      await worker.processNow();

      expect(storage.createDeliveries).toHaveBeenCalled();
    });
  });

  describe("per-event results path", () => {
    it("is unaffected by permanent delivery errors", async () => {
      const event = makeEvent("evt5");
      const pendingDelivery = makePendingDelivery(
        event,
        "conn_subscriber",
        "delivery5",
      );

      const storage = makeStorage({
        claimPendingDeliveries: mock(() => Promise.resolve([pendingDelivery])),
        updateEventStatus: mock(() => Promise.resolve()),
        markDeliveriesDelivered: mock(() => Promise.resolve()),
      });

      const notifySubscriber = mock(() =>
        Promise.resolve({
          results: {
            evt5: { success: true as const },
          },
        }),
      );

      const worker = new EventBusWorker(storage, {}, notifySubscriber);
      await worker.start();
      await worker.processNow();

      expect(storage.markDeliveriesDelivered).toHaveBeenCalledWith([
        "delivery5",
      ]);
      expect(storage.markDeliveriesFailed).not.toHaveBeenCalled();
      expect(storage.markDeliveriesPermanentlyFailed).not.toHaveBeenCalled();
    });
  });
});
