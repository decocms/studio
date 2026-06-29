import type { UIMessageChunk } from "ai";
import { DeliverPolicy, type JetStreamClient } from "@nats-io/jetstream";
import { sleep } from "@decocms/std";
import {
  DECOPILOT_STREAM_NAME,
  isDoneEnvelope,
  parseRunStreamMsgId,
  runIdFromSubject,
  streamSubject,
} from "./projector-stream-messages";

const FRAG_INDEX_HEADER = "Dp-Frag-Idx";
const FRAG_TOTAL_HEADER = "Dp-Frag-Total";
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface ProjectorStreamMessage {
  subject: string;
  data: Uint8Array;
  headers?: { get(name: string): string | undefined };
}

export interface ProjectorChunkStreamOptions {
  messages:
    | AsyncIterable<ProjectorStreamMessage>
    | Iterable<ProjectorStreamMessage>;
  runId: string;
  fenceToken: string;
  idleTimeoutMs?: number;
  onDone?: () => void;
}

export interface JetStreamProjectorChunkStreamOptions {
  js: JetStreamClient;
  runId: string;
  fenceToken: string;
  idleTimeoutMs?: number;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, p) => sum + p.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function decodePayload(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

function iteratorFor<T>(
  source: AsyncIterable<T> | Iterable<T>,
): AsyncIterator<T> {
  if (Symbol.asyncIterator in source) return source[Symbol.asyncIterator]();
  const iter = source[Symbol.iterator]();
  return {
    next: async () => iter.next(),
    return: async (value?: unknown) =>
      iter.return
        ? iter.return(value as never)
        : ({ done: true, value: value as T } as IteratorResult<T>),
  };
}

export function createProjectorChunkStreamFromMessages(
  options: ProjectorChunkStreamOptions,
): ReadableStream<UIMessageChunk> {
  const iterator = iteratorFor(options.messages);
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const fragments = new Map<number, { total: number; parts: Uint8Array[] }>();
  let nextSeq = 1;
  let closed = false;

  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      if (closed) return;
      for (;;) {
        const idleCtl = new AbortController();
        const next = iterator.next().then((result) => {
          idleCtl.abort();
          return result;
        });
        const idle = sleep(idleTimeoutMs, { signal: idleCtl.signal })
          .then(() => "idle" as const)
          .catch(() => "cancelled" as const);
        const result = await Promise.race([next, idle]);
        if (result === "idle") {
          controller.error(
            new Error("producer produced no output before timeout"),
          );
          return;
        }
        if (result === "cancelled") continue;
        if (result.done) {
          controller.error(new Error("reader stopped before done"));
          return;
        }

        const message = result.value;
        if (runIdFromSubject(message.subject) !== options.runId) continue;
        const msgId = message.headers?.get("Nats-Msg-Id") || undefined;
        const parsed = parseRunStreamMsgId(msgId);
        if (
          !parsed ||
          parsed.runId !== options.runId ||
          parsed.fenceToken !== options.fenceToken
        ) {
          continue;
        }

        if (parsed.kind === "done") {
          const payload = decodePayload(message.data);
          if (
            !isDoneEnvelope(payload) ||
            payload.finalSeq !== parsed.finalSeq
          ) {
            continue;
          }
          if (parsed.finalSeq !== nextSeq - 1) {
            controller.error(new Error(`missing seq ${nextSeq}`));
            return;
          }
          closed = true;
          options.onDone?.();
          controller.close();
          return;
        }

        if (parsed.kind !== "chunk") continue;
        if (parsed.seq < nextSeq) continue;
        if (parsed.seq > nextSeq) {
          controller.error(new Error(`missing seq ${nextSeq}`));
          return;
        }

        const total = Number(message.headers?.get(FRAG_TOTAL_HEADER) ?? "0");
        const isFragment = parsed.fragmentIndex !== null || total > 0;
        let payloadBytes: Uint8Array;
        if (isFragment) {
          const fragmentIndex =
            parsed.fragmentIndex ??
            Number(message.headers?.get(FRAG_INDEX_HEADER) ?? "0");
          const existing = fragments.get(parsed.seq) ?? {
            total,
            parts: new Array(total),
          };
          existing.parts[fragmentIndex] = message.data;
          fragments.set(parsed.seq, existing);
          if (existing.parts.filter(Boolean).length < existing.total) continue;
          payloadBytes = concat(existing.parts);
          fragments.delete(parsed.seq);
        } else {
          payloadBytes = message.data;
        }

        const payload = decodePayload(payloadBytes);
        if (payload && typeof payload === "object" && "p" in payload) {
          const chunk = (payload as { p: UIMessageChunk }).p;
          nextSeq++;
          controller.enqueue(chunk);
          if (chunk.type === "finish") {
            closed = true;
            options.onDone?.();
            controller.close();
          }
          return;
        }
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
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
    for await (const msg of sub) {
      yield {
        subject: msg.subject,
        data: msg.data,
        headers: msg.headers,
      };
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
