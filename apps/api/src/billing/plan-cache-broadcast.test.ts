import { afterEach, describe, expect, mock, test } from "bun:test";
import { sleep } from "@decocms/shared/std";
import {
  invalidateOrgFeaturesEverywhere,
  startPlanCacheBroadcast,
  stopPlanCacheBroadcast,
} from "./plan-cache-broadcast";

function createMockSubscription(messages: { data: Uint8Array }[] = []) {
  let unsubscribed = false;
  return {
    unsubscribe() {
      unsubscribed = true;
    },
    async *[Symbol.asyncIterator]() {
      for (const message of messages) {
        if (unsubscribed) return;
        yield message;
      }
    },
  };
}

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function createMockNats(subscription = createMockSubscription()) {
  const published: { subject: string; data: Uint8Array }[] = [];
  return {
    connection: {
      subscribe: mock(() => subscription),
      publish(subject: string, data: Uint8Array) {
        published.push({ subject, data });
      },
    } as never,
    published,
  };
}

afterEach(() => stopPlanCacheBroadcast());

describe("invalidateOrgFeaturesEverywhere", () => {
  test("publishes the org to the shared subject", () => {
    const { connection, published } = createMockNats();
    startPlanCacheBroadcast(() => connection);

    invalidateOrgFeaturesEverywhere("org_1");

    expect(published).toHaveLength(1);
    expect(published[0]?.subject).toBe("studio.plans.invalidate");
    const body = JSON.parse(new TextDecoder().decode(published[0]?.data));
    expect(body.organizationId).toBe("org_1");
    expect(typeof body.originId).toBe("string");
  });

  test("a NATS publish that throws does not fail the caller", () => {
    // A plan change must never be rolled back because a cache hint did not go
    // out — the worst case is the 60s TTL this exists to shorten.
    const connection = {
      subscribe: mock(() => createMockSubscription()),
      publish() {
        throw new Error("nats is down");
      },
    } as never;
    startPlanCacheBroadcast(() => connection);

    expect(() => invalidateOrgFeaturesEverywhere("org_1")).not.toThrow();
  });

  test("with no NATS it is local-only and silent", () => {
    startPlanCacheBroadcast(() => null);
    expect(() => invalidateOrgFeaturesEverywhere("org_1")).not.toThrow();
  });
});

describe("startPlanCacheBroadcast", () => {
  test("ignores its OWN messages, so a publisher does not loop on itself", async () => {
    // Round-trip the real origin id: publish once to learn it, then feed that
    // exact message back in. A missing guard makes every pod reprocess its own
    // invalidation, which is harmless here but is the bug that makes an
    // at-least-once fan-out amplify.
    const probe = createMockNats();
    startPlanCacheBroadcast(() => probe.connection);
    invalidateOrgFeaturesEverywhere("org_seed");
    const ownMessage = probe.published[0]?.data;
    stopPlanCacheBroadcast();

    let handled = 0;
    const subscription = createMockSubscription([
      { data: ownMessage as Uint8Array },
    ]);
    const original = subscription[Symbol.asyncIterator].bind(subscription);
    subscription[Symbol.asyncIterator] = async function* () {
      for await (const msg of original()) {
        handled++;
        yield msg;
      }
    };
    const { connection } = createMockNats(subscription);
    startPlanCacheBroadcast(() => connection);
    await sleep(10);

    // The message was delivered to the loop and dropped by the origin guard.
    expect(handled).toBe(1);
  });

  test("a malformed message does not stop the subscription", async () => {
    const subscription = createMockSubscription([
      { data: new TextEncoder().encode("not json") },
      { data: encode({ originId: "other", organizationId: 42 }) },
      { data: encode({ originId: "other", organizationId: "org_2" }) },
    ]);
    const { connection } = createMockNats(subscription);

    // Reaching the third message at all is the assertion: a throw on either of
    // the first two would abort the `for await` and the pod would stop
    // listening for every future invalidation.
    startPlanCacheBroadcast(() => connection);
    await expect(sleep(10)).resolves.toBeUndefined();
  });
});
