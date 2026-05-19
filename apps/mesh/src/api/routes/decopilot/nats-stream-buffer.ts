/**
 * NATS JetStream Stream Buffer
 *
 * The per-task JetStream subject is the source of truth for a run's UI
 * stream. The producer (`dispatchRunAndWait`) calls `pump()` once; tail
 * consumers (every `/stream` HTTP response) call `createTailStream()`. The
 * pump is decoupled from any consumer, so an HTTP cancel never stalls the
 * producer or drops chunks.
 *
 * - Per-subject message limit (20K chunks per thread) prevents one thread
 *   from starving others.
 * - Per-thread publish error tracking with sampled logging.
 * - `purge()` is called on terminal events from the run reactor to drop
 *   completed runs early; the 5-minute `max_age` is the upper bound.
 */

import {
  AckPolicy,
  DeliverPolicy,
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

function assertSafeSubjectToken(id: string): void {
  if (/[.*>\s]/.test(id)) throw new Error("Invalid NATS subject token");
}

function streamSubject(taskId: string): string {
  assertSafeSubjectToken(taskId);
  return `${SUBJECT_PREFIX}.${taskId}`;
}

function createPublishTracker(taskId: string) {
  let errors = 0;
  return {
    publish(js: JetStreamClient, subj: string, data: Uint8Array): void {
      js.publish(subj, data).catch((err) => {
        errors++;
        if (errors === 1 || errors % 100 === 0) {
          console.warn(
            `[Decopilot] JetStream publish failed for thread ${taskId} (${errors} total):`,
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
    if (!nc) return; // NATS not ready — stream buffer disabled
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
  }

  pump(
    stream: ReadableStream,
    taskId: string,
    registrySignal: AbortSignal,
  ): void {
    const js = this.js;
    if (!js) return;

    const subj = streamSubject(taskId);
    const tracker = createPublishTracker(taskId);
    const encoder = this.encoder;

    let terminated = false;
    const publishDone = () => {
      if (terminated) return;
      terminated = true;
      js.publish(subj, encoder.encode(JSON.stringify({ done: true }))).catch(
        () => {},
      );
    };

    // If the run is force-failed mid-stream the reader below may never
    // observe the upstream close (e.g. tool stuck in a polling loop), so
    // also wire `registrySignal` straight to the sentinel.
    registrySignal.addEventListener("abort", publishDone, { once: true });

    void (async () => {
      const reader = stream.getReader();
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          tracker.publish(
            js,
            subj,
            encoder.encode(JSON.stringify({ p: value })),
          );
        }
      } catch (err) {
        console.warn(
          `[Decopilot] stream pump error for thread ${taskId}:`,
          (err as Error)?.message ?? err,
        );
      } finally {
        reader.releaseLock();
        publishDone();
      }
    })();
  }

  async createTailStream(
    taskId: string,
    signal?: AbortSignal,
    opts?: {
      deliverPolicy?: "all" | "new";
      closeOnDone?: boolean;
    },
  ): Promise<ReadableStream | null> {
    const js = this.js;
    if (!js) return null;

    const deliverPolicy =
      opts?.deliverPolicy === "new" ? DeliverPolicy.New : DeliverPolicy.All;
    const closeOnDone = opts?.closeOnDone ?? false;
    const subj = streamSubject(taskId);

    let sub;
    try {
      sub = await js.subscribe(subj, {
        ordered: true,
        config: {
          filter_subject: subj,
          ack_policy: AckPolicy.None,
          deliver_policy: deliverPolicy,
        },
      });
    } catch (err) {
      console.warn(
        "[Decopilot] JetStream tail unavailable (non-critical):",
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

    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
      sub.unsubscribe();
      iter.return(undefined).catch(() => {});
    };

    signal?.addEventListener("abort", cleanup, { once: true });

    return new ReadableStream({
      async pull(controller) {
        while (true) {
          const result = await iter.next();
          if (result.done) {
            cleanup();
            controller.close();
            return;
          }
          const msg = result.value;
          try {
            const data = JSON.parse(decoder.decode(msg.data));
            if (data.done) {
              if (closeOnDone) {
                cleanup();
                controller.close();
                return;
              }
              // A run ended, but the subscription stays open for the next
              // run on this thread. Clients detect run boundaries from the
              // AI-SDK `{type: "finish"}` chunk in the data stream, not
              // from the JetStream sentinel — so we swallow it here.
              continue;
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
        cleanup();
      },
    });
  }

  purge(taskId: string): void {
    if (!this.jsm) return;
    this.jsm.streams
      .purge(STREAM_NAME, { filter: streamSubject(taskId) })
      .catch(() => {});
  }

  teardown(): void {
    this.js = null;
    this.jsm = null;
  }
}
