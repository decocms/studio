/**
 * NATS JetStream Stream Buffer
 *
 * Publishes UIMessageStream chunks to NATS JetStream (memory storage)
 * so late-joining clients can replay the stream from any pod.
 *
 * Enhancements over original jetstream-relay.ts:
 * - Per-subject message limit (20K chunks per thread) prevents one thread from starving others
 * - Per-thread publish error tracking with sampled logging
 * - Explicit purge method for run completion cleanup
 */

import {
  AckPolicy,
  DiscardPolicy,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type NatsConnection,
} from "nats";
import type { StreamBuffer } from "./stream-buffer";

const STREAM_NAME = "DECOPILOT_STREAMS";
const SUBJECT_PREFIX = "decopilot.stream";
const MAX_AGE_NS = 5 * 60 * 1_000_000_000; // 5 min
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_MSGS_PER_SUBJECT = 20_000; // ~20K chunks per thread
const PULL_TIMEOUT_MS = 30_000;

function assertSafeSubjectToken(id: string): void {
  if (/[.*>\s]/.test(id)) throw new Error("Invalid NATS subject token");
}

function streamSubject(threadId: string): string {
  assertSafeSubjectToken(threadId);
  return `${SUBJECT_PREFIX}.${threadId}`;
}

function createPublishTracker(threadId: string) {
  let errors = 0;
  return {
    publish(js: JetStreamClient, subj: string, data: Uint8Array): void {
      js.publish(subj, data).catch((err) => {
        errors++;
        if (errors === 1 || errors % 100 === 0) {
          console.warn(
            `[Decopilot] JetStream publish failed for thread ${threadId} (${errors} total):`,
            err,
          );
        }
      });
    },
    get errorCount() {
      return errors;
    },
  };
}

export interface NatsStreamBufferOptions {
  getConnection: () => NatsConnection | null;
  getJetStream: () => JetStreamClient | null;
}

export class NatsStreamBuffer implements StreamBuffer {
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private readonly encoder = new TextEncoder();

  constructor(private readonly options: NatsStreamBufferOptions) {}

  async init(): Promise<void> {
    const nc = this.options.getConnection();
    if (!nc) return;

    const jsm = await nc.jetstreamManager();

    const config = {
      name: STREAM_NAME,
      subjects: [`${SUBJECT_PREFIX}.>`],
      storage: StorageType.Memory,
      max_age: MAX_AGE_NS,
      max_bytes: MAX_BYTES,
      max_msgs_per_subject: MAX_MSGS_PER_SUBJECT,
      discard: DiscardPolicy.Old,
      retention: RetentionPolicy.Limits,
      num_replicas: 1,
    };

    try {
      await jsm.streams.info(STREAM_NAME);
      await jsm.streams.update(STREAM_NAME, config);
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error && err.message.includes("stream not found");
      if (isNotFound) {
        await jsm.streams.add(config);
      } else {
        throw err;
      }
    }

    this.js = this.options.getJetStream();
    this.jsm = jsm;
    console.log(
      "[Decopilot] JetStream stream buffer ready (memory storage, 5min TTL, 20K msgs/subject)",
    );
  }

  relay(
    stream: ReadableStream,
    threadId: string,
    abortSignal?: AbortSignal,
  ): ReadableStream {
    const js = this.js;
    if (!js) return stream;

    const subj = streamSubject(threadId);
    const tracker = createPublishTracker(threadId);
    const encoder = this.encoder;
    let terminated = false;

    const publishDone = () => {
      if (terminated) return;
      terminated = true;
      js.publish(subj, encoder.encode(JSON.stringify({ done: true }))).catch(
        () => {},
      );
    };

    abortSignal?.addEventListener("abort", publishDone);

    return stream.pipeThrough(
      new TransformStream({
        transform(chunk, controller) {
          controller.enqueue(chunk);
          tracker.publish(
            js,
            subj,
            encoder.encode(JSON.stringify({ p: chunk })),
          );
        },
        flush() {
          abortSignal?.removeEventListener("abort", publishDone);
          publishDone();
        },
      }),
    );
  }

  async createReplayStream(threadId: string): Promise<ReadableStream | null> {
    const js = this.js;
    if (!js) return null;

    const subj = streamSubject(threadId);

    let sub;
    try {
      sub = await js.subscribe(subj, {
        ordered: true,
        config: {
          filter_subject: subj,
          ack_policy: AckPolicy.None,
        },
      });
    } catch (err) {
      console.warn(
        "[Decopilot] JetStream replay unavailable (non-critical):",
        (err as Error)?.message ?? err,
      );
      return null;
    }

    const decoder = new TextDecoder();

    // Use explicit iterator so pull() maintains position across invocations
    const iter = (async function* () {
      for await (const msg of sub) {
        yield msg;
      }
    })();

    return new ReadableStream({
      async pull(controller) {
        while (true) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const result = await Promise.race([
            iter.next(),
            new Promise<{ done: true; value: undefined }>((r) => {
              timer = setTimeout(
                () => r({ done: true, value: undefined }),
                PULL_TIMEOUT_MS,
              );
            }),
          ]);
          clearTimeout(timer);
          if (result.done) {
            sub.unsubscribe();
            controller.close();
            return;
          }
          const msg = result.value;
          try {
            const data = JSON.parse(decoder.decode(msg.data));
            if (data.done) {
              sub.unsubscribe();
              controller.close();
              return;
            }
            if (data.p) {
              controller.enqueue(data.p);
              return;
            }
          } catch {
            // skip malformed, continue to next message
          }
        }
      },
      cancel() {
        sub.unsubscribe();
      },
    });
  }

  purge(threadId: string): void {
    if (!this.jsm) return;
    this.jsm.streams
      .purge(STREAM_NAME, { filter: streamSubject(threadId) })
      .catch(() => {});
  }

  teardown(): void {
    this.js = null;
    this.jsm = null;
    console.log("[Decopilot] JetStream stream buffer torn down");
  }
}
