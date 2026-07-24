/**
 * NATS JetStream Stream Buffer
 *
 * The per-task JetStream subject is the source of truth for a run's UI
 * stream. The producer (`dispatchRunAndWait`) calls `pump()` once; tail
 * consumers (every `/stream` HTTP response) call `createTailStream()`. The
 * pump is decoupled from any consumer, so an HTTP cancel never stalls the
 * producer or drops chunks.
 *
 * - Per-subject message limit (500K msgs/subject) prevents one thread
 *   from starving others.
 * - Per-thread publish error tracking with sampled logging.
 * - `purge()` is owned by the projector: `runProjectorWorkflowBody` purges a
 *   run's subject after a terminal projection, and `dispatchRun` purges the
 *   previous turn's remnants at turn start. Nothing may purge a subject the
 *   consume step hasn't projected yet (it needs the contiguous seq 1..N log);
 *   the 24h `max_age` is the backstop for never-projected runs.
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
import { retry } from "@decocms/shared/std";
import { DECOPILOT_STREAM_NAME } from "./projector-stream-messages";
import type { StreamBuffer } from "./stream-buffer";
import { natsChunkSource } from "./nats-chunk-source";
import {
  decodeStream,
  DECOPILOT_STREAM_SUBJECT_PREFIX,
  reassembleFragments,
  serializeChunk,
  serializeDone,
  serializeUnfencedDone,
  streamSubject,
  type RawMsg,
} from "@decocms/harness/run-stream-codec";
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

function toMsgHdrs(rec: Record<string, string>): MsgHdrs {
  const hdrs = natsHeaders();
  for (const [k, v] of Object.entries(rec)) {
    hdrs.set(k, v);
  }
  return hdrs;
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

/**
 * A JetStream management round-trip that failed transiently (server briefly
 * slow / mid-election / no responders yet) rather than because the request is
 * semantically wrong. Only these are worth retrying — a bad stream config would
 * fail identically every attempt.
 */
function isTransientJsApiError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError") return true;
  return /timeout|no responders|503/i.test(err.message);
}

export class NatsStreamBuffer implements StreamBuffer {
  private js: JetStreamClient | null = null;
  private jsm: JetStreamManager | null = null;

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
    const config = decopilotStreamConfig();

    // The JS-API round-trips below (manager handshake + stream ensure) can time
    // out transiently if JetStream is briefly slow at boot. Init only re-runs on
    // a NATS `onReady` (reconnect); when the connection stays up, a single
    // startup timeout would otherwise leave `this.js` null for the pod's whole
    // life — every run then fails at `publishRawChunk`. Retry the transient
    // failures in place instead of relying on a reconnect that may never come.
    const jsm = await retry(
      async () => {
        const mgr = this.options.getJetStreamManager
          ? await this.options.getJetStreamManager()
          : await jetstreamManager(nc);
        try {
          await mgr.streams.info(DECOPILOT_STREAM_NAME);
          await mgr.streams.update(DECOPILOT_STREAM_NAME, config);
        } catch (err: unknown) {
          const isNotFound =
            err instanceof Error && err.message.includes("stream not found");
          if (isNotFound) {
            await mgr.streams.add(config);
          } else {
            // JetStream cannot change a stream's `storage` in place, so flipping
            // the legacy Memory stream to File makes `update` reject. The stream
            // is ephemeral run-scratch (it only holds in-flight chunks), so a
            // one-time delete + add at deploy is safe: drop the old stream and
            // recreate it file-backed. Any other error is real — rethrow.
            const isStorageMismatch =
              err instanceof Error &&
              /can ?not change.*storage|storage type/i.test(err.message);
            if (isStorageMismatch) {
              await mgr.streams.delete(DECOPILOT_STREAM_NAME);
              await mgr.streams.add(config);
            } else {
              throw err;
            }
          }
        }
        return mgr;
      },
      {
        maxAttempts: 5,
        minTimeout: 250,
        maxTimeout: 4000,
        jitter: 0.5,
        isRetriable: isTransientJsApiError,
      },
    );

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
  ): Promise<void> {
    const js = this.js;
    if (!js) {
      // No JetStream client — every chunk for this run is silently dropped
      // (message still persists upstream). This is the producer side of a
      // "total stream silence, no error" report.
      console.warn(
        `[Decopilot] pump: JetStream client unavailable for thread ${taskId}; chunks NOT published to NATS`,
      );
      return Promise.resolve();
    }

    const tracker = createPublishTracker(taskId, orgId);

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
      const m = serializeUnfencedDone(taskId);
      js.publish(m.subject, m.data).catch(() => {});
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
      const msgs = serializeChunk(value, { runId: taskId });
      const encodeMs = performance.now() - t0;
      encodeMsHistogram().record(encodeMs);
      publishedChunksCounter().add(1, { "org.id": orgId ?? "unknown" });
      streamEncodeProfiler?.record(
        encodeMs,
        msgs.reduce((n, m) => n + m.data.length, 0),
      );
      if (msgs.length === 0) {
        console.warn(
          `[Decopilot] dropping oversized stream chunk for thread ${taskId}`,
        );
        return;
      }
      for (const m of msgs) {
        tracker.publish(
          js,
          m.subject,
          m.data,
          m.headers ? toMsgHdrs(m.headers) : undefined,
        );
      }
    };

    return (async () => {
      const reader = stream.getReader();
      let sinceYield = 0;
      let publishedChunks = 0;
      // Captured, not swallowed: a mid-stream failure (e.g. the
      // `buildAgentSandboxUiStream` vessel erroring because `ingestRun` threw)
      // still publishes the legacy unfenced `{done}` below so any tail
      // consumer closes cleanly, but the caller (`dispatchRunAndWait`) needs
      // to learn about the failure too — awaiting the promise this function
      // now returns surfaces it instead of the caller reading a false
      // "the tail saw {done}, so the run finished cleanly" signal.
      let caught: unknown;
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
        caught = err;
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
      if (caught !== undefined) throw caught;
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
    dedup?: { fenceToken: string; seq: number },
  ): Promise<boolean> {
    const js = this.js;
    if (!js) return false;
    const t0 = performance.now();
    const msgs = serializeChunk(chunk, { runId: taskId, dedup });
    // `ingestRun` (the durable producer) publishes every UI chunk through here,
    // not through `pump()` — so the stream throughput/encode metrics must be
    // recorded on this path or they stay flat zero while streaming works.
    encodeMsHistogram().record(performance.now() - t0);
    publishedChunksCounter().add(1);
    if (msgs.length === 0) {
      console.warn(
        `[Decopilot] dropping oversized raw chunk for thread ${taskId} (> MAX_CHUNKED_BYTES)`,
      );
      // Dropped, but the publish "succeeded" as far as the ack cursor is
      // concerned — refusing to advance would wedge the run on a pathological
      // chunk (loud-fail is the daemon-outbox cap's job, not ingest's).
      return true;
    }
    for (const m of msgs) {
      await js.publish(m.subject, m.data, {
        ...(m.headers ? { headers: toMsgHdrs(m.headers) } : {}),
        ...(m.msgId ? { msgID: m.msgId } : {}),
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
    const m = serializeDone({ runId: taskId, fenceToken, finalSeq });
    await js.publish(m.subject, m.data, { msgID: m.msgId });
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

    // Pure pass-through: NATS log → reassemble fragments → decode to
    // UIMessageChunks. NO server-side fence-filter or reassembly — the tail
    // forwards every run's chunks verbatim and the client (useChat) is the sole
    // reassembler. A continuation run's tool-output reconciles because the
    // client seeds the reassembler from the proposal (see thread-connection.ts).
    const decoded = source
      .pipeThrough(reassembleFragments())
      .pipeThrough(decodeStream());

    const reader = decoded.getReader();
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      try {
        reader.releaseLock();
      } catch {
        // Per the WHATWG spec, releaseLock() throws if a read is pending — and
        // cleanup() can fire from the abort handler while pull() is suspended on
        // reader.read(). That pending read settles via the cancel() above, so
        // the throw is benign (Bun tolerates it; this guard keeps stricter
        // runtimes from surfacing an uncaught TypeError).
      }
    };
    let cleaned = false;
    const cleanup = () => {
      if (cleaned) return;
      cleaned = true;
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
