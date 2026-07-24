import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createSSESubscription } from "./create-sse-subscription";

class FakeEventSource {
  static CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readyState = 0;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(public url: string) {
    FakeEventSource.instances.push(this);
  }
  addEventListener(): void {}
  close(): void {}
}

describe("createSSESubscription", () => {
  const originalEventSource = globalThis.EventSource;

  beforeEach(() => {
    FakeEventSource.instances = [];
    (globalThis as unknown as { EventSource: unknown }).EventSource =
      FakeEventSource;
  });

  afterEach(() => {
    (globalThis as unknown as { EventSource: unknown }).EventSource =
      originalEventSource;
  });

  it("opens an EventSource for the first subscriber on a key without crossTab", () => {
    // Regression: leadership used to be requested before refCount was
    // incremented, so the synchronous (non-crossTab) leader path always saw
    // refCount === 0 and bailed out — no EventSource was ever created.
    const sub = createSSESubscription({
      buildUrl: (key) => `/watch/${key}`,
      eventTypes: ["foo"],
    });

    const unsubscribe = sub.subscribe("org1", () => {});

    expect(FakeEventSource.instances.length).toBe(1);
    expect(FakeEventSource.instances[0]?.url).toBe("/watch/org1");

    unsubscribe();
  });
});
