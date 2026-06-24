import { describe, expect, test } from "bun:test";
import type { JetStreamClient } from "@nats-io/jetstream";
import {
  createDirectNatsPublisher,
  publishRelayBodyToNats,
} from "./direct-nats-publisher";

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

test("publishCheckpoint emits a checkpoint envelope with the ckpt msgId", async () => {
  const published: Array<{
    subject: string;
    payload: unknown;
    msgID?: string;
  }> = [];
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
  };
  const publisher = createDirectNatsPublisher({ js });
  await publisher.publishCheckpoint({
    runId: "run_1",
    fenceToken: "fence_1",
    headSeq: 4,
  });
  expect(published).toEqual([
    {
      subject: "decopilot.stream.run_1",
      payload: { checkpoint: true, headSeq: 4 },
      msgID: "run_1:fence_1:ckpt:4",
    },
  ]);
});

test("publishRelayBodyToNats emits debounced checkpoints at the contiguous headSeq", async () => {
  const checkpoints: number[] = [];
  const publisher = {
    publishLine: async ({
      line,
    }: {
      line: { seq: number; event: { type: string } };
    }) =>
      line.event.type === "ui-message-chunk"
        ? ("published" as const)
        : ("terminal" as const),
    publishDone: async () => {},
    publishCheckpoint: async ({ headSeq }: { headSeq: number }) => {
      checkpoints.push(headSeq);
    },
  };
  // Fake clock: advance 4s per call so each content line crosses the 3s debounce.
  // The implementation calls now() once at init (lastCheckpointAt = now())
  // then twice per content line: once to check (now() - lastCheckpointAt >= debounceMs)
  // and once to update (lastCheckpointAt = now()).
  // Call sequence: init=0, check_1=4000, update_1=8000, check_2=12000, update_2=16000
  // check_1: 4000 - 0 = 4000 >= 3000 → emit; check_2: 12000 - 8000 = 4000 >= 3000 → emit
  let callCount = 0;
  const times = [0, 4000, 8000, 12000, 16000];
  const now = () => times[callCount++] ?? 16000;
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
    now,
    checkpointDebounceMs: 3000,
  });
  // A checkpoint per content line that crossed the debounce window (headSeq = contiguous content seq).
  expect(checkpoints).toEqual([1, 2]);
});

test("publishRelayBodyToNats emits no checkpoint when under the debounce", async () => {
  const checkpoints: number[] = [];
  const publisher = {
    publishLine: async ({
      line,
    }: {
      line: { seq: number; event: { type: string } };
    }) =>
      line.event.type === "ui-message-chunk"
        ? ("published" as const)
        : ("terminal" as const),
    publishDone: async () => {},
    publishCheckpoint: async ({ headSeq }: { headSeq: number }) => {
      checkpoints.push(headSeq);
    },
  };
  const now = () => 1000; // never advances → never crosses 3s
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
    now,
    checkpointDebounceMs: 3000,
  });
  expect(checkpoints).toEqual([]);
});

test("publishRelayBodyToNats reports onPublished at the checkpoint cadence (drives outbox truncation)", async () => {
  const published: number[] = [];
  const publisher = {
    publishLine: async ({ line }: { line: { event: { type: string } } }) =>
      line.event.type === "ui-message-chunk"
        ? ("published" as const)
        : ("terminal" as const),
    publishDone: async () => {},
    publishCheckpoint: async () => {},
  };
  let callCount = 0;
  const times = [0, 4000, 8000, 12000, 16000];
  const now = () => times[callCount++] ?? 16000;
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
    now,
    checkpointDebounceMs: 3000,
    onPublished: (seq) => published.push(seq),
  });
  // Reported the durable high-water mark at each debounce crossing; the terminal
  // flush is a no-op since seq 2 was already reported.
  expect(published).toEqual([1, 2]);
});

test("publishRelayBodyToNats flushes a final onPublished even when no checkpoint fires", async () => {
  const published: number[] = [];
  const publisher = {
    publishLine: async ({ line }: { line: { event: { type: string } } }) =>
      line.event.type === "ui-message-chunk"
        ? ("published" as const)
        : ("terminal" as const),
    publishDone: async () => {},
    publishCheckpoint: async () => {},
  };
  const now = () => 1000; // never crosses the debounce window
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
    now,
    checkpointDebounceMs: 3000,
    onPublished: (seq) => published.push(seq),
  });
  // No checkpoint crossed, but the terminal flush still reports the durable
  // high-water mark so the outbox prefix is dropped before terminal ack.
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
