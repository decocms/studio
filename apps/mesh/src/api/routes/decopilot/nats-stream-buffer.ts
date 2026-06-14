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
  headers as natsHeaders,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
  type MsgHdrs,
  type NatsConnection,
} from "nats";
import { MAX_PUBLISH_BYTES } from "@/nats/payload-chunking";
import type { StreamBuffer } from "./stream-buffer";
import { meter } from "@/observability";

// B5: counter for JetStream publish errors — tagged by org.id (low cardinality).
// Increment happens inside createPublishTracker's catch where publish failures
// are already sampled-logged; the counter lets alerting fire without log scraping.
const publishErrorsCounter = meter.createCounter(
  "decopilot.stream.publish_errors",
  {
    description:
      "Number of JetStream publish failures for decopilot stream chunks",
    unit: "{errors}",
  },
);

const STREAM_NAME = "DECOPILOT_STREAMS";
const SUBJECT_PREFIX = "decopilot.stream";
const MAX_AGE_NS = 5 * 60 * 1_000_000_000; // 5 min
const MAX_BYTES = 500 * 1024 * 1024; // 500 MB
const MAX_MSGS_PER_SUBJECT = 20_000; // ~20K chunks per thread

// Above this a single chunk is pathological (not a normal UI stream part).
// Splitting it would hold tens of MB in memory on reassembly, so we drop it
// loudly instead.
const MAX_CHUNKED_BYTES = 32 * 1024 * 1024;
const FRAG_INDEX_HEADER = "Dp-Frag-Idx";
const FRAG_TOTAL_HEADER = "Dp-Frag-Total";

// Canary-gated profiler: is per-chunk JSON.stringify+encode the dominant
// event-loop occupant? Sums encode time across every active pump on the pod
// and reports it as a fraction of wall-clock per 10s window. Off by default
// (prod publish path stays byte-for-byte unchanged).
const STREAM_ENCODE_TRACE = process.env.STREAM_ENCODE_TRACE === "1";

class StreamEncodeProfiler {
  private chunks = 0;
  private encodeMs = 0;
  private maxMs = 0;
  private bytes = 0;
  private windowStart = performance.now();

  constructor() {
    const timer = setInterval(() => this.flush(), 10_000);
    timer.unref?.();
  }

  record(ms: number, byteLen: number): void {
    this.chunks++;
    this.encodeMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
    this.bytes += byteLen;
  }

  private flush(): void {
    const now = performance.now();
    const windowMs = now - this.windowStart;
    if (this.chunks > 0 && windowMs > 0) {
      console.warn(
        JSON.stringify({
          msg: "stream-encode-trace",
          windowMs: Math.round(windowMs),
          chunks: this.chunks,
          encodeMs: Math.round(this.encodeMs),
          // share of wall-clock the loop spent synchronously encoding chunks
          pctOfLoop: +((this.encodeMs / windowMs) * 100).toFixed(1),
          maxChunkMs: +this.maxMs.toFixed(2),
          mbEncoded: +(this.bytes / 1048576).toFixed(2),
        }),
      );
    }
    this.chunks = 0;
    this.encodeMs = 0;
    this.maxMs = 0;
    this.bytes = 0;
    this.windowStart = now;
  }
}

const streamEncodeProfiler = STREAM_ENCODE_TRACE
  ? new StreamEncodeProfiler()
  : null;

function assertSafeSubjectToken(id: string): void {
  if (/[.*>\s]/.test(id)) throw new Error("Invalid NATS subject token");
}

function streamSubject(taskId: string): string {
  assertSafeSubjectToken(taskId);
  return `${SUBJECT_PREFIX}.${taskId}`;
}

function createPublishTracker(taskId: string, orgId?: string) {
  let errors = 0;
  return {
    publish(
      js: JetStreamClient,
      subj: string,
      data: Uint8Array,
      hdrs?: MsgHdrs,
    ): void {
      js.publish(subj, data, hdrs ? { headers: hdrs } : undefined).catch(
        (err) => {
          errors++;
          // B5: increment OTEL counter on every publish failure so alerting can
          // fire without log scraping. Tag by org.id (low cardinality); fall
          // back to "unknown" when the org context isn't available at this
          // call site (e.g. standalone test harness without a dispatch context).
          publishErrorsCounter.add(1, { "org.id": orgId ?? "unknown" });
          if (errors === 1 || errors % 100 === 0) {
            console.warn(
              `[Decopilot] JetStream publish failed for thread ${taskId} (${errors} total):`,
              err,
            );
          }
        },
      );
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
    orgId?: string,
  ): void {
    const js = this.js;
    if (!js) return;

    const subj = streamSubject(taskId);
    const tracker = createPublishTracker(taskId, orgId);
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

    // Publish one stream chunk. Small chunks go straight through; anything
    // over the NATS payload limit is split into ordered fragment messages
    // (same subject, same connection → server preserves order) and stitched
    // back together by `createTailStream`. Fragments carry raw byte slices
    // of the encoded `{ p: value }` JSON, so reassembly is byte-exact.
    const publishChunk = (value: unknown): void => {
      let bytes: Uint8Array;
      if (streamEncodeProfiler) {
        const t0 = performance.now();
        bytes = encoder.encode(JSON.stringify({ p: value }));
        streamEncodeProfiler.record(performance.now() - t0, bytes.length);
      } else {
        bytes = encoder.encode(JSON.stringify({ p: value }));
      }
      if (bytes.length <= MAX_PUBLISH_BYTES) {
        tracker.publish(js, subj, bytes);
        return;
      }
      if (bytes.length > MAX_CHUNKED_BYTES) {
        console.warn(
          `[Decopilot] dropping oversized stream chunk for thread ${taskId}: ${(
            bytes.length / (1024 * 1024)
          ).toFixed(
            1,
          )} MiB exceeds ${MAX_CHUNKED_BYTES / (1024 * 1024)} MiB cap`,
        );
        return;
      }
      const total = Math.ceil(bytes.length / MAX_PUBLISH_BYTES);
      for (let i = 0; i < total; i++) {
        const slice = bytes.slice(
          i * MAX_PUBLISH_BYTES,
          (i + 1) * MAX_PUBLISH_BYTES,
        );
        const hdrs = natsHeaders();
        hdrs.set(FRAG_INDEX_HEADER, String(i));
        hdrs.set(FRAG_TOTAL_HEADER, String(total));
        tracker.publish(js, subj, slice, hdrs);
      }
    };

    void (async () => {
      const reader = stream.getReader();
      let sinceYield = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          publishChunk(value);
          // `reader.read()` normally yields to the event loop between chunks,
          // but a producer with many buffered chunks can resolve reads
          // synchronously in a burst — starving I/O (health checks, other
          // streams' encodes). Yield via setImmediate every N chunks so the
          // loop always gets a turn even under a synchronous burst.
          if (++sinceYield >= 64) {
            sinceYield = 0;
            await new Promise<void>((resolve) => setImmediate(resolve));
          }
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

  /**
   * Publish ONE raw chunk and AWAIT the JetStream ack (spec §5.3). This is the
   * durable commit point for the publish-then-consume ingest: the caller
   * advances its ack cursor only after this resolves `true`. Mirrors `pump`'s
   * `publishChunk` fragmentation, but awaited (not fire-and-forget) so the
   * caller knows the publish is confirmed. Returns `false` when JetStream is
   * unavailable so the caller does NOT advance its cursor.
   */
  async publishRawChunk(taskId: string, chunk: unknown): Promise<boolean> {
    const js = this.js;
    if (!js) return false;
    const subj = streamSubject(taskId);
    const bytes = this.encoder.encode(JSON.stringify({ p: chunk }));
    if (bytes.length > MAX_CHUNKED_BYTES) {
      console.warn(
        `[Decopilot] dropping oversized raw chunk for thread ${taskId}: ${(
          bytes.length / (1024 * 1024)
        ).toFixed(1)} MiB exceeds ${MAX_CHUNKED_BYTES / (1024 * 1024)} MiB cap`,
      );
      // Dropped, but the publish "succeeded" as far as the ack cursor is
      // concerned — refusing to advance would wedge the run on a pathological
      // chunk (loud-fail is the daemon-outbox cap's job, not ingest's).
      return true;
    }
    if (bytes.length <= MAX_PUBLISH_BYTES) {
      await js.publish(subj, bytes);
      return true;
    }
    const total = Math.ceil(bytes.length / MAX_PUBLISH_BYTES);
    for (let i = 0; i < total; i++) {
      const slice = bytes.slice(
        i * MAX_PUBLISH_BYTES,
        (i + 1) * MAX_PUBLISH_BYTES,
      );
      const hdrs = natsHeaders();
      hdrs.set(FRAG_INDEX_HEADER, String(i));
      hdrs.set(FRAG_TOTAL_HEADER, String(total));
      await js.publish(subj, slice, { headers: hdrs });
    }
    return true;
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

    // Reassembly buffer for chunks the producer split across fragment
    // messages (see `publishChunk`). A fresh accumulator is anchored on the
    // index-0 fragment; any fragment arriving without a live, matching
    // accumulator (a lost fragment, or a `deliverPolicy: "new"` subscriber
    // that joined mid-sequence) is dropped so it can't poison the next chunk.
    let frag: { total: number; received: number; parts: Uint8Array[] } | null =
      null;
    const reassembleFragment = (msg: {
      headers?: MsgHdrs;
      data: Uint8Array;
    }): Uint8Array | null => {
      const totalStr = msg.headers?.get(FRAG_TOTAL_HEADER);
      if (!totalStr) return null; // not a fragment — caller handles as JSON
      const total = Number(totalStr);
      const index = Number(msg.headers?.get(FRAG_INDEX_HEADER) ?? "0");
      if (index === 0) {
        frag = { total, received: 0, parts: new Array(total) };
      } else if (!frag || frag.total !== total) {
        return null; // stray fragment — no matching in-flight chunk
      }
      if (!frag.parts[index]) frag.received++;
      frag.parts[index] = msg.data;
      if (frag.received < frag.total) return null; // need more fragments
      const size = frag.parts.reduce((sum, p) => sum + (p?.length ?? 0), 0);
      const merged = new Uint8Array(size);
      let offset = 0;
      for (const part of frag.parts) {
        merged.set(part, offset);
        offset += part.length;
      }
      frag = null;
      return merged;
    };

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
          // Stitch fragmented chunks back together before decoding. A
          // fragment that doesn't complete the set yields null → read more.
          const reassembled = reassembleFragment(msg);
          if (msg.headers?.get(FRAG_TOTAL_HEADER) && !reassembled) continue;
          const payload = reassembled ?? msg.data;
          try {
            const data = JSON.parse(decoder.decode(payload));
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
