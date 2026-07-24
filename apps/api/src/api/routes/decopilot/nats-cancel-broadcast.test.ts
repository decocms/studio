import { describe, it, expect, mock } from "bun:test";
import { sleep } from "@decocms/shared/std";
import { NatsCancelBroadcast } from "./nats-cancel-broadcast";

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
      for (const msg of messages) {
        if (unsubscribed) return;
        yield msg;
      }
    },
  };
}

function createMockNatsConnection(
  sub?: ReturnType<typeof createMockSubscription>,
) {
  const published: Array<{ subject: string; data: Uint8Array }> = [];
  return {
    nc: {
      subscribe: mock(() => sub ?? createMockSubscription()),
      publish(subject: string, data: Uint8Array) {
        published.push({ subject, data });
      },
    } as never,
    published,
  };
}

describe("NatsCancelBroadcast", () => {
  it("start subscribes to cancel subject", async () => {
    const { nc } = createMockNatsConnection();
    const broadcast = new NatsCancelBroadcast({ getConnection: () => nc });

    await broadcast.start(() => {});
    // @ts-expect-error - nc.subscribe is not typed correctly
    expect(nc.subscribe).toHaveBeenCalledTimes(2);
    await broadcast.stop();
  });

  it("broadcast calls local onCancel and publishes to NATS", async () => {
    const { nc, published } = createMockNatsConnection();
    const broadcast = new NatsCancelBroadcast({ getConnection: () => nc });
    const cancelled: string[] = [];

    await broadcast.start((id) => cancelled.push(id));
    broadcast.broadcast("thread-1");

    expect(cancelled).toEqual(["thread-1"]);
    expect(published).toHaveLength(2);
    expect(published.map(({ subject }) => subject)).toEqual([
      "studio.decopilot.cancel",
      "mesh.decopilot.cancel",
    ]);
    const payload = JSON.parse(
      new TextDecoder().decode(published[0]?.data ?? new Uint8Array()),
    );
    expect(payload.taskId).toBe("thread-1");
  });

  it("stop unsubscribes and nulls callback", async () => {
    const sub = createMockSubscription();
    const { nc } = createMockNatsConnection(sub);
    const broadcast = new NatsCancelBroadcast({ getConnection: () => nc });

    await broadcast.start(() => {});
    await broadcast.stop();

    expect(sub.isUnsubscribed).toBe(true);
  });

  it("subscription handler invokes onCancel for valid messages", async () => {
    const encoder = new TextEncoder();
    const msg = { data: encoder.encode(JSON.stringify({ taskId: "t-abc" })) };
    const sub = createMockSubscription([msg]);
    const { nc } = createMockNatsConnection(sub);
    const broadcast = new NatsCancelBroadcast({ getConnection: () => nc });
    const cancelled: string[] = [];

    await broadcast.start((id) => cancelled.push(id));
    // Allow async iteration to process
    await sleep(50);
    await broadcast.stop();

    expect(cancelled).toContain("t-abc");
  });

  it("deduplicates messages received through both compatibility subjects", async () => {
    const encoder = new TextEncoder();
    const msg = {
      data: encoder.encode(
        JSON.stringify({ taskId: "t-abc", messageId: "message-1" }),
      ),
    };
    const sub = createMockSubscription([msg]);
    const { nc } = createMockNatsConnection(sub);
    const broadcast = new NatsCancelBroadcast({ getConnection: () => nc });
    const cancelled: string[] = [];

    await broadcast.start((id) => cancelled.push(id));
    await sleep(50);
    await broadcast.stop();

    expect(cancelled).toEqual(["t-abc"]);
  });

  it("subscription handler ignores malformed messages", async () => {
    const encoder = new TextEncoder();
    const msg = { data: encoder.encode("not json") };
    const sub = createMockSubscription([msg]);
    const { nc } = createMockNatsConnection(sub);
    const broadcast = new NatsCancelBroadcast({ getConnection: () => nc });
    const cancelled: string[] = [];

    await broadcast.start((id) => cancelled.push(id));
    await sleep(50);
    await broadcast.stop();

    expect(cancelled).toHaveLength(0);
  });
});
