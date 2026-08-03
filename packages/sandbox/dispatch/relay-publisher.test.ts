import { describe, expect, test } from "bun:test";
import type { JetStreamClient } from "@nats-io/jetstream";
import { MAX_PUBLISH_BYTES } from "@decocms/shared/harness/offload-messages";
import {
  FRAG_INDEX_HEADER,
  FRAG_TOTAL_HEADER,
} from "@decocms/shared/harness/run-stream-codec";
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

type RawPublishRecord = {
  subject: string;
  data: Uint8Array;
  opts?: { msgID?: string; headers?: { get(name: string): string } };
};

function makeFakeJsRaw(): {
  js: Pick<JetStreamClient, "publish">;
  records: RawPublishRecord[];
} {
  const records: RawPublishRecord[] = [];
  const js = {
    publish: async (
      subject: string,
      data: Uint8Array,
      opts?: { msgID?: string; headers?: { get(name: string): string } },
    ) => {
      records.push({ subject, data, opts });
      return {} as never;
    },
  } as Pick<JetStreamClient, "publish">;
  return { js, records };
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

  test("ui-message-chunk exceeding MAX_PUBLISH_BYTES is fragmented into multiple publishes", async () => {
    const { js, records } = makeFakeJsRaw();
    const publisher = createDirectNatsPublisher({ js });

    // Build a chunk whose {p:chunk} JSON exceeds MAX_PUBLISH_BYTES
    const delta = "x".repeat(MAX_PUBLISH_BYTES);
    await publisher.publishLine({
      runId: "run_frag",
      fenceToken: "fence_f",
      line: {
        seq: 1,
        event: {
          type: "ui-message-chunk",
          chunk: { type: "text-delta", id: "1", delta },
        },
      },
    });

    expect(records.length).toBeGreaterThan(1);
    const total = records.length;
    for (let i = 0; i < total; i++) {
      const rec = records[i];
      expect(rec.subject).toBe("decopilot.stream.run_frag");
      expect(rec.opts?.headers?.get(FRAG_INDEX_HEADER)).toBe(String(i));
      expect(rec.opts?.headers?.get(FRAG_TOTAL_HEADER)).toBe(String(total));
      expect(rec.opts?.msgID).toBe(`run_frag:fence_f:1:frag:${i}`);
    }
  });

  test("small ui-message-chunk produces exactly one publish with no frag headers", async () => {
    const { js, records } = makeFakeJsRaw();
    const publisher = createDirectNatsPublisher({ js });

    await publisher.publishLine({
      runId: "run_small",
      fenceToken: "fence_s",
      line: {
        seq: 2,
        event: {
          type: "ui-message-chunk",
          chunk: { type: "text-delta", id: "1", delta: "hello" },
        },
      },
    });

    expect(records.length).toBe(1);
    expect(records[0].opts?.msgID).toBe("run_small:fence_s:2");
    expect(records[0].opts?.headers).toBeUndefined();
  });
});

test("publishRelayBodyToNats reports onPublished at the debounce cadence (drives outbox truncation)", async () => {
  const published: number[] = [];
  const publisher = {
    publishLine: async ({ line }: { line: { event: { type: string } } }) =>
      line.event.type === "ui-message-chunk"
        ? ("published" as const)
        : ("terminal" as const),
    publishDone: async () => {},
  };
  // Fake clock: advance 4s per call so each content line crosses the 3s debounce.
  // The implementation calls now() once at init (lastReportAt = now())
  // then twice per content line: once to check (now() - lastReportAt >= debounceMs)
  // and once to update (lastReportAt = now()).
  // Call sequence: init=0, check_1=4000, update_1=8000, check_2=12000, update_2=16000
  // check_1: 4000 - 0 = 4000 >= 3000 → report seq 1; check_2: 12000 - 8000 = 4000 >= 3000 → report seq 2
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
    reportDebounceMs: 3000,
    onPublished: (seq) => published.push(seq),
  });
  // Mid-stream report at each debounce crossing; terminal flush is a no-op since
  // seq 2 was already reported. Rolling truncation keeps the outbox from
  // accumulating the entire run and hitting the 512 MiB cap.
  expect(published).toEqual([1, 2]);
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
  const now = () => 1000; // never advances → never crosses 3s debounce
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
    reportDebounceMs: 3000,
    onPublished: (seq) => published.push(seq),
  });
  // No debounce crossed, but the terminal flush still reports the durable
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
