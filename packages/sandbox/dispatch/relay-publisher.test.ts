import { describe, expect, test } from "bun:test";
import type { JetStreamClient } from "@nats-io/jetstream";
import {
  createDirectNatsPublisher,
  publishRelayBodyToNats,
} from "./relay-publisher";

type PublishRecord = { subject: string; payload: unknown; msgID?: string };

function makeFakeJs(): {
  js: Pick<JetStreamClient, "publish">;
  published: PublishRecord[];
} {
  const published: PublishRecord[] = [];
  const js = {
    publish: async (
      subject: string,
      data: Uint8Array,
      opts?: { msgID?: string },
    ) => {
      published.push({
        subject,
        payload: JSON.parse(new TextDecoder().decode(data)),
        msgID: opts?.msgID,
      });
      return {} as never;
    },
  } as Pick<JetStreamClient, "publish">;
  return { js, published };
}

describe("createDirectNatsPublisher", () => {
  test("publishes relay chunks and done marker with deterministic msg ids", async () => {
    const { js, published } = makeFakeJs();

    const publisher = createDirectNatsPublisher({ js });
    await publisher.publishLine({
      runId: "run_1",
      fenceToken: "fence_1",
      line: {
        seq: 1,
        event: {
          type: "ui-message-chunk",
          chunk: { type: "text-delta", id: "1", delta: "hi" },
        },
      },
    });
    await publisher.publishDone({
      runId: "run_1",
      fenceToken: "fence_1",
      finalSeq: 1,
    });

    expect(published).toEqual([
      {
        subject: "decopilot.stream.run_1",
        payload: { p: { type: "text-delta", id: "1", delta: "hi" } },
        msgID: "run_1:fence_1:1",
      },
      {
        subject: "decopilot.stream.run_1",
        payload: { done: true, finalSeq: 1 },
        msgID: "run_1:fence_1:done:1",
      },
    ]);
  });

  test("publishLine converts an error event into an error chunk envelope and returns 'published'", async () => {
    const { js, published } = makeFakeJs();

    const publisher = createDirectNatsPublisher({ js });
    const result = await publisher.publishLine({
      runId: "run_1",
      fenceToken: "fence_1",
      line: {
        seq: 3,
        event: { type: "error", code: "code", message: "message" },
      },
    });

    expect(result).toBe("published");
    expect(published).toEqual([
      {
        subject: "decopilot.stream.run_1",
        payload: { p: { type: "error", errorText: "code: message" } },
        msgID: "run_1:fence_1:3",
      },
    ]);
  });

  test("publishLine returns 'terminal' for a done event (no publish)", async () => {
    const { js, published } = makeFakeJs();

    const publisher = createDirectNatsPublisher({ js });
    const result = await publisher.publishLine({
      runId: "run_1",
      fenceToken: "fence_1",
      line: { seq: 5, event: { type: "done" } },
    });

    expect(result).toBe("terminal");
    expect(published).toEqual([]);
  });
});

test("publishRelayBodyToNats flushes onPublished at terminal (drives outbox truncation)", async () => {
  const published: number[] = [];
  const publisher = {
    publishLine: async ({ line }: { line: { event: { type: string } } }) =>
      line.event.type === "ui-message-chunk"
        ? ("published" as const)
        : ("terminal" as const),
    publishDone: async () => {},
  };
  const chunk = (seq: number) =>
    JSON.stringify({
      seq,
      event: {
        type: "ui-message-chunk",
        chunk: { type: "text-delta", id: "1", delta: "x" },
      },
    });
  const body = `${chunk(1)}\n${chunk(2)}\n${JSON.stringify({ seq: 3, event: { type: "done" } })}\n`;
  await publishRelayBodyToNats({
    body,
    runId: "run_1",
    fenceToken: "fence_1",
    publisher,
    onPublished: (seq) => published.push(seq),
  });
  // The terminal flush reports the durable high-water mark once so the relay
  // can drop the confirmed prefix from the outbox.
  expect(published).toEqual([2]);
});

describe("publishRelayBodyToNats", () => {
  test("processes string NDJSON body with chunk, heartbeat, and done", async () => {
    const { js, published } = makeFakeJs();
    const publisher = createDirectNatsPublisher({ js });

    const body = [
      JSON.stringify({
        seq: 1,
        event: {
          type: "ui-message-chunk",
          chunk: { type: "text-delta", id: "1", delta: "hi" },
        },
      }),
      "", // blank heartbeat line
      JSON.stringify({ seq: 2, event: { type: "done" } }),
    ].join("\n");

    const result = await publishRelayBodyToNats({
      body,
      runId: "run_1",
      fenceToken: "fence_1",
      publisher,
    });

    expect(result).toEqual({ lastSeq: 2 });
    expect(published).toEqual([
      {
        subject: "decopilot.stream.run_1",
        payload: {
          p: { type: "text-delta", id: "1", delta: "hi" },
        },
        msgID: "run_1:fence_1:1",
      },
      {
        subject: "decopilot.stream.run_1",
        payload: { done: true, finalSeq: 1 },
        msgID: "run_1:fence_1:done:1",
      },
    ]);
  });

  test("processes error line then done: publishes error envelope then done with finalSeq from error seq", async () => {
    const { js, published } = makeFakeJs();
    const publisher = createDirectNatsPublisher({ js });

    const body = [
      JSON.stringify({
        seq: 1,
        event: { type: "error", code: "HARNESS_THROW", message: "boom" },
      }),
      JSON.stringify({ seq: 2, event: { type: "done" } }),
    ].join("\n");

    const result = await publishRelayBodyToNats({
      body,
      runId: "run_1",
      fenceToken: "fence_1",
      publisher,
    });

    expect(result).toEqual({ lastSeq: 2 });
    expect(published).toEqual([
      {
        subject: "decopilot.stream.run_1",
        payload: { p: { type: "error", errorText: "HARNESS_THROW: boom" } },
        msgID: "run_1:fence_1:1",
      },
      {
        subject: "decopilot.stream.run_1",
        payload: { done: true, finalSeq: 1 },
        msgID: "run_1:fence_1:done:1",
      },
    ]);
  });
});
