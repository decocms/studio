import { describe, expect, mock, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import { NatsSSEBroadcast } from "./nats-sse-broadcast";
import type { SSEEvent } from "./sse-hub";

function createMockSubscription(messages: Array<{ data: Uint8Array }> = []) {
  let unsubscribed = false;
  return {
    unsubscribe() {
      unsubscribed = true;
    },
    get isUnsubscribed() {
      return unsubscribed;
    },
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        if (unsubscribed) return;
        yield message;
      }
    },
  };
}

function createMockNatsConnection(subscription = createMockSubscription()) {
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  return {
    connection: {
      subscribe: mock(() => subscription),
      publish(subject: string, data: Uint8Array) {
        published.push({ subject, data });
      },
    } as never,
    published,
    subscription,
  };
}

const event: SSEEvent = {
  id: "event-1",
  type: "example.created",
  source: "test",
  time: "2026-07-23T00:00:00.000Z",
};

describe("NatsSSEBroadcast", () => {
  test("publishes canonical and legacy subjects while emitting locally once", async () => {
    const { connection, published } = createMockNatsConnection();
    const strategy = new NatsSSEBroadcast({
      getConnection: () => connection,
    });
    const emitted: SSEEvent[] = [];

    await strategy.start((_organizationId, received) => emitted.push(received));
    strategy.broadcast("org-1", event);

    expect(emitted).toEqual([event]);
    expect(published.map(({ subject }) => subject)).toEqual([
      "studio.sse.broadcast",
      "mesh.sse.broadcast",
    ]);
    await strategy.stop();
  });

  test("deduplicates a dual-published remote message", async () => {
    const encoded = new TextEncoder().encode(
      JSON.stringify({
        originId: "another-pod",
        messageId: "message-1",
        organizationId: "org-1",
        event,
      }),
    );
    const { connection } = createMockNatsConnection(
      createMockSubscription([{ data: encoded }]),
    );
    const strategy = new NatsSSEBroadcast({
      getConnection: () => connection,
    });
    const emitted: SSEEvent[] = [];

    await strategy.start((_organizationId, received) => emitted.push(received));
    await sleep(50);

    expect(emitted).toEqual([event]);
    await strategy.stop();
  });
});
