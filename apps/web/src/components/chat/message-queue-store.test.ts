import { describe, expect, test } from "bun:test";
import {
  enqueueMessage,
  markQueueDirty,
  isQueueDirty,
  messageQueueStore,
  stashPendingBody,
  takePendingBody,
} from "./message-queue-store";

const item = (messageId: string) => ({
  workflowId: `thread-run:t:${messageId}`,
  messageId,
  status: "queued" as const,
  enqueuedAt: 0,
  text: "hi",
});

describe("messageQueueStore eviction", () => {
  test("evicts the oldest thread once past the tracked cap, dropping its dirty flag and pending body", () => {
    const evictedThreadId = "evict-me";
    messageQueueStore(evictedThreadId);
    markQueueDirty(evictedThreadId);
    stashPendingBody(evictedThreadId, {
      id: "m1",
      role: "user",
      parts: [],
    } as never);
    enqueueMessage(evictedThreadId, item("m1"));

    // Push the tracked-thread count well past the cap so the LRU thread
    // (the one touched first, above) gets evicted.
    for (let i = 0; i < 250; i++) {
      messageQueueStore(`filler-${i}`);
    }

    expect(isQueueDirty(evictedThreadId)).toBe(false);
    expect(takePendingBody(evictedThreadId, "m1")).toBeUndefined();
    // A fresh lookup after eviction starts a clean, empty store.
    expect(messageQueueStore(evictedThreadId).get()).toEqual([]);
  });

  test("a thread touched again mid-session survives eviction over an untouched one", () => {
    const stillActive = "still-active";
    const goesIdle = "goes-idle";
    messageQueueStore(stillActive);
    markQueueDirty(stillActive);
    messageQueueStore(goesIdle);
    markQueueDirty(goesIdle);

    for (let i = 0; i < 250; i++) {
      messageQueueStore(`mid-filler-${i}`);
      if (i === 50) messageQueueStore(stillActive); // re-touch halfway through
    }

    // Re-touched mid-session, so it outlives the never-touched-again thread.
    expect(isQueueDirty(stillActive)).toBe(true);
    expect(isQueueDirty(goesIdle)).toBe(false);
  });
});
