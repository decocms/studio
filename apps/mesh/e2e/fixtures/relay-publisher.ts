/**
 * Direct-NATS relay publisher — a black-box copy of what a real desktop daemon
 * does (`src/link-daemon/direct-nats-publisher.ts`), inlined so the e2e suite
 * owns the wire format (JetStream subject + msgId scheme + checkpoint debounce)
 * instead of importing app source. A divergence from the app's projector-stream
 * format is a wire-contract regression signal the suite SHOULD catch.
 *
 * The relay-line schema is the published contract `@decocms/sandbox/dispatch`,
 * so that one is imported, not duplicated.
 */
import type { JetStreamClient } from "@nats-io/jetstream";
import { relayLineSchema, type RelayLine } from "@decocms/sandbox/dispatch/relay";

// --- Stream subject + msgId scheme (mirrors projector-stream-messages.ts) -----

const DECOPILOT_STREAM_SUBJECT_PREFIX = "decopilot.stream";

/** Debounce between incremental checkpoint markers (matches the app producer). */
const CHECKPOINT_DEBOUNCE_MS = 3000;

function assertSafeSubjectToken(id: string): void {
  if (/[.*>\s]/.test(id)) throw new Error("Invalid NATS subject token");
}

function streamSubject(runId: string): string {
  assertSafeSubjectToken(runId);
  return `${DECOPILOT_STREAM_SUBJECT_PREFIX}.${runId}`;
}

function buildChunkMsgId(input: {
  runId: string;
  fenceToken: string;
  seq: number;
  fragmentIndex?: number;
}): string {
  const base = `${input.runId}:${input.fenceToken}:${input.seq}`;
  return input.fragmentIndex === undefined
    ? base
    : `${base}:frag:${input.fragmentIndex}`;
}

function buildDoneMsgId(input: {
  runId: string;
  fenceToken: string;
  finalSeq: number;
}): string {
  return `${input.runId}:${input.fenceToken}:done:${input.finalSeq}`;
}

function buildCheckpointMsgId(input: {
  runId: string;
  fenceToken: string;
  headSeq: number;
}): string {
  return `${input.runId}:${input.fenceToken}:ckpt:${input.headSeq}`;
}

// --- Publisher ----------------------------------------------------------------

export interface DirectNatsPublisher {
  publishLine(input: {
    runId: string;
    fenceToken: string;
    line: RelayLine;
  }): Promise<"published" | "terminal">;
  publishDone(input: {
    runId: string;
    fenceToken: string;
    finalSeq: number;
  }): Promise<void>;
  publishCheckpoint(input: {
    runId: string;
    fenceToken: string;
    headSeq: number;
  }): Promise<void>;
}

export function createDirectNatsPublisher(input: {
  js: Pick<JetStreamClient, "publish">;
}): DirectNatsPublisher {
  const encoder = new TextEncoder();
  return {
    async publishLine({ runId, fenceToken, line }) {
      if (line.event.type === "ui-message-chunk") {
        await input.js.publish(
          streamSubject(runId),
          encoder.encode(JSON.stringify({ p: line.event.chunk })),
          { msgID: buildChunkMsgId({ runId, fenceToken, seq: line.seq }) },
        );
        return "published";
      }
      if (line.event.type === "error") {
        const errorText = `${line.event.code}: ${line.event.message}`;
        await input.js.publish(
          streamSubject(runId),
          encoder.encode(JSON.stringify({ p: { type: "error", errorText } })),
          { msgID: buildChunkMsgId({ runId, fenceToken, seq: line.seq }) },
        );
        return "published";
      }
      return "terminal";
    },
    async publishDone({ runId, fenceToken, finalSeq }) {
      await input.js.publish(
        streamSubject(runId),
        encoder.encode(JSON.stringify({ done: true, finalSeq })),
        { msgID: buildDoneMsgId({ runId, fenceToken, finalSeq }) },
      );
    },
    async publishCheckpoint({ runId, fenceToken, headSeq }) {
      await input.js.publish(
        streamSubject(runId),
        encoder.encode(JSON.stringify({ checkpoint: true, headSeq })),
        { msgID: buildCheckpointMsgId({ runId, fenceToken, headSeq }) },
      );
    },
  };
}

export interface PublishRelayBodyResult {
  /** Highest wireSeq observed across ALL lines (incl. the terminal `done`). */
  lastSeq: number;
}

async function* ndjsonValues(
  body: ReadableStream<Uint8Array> | string,
): AsyncGenerator<unknown> {
  if (typeof body === "string") {
    for (const line of body.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      try {
        yield JSON.parse(trimmed);
      } catch {
        // skip unparseable lines
      }
    }
    return;
  }
  const decoder = new TextDecoder();
  let buffer = "";
  const reader = body.getReader();
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed === "") continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          // skip unparseable lines
        }
      }
    }
    const flushed = buffer + decoder.decode();
    const trimmed = flushed.trim();
    if (trimmed !== "") {
      try {
        yield JSON.parse(trimmed);
      } catch {
        // skip
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export async function publishRelayBodyToNats(input: {
  body: ReadableStream<Uint8Array> | string;
  runId: string;
  fenceToken: string;
  publisher: DirectNatsPublisher;
  now?: () => number;
  checkpointDebounceMs?: number;
}): Promise<PublishRelayBodyResult> {
  const now = input.now ?? Date.now;
  const debounceMs = input.checkpointDebounceMs ?? CHECKPOINT_DEBOUNCE_MS;
  let maxWireSeq = 0;
  let finalSeq = 0;
  let lastCheckpointAt = now();
  for await (const value of ndjsonValues(input.body)) {
    const parsed = relayLineSchema.safeParse(value);
    if (!parsed.success) continue;
    const line = parsed.data;
    maxWireSeq = Math.max(maxWireSeq, line.seq);
    const result = await input.publisher.publishLine({
      runId: input.runId,
      fenceToken: input.fenceToken,
      line,
    });
    if (result === "published") {
      finalSeq = Math.max(finalSeq, line.seq);
      if (now() - lastCheckpointAt >= debounceMs) {
        lastCheckpointAt = now();
        await input.publisher.publishCheckpoint({
          runId: input.runId,
          fenceToken: input.fenceToken,
          headSeq: finalSeq,
        });
      }
    }
  }
  if (finalSeq > 0) {
    await input.publisher.publishDone({
      runId: input.runId,
      fenceToken: input.fenceToken,
      finalSeq,
    });
  }
  return { lastSeq: maxWireSeq };
}
