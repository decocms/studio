/**
 * Hosted-executor liveness heartbeat (unified-control-plane T5).
 *
 * Wraps the hosted harness's raw `AsyncIterable<UIMessageChunk>` (the source
 * `buildAgentSandboxUiStream` in `dispatch-run.ts` feeds into `ingestRun` via
 * its seq-wrapper) so a `data-liveness` chunk is injected whenever
 * `LIVENESS_HEARTBEAT_INTERVAL_MS` (30s) elapses with no real chunk from the
 * harness — the agent loop awaiting a model response, or a long tool call
 * with no incremental output.
 *
 * MUST wrap the source BEFORE `buildAgentSandboxUiStream`'s `seqChunks()`
 * wrapper (this is why the call site passes `withLivenessHeartbeat(...)` as
 * the `chunks` input, not something layered after `ingestRun`): the
 * heartbeat needs to flow through the exact same pipeline every other chunk
 * does (`seqChunks` → `ingestRun`'s dedup/publish → JetStream) so it
 * consumes a REAL seq. That's what makes it participate in the dedup
 * contract (`${runId}:${fenceToken}:${seq}` `Nats-Msg-Id`) and — critically —
 * what resets `natsChunkSource`'s per-pull idle race on the projector's
 * consume side (unified-control-plane T4): ANY message arriving at that
 * layer restarts the idle window, and this heartbeat is just another message
 * on the subject from that layer's point of view.
 *
 * Wire representation: `{ type: "data-liveness", data: { t }, transient: true }`.
 * `transient: true` is a first-class AI SDK `UIMessageChunk` field (see the
 * installed `ai` package's `DataUIMessageChunk` type) that the SDK's OWN
 * shared stream reducer (`processUIMessageStream`, used identically by the
 * CLIENT's `readUIMessageStream` — see `store/thread-connection.ts` — AND
 * the SERVER's `consumeHarnessStream`/`project-chunks.ts`, both server-side
 * consumers built on `createUIMessageStream`) honors by calling the
 * consumer's `onData` hook (unused here) and explicitly NOT pushing the
 * chunk into the accumulated `UIMessage.parts` array. Concretely, verified
 * against the installed `ai@6.0.208` package source
 * (`node_modules/ai/dist/index.js`, the `isDataUIMessageChunk` branch):
 *   - CLIENT fold: never renders it — `state.message.parts` never gets a
 *     `data-liveness` entry, so the chat UI has no bubble to suppress. (Two
 *     redundant defenses ALSO already exist independently of `transient` —
 *     `message/use-filter-parts.ts`'s `p.type.startsWith("data-")` skip and
 *     `message/assistant.tsx`'s `MessagePart` default-case
 *     `fallback.type.startsWith("data-") → return null` — so even a
 *     hypothetical non-transient data chunk would render nothing.)
 *   - PROJECTOR fold: `project-chunks.ts`'s `consumeHarnessStream` call uses
 *     the SAME reducer, so `responseMessage.parts` passed to
 *     `persistence.emitStepParts`/`emitFinal` (the durable `PartEmitter`
 *     write path, `run-persistence.ts`) never contains a `data-liveness`
 *     entry either — no DB row is written per heartbeat. This holds without
 *     needing an explicit `isRunStatusControlChunk`-style filter (that
 *     existing filter is required for `data-run-status`, which is NOT
 *     transient); `transient: true` alone is sufficient here and is the
 *     more precise tool for a chunk that must never become a message part.
 *   - The raw chunk is still `controller.enqueue`d by the reducer regardless
 *     of `transient` (only the accumulated-parts push is skipped), so it
 *     still reaches JetStream / the live tail / the idle-window reset above
 *     — only the "becomes a persisted or rendered message part" step is
 *     suppressed.
 */
import type { UIMessageChunk } from "ai";
import {
  HeartbeatEmitter,
  type HeartbeatEmitterOptions,
  buildLivenessChunk as buildSharedLivenessChunk,
} from "@/harnesses/lib/liveness-heartbeat";

export type DataLivenessChunk = Extract<
  UIMessageChunk,
  { type: `data-${string}` }
> & {
  type: "data-liveness";
  data: { t: number };
  transient: true;
};

/** Builds one `data-liveness` chunk. `now` is injectable for tests.
 * Delegates to the shared wire-shape source of truth so the hosted and
 * desktop emitters can never drift; this wrapper only re-asserts the
 * stronger `ai`-typed shape (see LivenessDataChunk's doc in the helper). */
export function buildLivenessChunk(
  now: () => number = Date.now,
): DataLivenessChunk {
  return buildSharedLivenessChunk(now) as DataLivenessChunk;
}

export interface WithLivenessHeartbeatOptions {
  intervalMs?: number;
  sleepFn?: HeartbeatEmitterOptions["sleepFn"];
  now?: () => number;
}

/**
 * See module doc above. A real chunk from `source` resets the silence
 * window (re-arms the emitter); the emitter self-reschedules after every
 * heartbeat, so a single long-silent tool call yields several heartbeats,
 * not just one. Stops cleanly — no dangling timer, no late emit — when the
 * source completes, throws, or the consumer stops pulling early (`.return()`
 * on this generator, e.g. from a `for await` `break` upstream).
 */
export async function* withLivenessHeartbeat(
  source: AsyncIterable<UIMessageChunk>,
  opts: WithLivenessHeartbeatOptions = {},
): AsyncGenerator<UIMessageChunk> {
  const buildHeartbeat = () => buildLivenessChunk(opts.now);
  let resolveHeartbeat: (() => void) | null = null;
  const emitter = new HeartbeatEmitter({
    intervalMs: opts.intervalMs,
    sleepFn: opts.sleepFn,
    emit: () => resolveHeartbeat?.(),
  });
  const iterator = source[Symbol.asyncIterator]();
  let nextChunk = iterator.next();
  try {
    emitter.arm();
    while (true) {
      const heartbeat = new Promise<"heartbeat">((resolve) => {
        resolveHeartbeat = () => resolve("heartbeat");
      });
      const winner = await Promise.race([
        nextChunk.then((r) => ({ kind: "chunk" as const, r })),
        heartbeat.then((kind) => ({ kind })),
      ]);
      resolveHeartbeat = null;
      if (winner.kind === "heartbeat") {
        yield buildHeartbeat();
        continue; // keep racing the SAME pending nextChunk
      }
      // Real chunk arrived: push the next heartbeat window out from now.
      emitter.arm();
      if (winner.r.done) return;
      yield winner.r.value;
      nextChunk = iterator.next();
    }
  } finally {
    emitter.stop();
    await iterator.return?.(undefined).catch(() => {});
  }
}
