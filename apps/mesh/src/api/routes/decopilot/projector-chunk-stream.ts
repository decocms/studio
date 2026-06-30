import type { UIMessageChunk } from "ai";
import { DeliverPolicy, type JetStreamClient } from "@nats-io/jetstream";
import { DECOPILOT_STREAM_NAME } from "./projector-stream-messages";
import {
  assertContiguousAndDedup,
  DEFAULT_IDLE_TIMEOUT_MS,
  fenceFilter,
  natsChunkSource,
  projectorChunkStream,
} from "./nats-chunk-source";
import {
  decodeStream,
  reassembleFragments,
  streamSubject,
  type RawMsg,
} from "@decocms/harness/run-stream-codec";

/** Back-compat alias — the shared `RawMsg` is the old `ProjectorStreamMessage`. */
export type ProjectorStreamMessage = RawMsg;

export interface ProjectorChunkStreamOptions {
  messages:
    | AsyncIterable<ProjectorStreamMessage>
    | Iterable<ProjectorStreamMessage>;
  runId: string;
  fenceToken: string;
  idleTimeoutMs?: number;
  /**
   * Cleanup callback wired as the source's `onCancel`. Fires once when the
   * stream finalizes — on a clean terminal close (done/finish) AND on external
   * cancel — because the terminal close cancels the source through the
   * pipeThrough chain. Must be idempotent (the production caller passes the
   * idempotent `sub.stop`). This is a deliberate widening over the pre-refactor
   * behavior, where `onDone` fired only on terminal close and an early cancel
   * could leak the subscription.
   */
  onDone?: () => void;
}

export interface JetStreamProjectorChunkStreamOptions {
  js: JetStreamClient;
  runId: string;
  fenceToken: string;
  idleTimeoutMs?: number;
}

export function createProjectorChunkStreamFromMessages(
  options: ProjectorChunkStreamOptions,
): ReadableStream<UIMessageChunk> {
  const source = natsChunkSource({
    messages: options.messages,
    idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS,
    onCancel: options.onDone,
  });
  const events = source
    .pipeThrough(reassembleFragments())
    .pipeThrough(decodeStream())
    .pipeThrough(fenceFilter(options.runId, options.fenceToken))
    .pipeThrough(assertContiguousAndDedup());
  return projectorChunkStream(events);
}

export async function createProjectorChunkStream(
  options: JetStreamProjectorChunkStreamOptions,
): Promise<ReadableStream<UIMessageChunk>> {
  const consumer = await options.js.consumers.get(DECOPILOT_STREAM_NAME, {
    filter_subjects: streamSubject(options.runId),
    deliver_policy: DeliverPolicy.All,
  });
  const sub = await consumer.consume();
  async function* messages(): AsyncIterable<ProjectorStreamMessage> {
    try {
      for await (const msg of sub) {
        yield { subject: msg.subject, data: msg.data, headers: msg.headers };
      }
    } finally {
      sub.stop();
    }
  }
  return createProjectorChunkStreamFromMessages({
    messages: messages(),
    runId: options.runId,
    fenceToken: options.fenceToken,
    idleTimeoutMs: options.idleTimeoutMs,
    onDone: () => sub.stop(),
  });
}
