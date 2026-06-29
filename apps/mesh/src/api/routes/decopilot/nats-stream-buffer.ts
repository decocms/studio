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
  DeliverPolicy,
  DiscardPolicy,
  jetstreamManager,
  RetentionPolicy,
  StorageType,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import {
  headers as natsHeaders,
  type MsgHdrs,
  type NatsConnection,
} from "@nats-io/nats-core";
import { MAX_PUBLISH_BYTES } from "@/nats/payload-chunking";
import {
  buildCheckpointMsgId,
  buildChunkMsgId,
  buildDoneMsgId,
  DECOPILOT_STREAM_NAME,
  DECOPILOT_STREAM_SUBJECT_PREFIX,
  parseRunStreamMsgId,
  streamSubject,
} from "./projector-stream-messages";
import type { StreamBuffer } from "./stream-buffer";
import {
  natsChunkSource,
  reassembleFragments,
  unwrapPayload,
  type RawMsg,
} from "./nats-chunk-source";
import { meter } from "@/observability";
import { encodeMsHistogram, publishedChunksCounter } from "./stream-metrics";

// `meter` is a NoopMeter until initObservability() runs at bootstrap
// (index.ts), and this module is imported *before* that — so instruments
// created at module top bind the noop and silently never export. Create them
// lazily on first use, by which point `meter` has been reassigned to the real
// provider. (This is why the metrics below historically reported no data.)
const lazyInstrument = <T>(make: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

// B5: counter for JetStream publish errors — tagged by org.id (low cardinality).
// Increment happens inside createPublishTracker's catch where publish failures
// are already sampled-logged; the counter lets alerting fire without log scraping.
const publishErrorsCounter = lazyInstrument(() =>
  meter.createCounter("decopilot.stream.publish_errors", {
    description:
      "Number of JetStream publish failures for decopilot stream chunks",
    unit: "{errors}",
  }),
);

// encode_ms + published_chunks live in ./stream-metrics so the link-daemon's
// direct-nats-publisher (the path agent-sandbox runs actually take) feeds the
// same instruments instead of double-registering them.

// 30 min — projector-lag SLA: the stream is the sole path to the DB (Phase C),
// so retention must outlast a projector outage long enough to catch up. Tune later.
const MAX_AGE_NS = 24 * 60 * 60 * 1_000_000_000; // 24h — outlasts day-long desktop runs
// Time-based Nats-Msg-Id dedup window (spec §10.2): a republished chunk within
// this window is dropped by JetStream, so an at-least-once producer (outbox
// retry) can't double-write the same UI part.
const DUPLICATE_WINDOW_NS = 2 * 60 * 1_000_000_000; // 2 min
const MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4GB stream cap
const MAX_MSGS_PER_SUBJECT = 500_000; // headroom for multi-hour non-stop streams
export { CHECKPOINT_DEBOUNCE_MS } from "./projector-stream-messages";

/**
 * Pure stream config for `DECOPILOT_STREAMS`. File-backed so the run-scratch
 * stream survives a NATS restart, with a retention SLA and a time-based dedup
 * window. Extracted from `init()` so it can be unit-tested without a connection.
 */
export function decopilotStreamConfig() {
  return {
    name: DECOPILOT_STREAM_NAME,
    subjects: [`${DECOPILOT_STREAM_SUBJECT_PREFIX}.>`],
    storage: StorageType.File, // was Memory — survive NATS restart
    max_age: MAX_AGE_NS,
    max_bytes: MAX_BYTES,
    max_msgs_per_subject: MAX_MSGS_PER_SUBJECT,
    discard: DiscardPolicy.Old,
    retention: RetentionPolicy.Limits,
    duplicate_window: DUPLICATE_WINDOW_NS, // time-based Nats-Msg-Id dedup (spec §10.2)
    num_replicas: 1,
  };
}

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

// Per-run publish tracing (off by default). When "1", logs how many chunks a
// pump actually published to the subject — the producer-side counterpart to
// the /stream `deliveredChunks` log, so a "published N but tail delivered 0"
// divergence is visible.
const STREAM_TAIL_TRACE = process.env.DECOPILOT_STREAM_TRACE === "1";

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

function fragmentMsgId(
  msgID: string | undefined,
  index: number,
): string | undefined {
  if (!msgID) return undefined;
  const parsed = parseRunStreamMsgId(msgID);
  return parsed?.kind === "chunk"
    ? buildChunkMsgId({ ...parsed, fragmentIndex: index })
    : undefined;
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
          publishErrorsCounter().add(1, { "org.id": orgId ?? "unknown" });
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
  /**
   * Obtain a JetStream manager. Optional — defaults to `jetstreamManager(nc)`
   * (v3's free function, replacing v2's `nc.jetstreamManager()`). Injectable so
   * tests can supply a mock manager without faking the whole connection (the v3
   * free function introspects the real connection and can't run on a stub).
   */
  getJetStreamManager?: () => Promise<JetStreamManager>;
}

export class NatsStreamBuffer implements StreamBuffer {
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;
  private readonly encoder = new TextEncoder();

  constructor(private readonly options: NatsStreamBufferOptions) {}

  async init(): Promise<void> {
    const nc = this.options.getConnection();
    if (!nc) {
      // Expected once at startup (eager init before NATS connects); the
      // onReady callback re-runs init after connect. If this is the LAST
      // init log with no following "ready", live /stream stays disabled.
      console.log(
        "[Decopilot] StreamBuffer.init skipped: NATS not connected yet",
      );
      return;
    }
    const jsm = this.options.getJetStreamManager
      ? await this.options.getJetStreamManager()
      : await jetstreamManager(nc);

    const config = decopilotStreamConfig();

    try {
      await jsm.streams.info(DECOPILOT_STREAM_NAME);
      await jsm.streams.update(DECOPILOT_STREAM_NAME, config);
    } catch (err: unknown) {
      const isNotFound =
        err instanceof Error && err.message.includes("stream not found");
      if (isNotFound) {
        await jsm.streams.add(config);
      } else {
        // JetStream cannot change a stream's `storage` in place, so flipping the
        // legacy Memory stream to File makes `update` reject. The stream is
        // ephemeral run-scratch (it only holds in-flight chunks), so a one-time
        // delete + add at deploy is safe: drop the old stream and recreate it
        // file-backed. Any other error is real — rethrow.
        const isStorageMismatch =
          err instanceof Error &&
          /can ?not change.*storage|storage type/i.test(err.message);
        if (isStorageMismatch) {
          await jsm.streams.delete(DECOPILOT_STREAM_NAME);
          await jsm.streams.add(config);
        } else {
          throw err;
        }
      }
    }

    this.js = this.options.getJetStream();
    this.jsm = jsm;
    // `getJetStream()` returns null while the connection is mid-(re)connect; a
    // null `js` here means pump/tail will no-op until the next init.
    console.log(
      `[Decopilot] StreamBuffer.init ${this.js ? "ready" : "degraded (js=null)"}`,
    );
  }

  pump(
    stream: ReadableStream,
    taskId: string,
    registrySignal: AbortSignal,
    orgId?: string,
  ): void {
    const js = this.js;
    if (!js) {
      // No JetStream client — every chunk for this run is silently dropped
      // (message still persists upstream). This is the producer side of a
      // "total stream silence, no error" report.
      console.warn(
        `[Decopilot] pump: JetStream client unavailable for thread ${taskId}; chunks NOT published to NATS`,
      );
      return;
    }

    const subj = streamSubject(taskId);
    const tracker = createPublishTracker(taskId, orgId);
    const encoder = this.encoder;

    // This legacy sentinel is UNFENCED (`{done:true}`, no msgId/finalSeq) and
    // exists only so JetStream tails close. The consume step uses the
    // awaited public publishDone(runId, fenceToken, finalSeq) so the durable
    // workflow gets a fence-scoped marker. The DeliverPolicy.All consumer also
    // sees THIS unfenced sentinel, but the consume step's message processor
    // ignores any `{done}` that isn't a proper DoneEnvelope (finalSeq present)
    // — otherwise its bare-runId accumulator key would be empty and it would
    // poison the just-completed run (status=failed).
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
      const t0 = performance.now();
      const bytes = encoder.encode(JSON.stringify({ p: value }));
      const encodeMs = performance.now() - t0;
      encodeMsHistogram().record(encodeMs);
      publishedChunksCounter().add(1, { "org.id": orgId ?? "unknown" });
      streamEncodeProfiler?.record(encodeMs, bytes.length);
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
      let publishedChunks = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          publishChunk(value);
          publishedChunks++;
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
        if (STREAM_TAIL_TRACE) {
          console.warn(
            JSON.stringify({
              msg: "decopilot-stream-diag",
              event: "pump-done",
              taskId,
              publishedChunks,
              publishErrors: tracker.errorCount,
            }),
          );
        }
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
  async publishRawChunk(
    taskId: string,
    chunk: unknown,
    opts?: { msgId?: string },
  ): Promise<boolean> {
    const js = this.js;
    if (!js) return false;
    const subj = streamSubject(taskId);
    // `msgID` is the NATS dedup header field (Nats-Msg-Id): a seq-keyed id lets
    // an at-least-once producer re-publish without double-writing.
    const msgID = opts?.msgId;
    // `ingestRun` (the durable producer) publishes every UI chunk through here,
    // not through `pump()` — so the stream throughput/encode metrics must be
    // recorded on this path or they stay flat zero while streaming works.
    const t0 = performance.now();
    const bytes = this.encoder.encode(JSON.stringify({ p: chunk }));
    encodeMsHistogram().record(performance.now() - t0);
    publishedChunksCounter().add(1);
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
      await js.publish(subj, bytes, msgID ? { msgID } : undefined);
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
      // Per-fragment dedup id keeps re-publishes of a fragmented chunk from
      // doubling up; the fragment index disambiguates the set.
      const fragmentId = fragmentMsgId(msgID, i);
      await js.publish(subj, slice, {
        headers: hdrs,
        ...(fragmentId ? { msgID: fragmentId } : {}),
      });
    }
    return true;
  }

  async publishDone(
    taskId: string,
    fenceToken: string,
    finalSeq: number,
  ): Promise<boolean> {
    const js = this.js;
    if (!js) return false;
    await js.publish(
      streamSubject(taskId),
      this.encoder.encode(JSON.stringify({ done: true, finalSeq })),
      { msgID: buildDoneMsgId({ runId: taskId, fenceToken, finalSeq }) },
    );
    return true;
  }

  async publishCheckpoint(
    taskId: string,
    fenceToken: string,
    headSeq: number,
  ): Promise<boolean> {
    const js = this.js;
    if (!js) return false;
    js.publish(
      streamSubject(taskId),
      this.encoder.encode(JSON.stringify({ checkpoint: true, headSeq })),
      {
        msgID: buildCheckpointMsgId({ runId: taskId, fenceToken, headSeq }),
      },
    ).catch(() => {});
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
    if (!js) {
      // No JetStream client — the caller (/stream → 204, or dispatchRunAndWait
      // → silent direct-drain fallback) gets no tail. Logged here so the
      // consumer-side blind spot isn't silent.
      console.warn(
        `[Decopilot] createTailStream: JetStream client unavailable for thread ${taskId}; no live tail`,
      );
      return null;
    }

    const deliverPolicy =
      opts?.deliverPolicy === "new" ? DeliverPolicy.New : DeliverPolicy.All;
    const closeOnDone = opts?.closeOnDone ?? false;
    const subj = streamSubject(taskId);

    let sub;
    try {
      // v3 ordered (ephemeral, no-ack) consumer over this run's subject. The
      // replacement for v2's removed `js.subscribe(..., {ordered:true})` push
      // consumer: same delivery semantics, but driven via the consumer API.
      const consumer = await js.consumers.get(DECOPILOT_STREAM_NAME, {
        filter_subjects: subj,
        deliver_policy: deliverPolicy,
      });
      sub = await consumer.consume();
    } catch (err) {
      console.warn(
        "[Decopilot] JetStream tail unavailable (non-critical):",
        (err as Error)?.message ?? err,
      );
      return null;
    }

    const source = natsChunkSource({
      messages: (async function* () {
        try {
          for await (const msg of sub) {
            yield {
              subject: msg.subject,
              data: msg.data,
              headers: msg.headers,
            } as RawMsg;
          }
        } finally {
          sub.stop();
        }
      })(),
      // no idle timeout: the tail stays open across silent gaps and spans runs
      onCancel: () => sub.stop(),
    });

    const events = source
      .pipeThrough(reassembleFragments())
      .pipeThrough(unwrapPayload());

    const reader = events.getReader();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      reader.releaseLock();
    };
    const cleanup = () => {
      sub.stop();
      reader.cancel().catch(() => {});
      release();
    };
    signal?.addEventListener("abort", cleanup, { once: true });

    return new ReadableStream({
      async pull(controller) {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) {
            cleanup();
            controller.close();
            return;
          }
          const ev = value;
          if (ev.kind === "done") {
            if (closeOnDone) {
              cleanup();
              controller.close();
              return;
            }
            // A run ended, but the subscription stays open for the next run on
            // this thread. Clients detect run boundaries from the AI-SDK
            // `{type:"finish"}` chunk in the data stream, not the JetStream
            // sentinel — so we swallow it here.
            continue;
          }
          if (ev.kind === "checkpoint") continue; // not part of the UI data stream
          controller.enqueue(ev.chunk);
          return;
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
      .purge(DECOPILOT_STREAM_NAME, { filter: streamSubject(taskId) })
      .catch(() => {});
  }

  teardown(): void {
    this.js = null;
    this.jsm = null;
  }
}
