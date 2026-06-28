import { AckPolicy } from "@nats-io/jetstream";
import { sleep } from "@decocms/std";
import {
  isCheckpointEnvelope,
  isDoneEnvelope,
  parseRunStreamMsgId,
  DECOPILOT_STREAM_NAME,
  streamSubject,
} from "./projector-stream-messages";
import {
  getProjectorWorkflowRuntime,
  projectCheckpointFromJetStreamStep,
  projectFromJetStreamStep,
  runProjectorWorkflowBody,
} from "./projector-workflow";

/** Statuses on which the consume step's entry guard returns — consume is the
 *  sole writer of these, so a terminal status means projection already finished. */
export function isTerminalStatus(status: string): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "requires_action"
  );
}

export function consumeDurableName(runId: string): string {
  return `decopilot-consume:${runId}`;
}

export type DrainAction = "checkpoint" | "done" | "skip";

/** Classify a drained message: the envelope decides kind, the msgId carries fence
 *  + seq, and both must agree. A marker from a different fence is `skip`. */
export function classifyDrainMessage(
  payload: unknown,
  msgId: string | undefined,
  runId: string,
  fenceToken: string,
): DrainAction {
  if (isCheckpointEnvelope(payload)) {
    const p = parseRunStreamMsgId(msgId);
    return p &&
      p.kind === "checkpoint" &&
      p.runId === runId &&
      p.fenceToken === fenceToken &&
      p.headSeq === payload.headSeq
      ? "checkpoint"
      : "skip";
  }
  if (isDoneEnvelope(payload)) {
    const p = parseRunStreamMsgId(msgId);
    return p &&
      p.kind === "done" &&
      p.runId === runId &&
      p.fenceToken === fenceToken &&
      p.finalSeq === payload.finalSeq
      ? "done"
      : "skip";
  }
  return "skip";
}

const ACK_WAIT_NS = 5 * 60 * 1_000_000_000;
const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60_000;
const IDLE = Symbol("idle");

export interface ConsumeRunProjectionOptions {
  runId: string;
  idleTimeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Per-run consume step (DBOS step body). Binds the run's durable JetStream
 * consumer, drains it, projects (reusing the fold engine), and is the SOLE
 * terminal-status writer. Entry guard returns on a terminal status (recovery).
 * Runs for the whole run — must be a DBOS step WITHOUT a timeout.
 *
 * JetStream iteration: uses manual `iterator.next()` + `Promise.race` against
 * an idle `sleep` to implement the dead-producer idle-timeout watchdog.
 * `ConsumerMessages` is a `QueuedIterator<JsMsg>` (nats-core type), which
 * exposes `[Symbol.asyncIterator]()` returning a standard `AsyncIterator<T>`.
 * Calling `.next()` once per loop iteration is safe: on the idle branch we
 * return immediately (the pending `.next()` is abandoned but the consumer is
 * deleted in `finally` so no leak), and on the message branch the idle sleep
 * is cancelled via `idleCtl.abort()` before the next iteration. This is the
 * same manual-pull pattern used by `createTailStream` in `nats-stream-buffer.ts`.
 */
export async function consumeRunProjection(
  opts: ConsumeRunProjectionOptions,
): Promise<void> {
  const { runId } = opts;
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const rt = getProjectorWorkflowRuntime();

  const row = await rt.resolveRun(runId);
  if (!row || row.version !== 2 || row.runFenceToken == null) return;
  const fenceToken = row.runFenceToken;
  const orgId = row.orgId;
  if (isTerminalStatus(row.status)) return; // recovery: we already finished this run

  const js = rt.getJetStream();
  const jsm = await rt.getJetStreamManager();
  if (!js || !jsm) throw new Error("JetStream unavailable for consume step");

  const durable = consumeDurableName(runId);
  try {
    await jsm.consumers.add(DECOPILOT_STREAM_NAME, {
      name: durable,
      durable_name: durable,
      filter_subject: streamSubject(runId),
      ack_policy: AckPolicy.Explicit,
      ack_wait: ACK_WAIT_NS,
    });
  } catch (err: unknown) {
    const exists =
      err instanceof Error &&
      (err.message.includes("already in use") ||
        err.message.includes("already exists"));
    if (!exists) throw err;
  }

  const decoder = new TextDecoder();
  try {
    const consumer = await js.consumers.get(DECOPILOT_STREAM_NAME, durable);
    const iterator = (await consumer.consume())[Symbol.asyncIterator]();
    for (;;) {
      if (opts.signal?.aborted) return;
      // Idle watchdog: dead-producer backstop. Only fires when the producer
      // (child workflow / daemon) stalls — entry guard already handled terminal.
      const idleCtl = new AbortController();
      const next = iterator.next().then((r) => {
        idleCtl.abort();
        return r;
      });
      const idle = sleep(idleTimeoutMs, { signal: idleCtl.signal })
        .then(() => IDLE)
        .catch(() => IDLE);
      const winner = await Promise.race([next, idle]);
      if (winner === IDLE) {
        await rt.markRunFailed(
          runId,
          orgId,
          "producer produced no output before timeout",
          "transport",
        );
        return;
      }
      const result = winner as IteratorResult<
        import("@nats-io/jetstream").JsMsg
      >;
      if (result.done) return;
      const msg = result.value;

      // `JsMsg` carries `Nats-Msg-Id` as a header (no direct `.msgId` property).
      const msgId = msg.headers?.get("Nats-Msg-Id") || undefined;

      let payload: unknown;
      try {
        payload = JSON.parse(decoder.decode(msg.data));
      } catch {
        await msg.ack();
        continue;
      } // fragmented chunk byte-slice — not JSON

      const action = classifyDrainMessage(payload, msgId, runId, fenceToken);
      if (action === "checkpoint") {
        const headSeq = (payload as { headSeq: number }).headSeq;
        const { projected } = await projectCheckpointFromJetStreamStep(
          { runId, fenceToken, headSeq, orgId },
          row.title,
        );
        if (projected) await rt.bumpProgress({ runId, orgId });
        await msg.ack();
        continue;
      }
      if (action === "done") {
        const finalSeq = (payload as { finalSeq: number }).finalSeq;
        // Reuse the terminal orchestrator (Task 3): project parts/title, map
        // finish-reason → status, write it (sole writer), record + purge.
        await runProjectorWorkflowBody(
          { runId, fenceToken, finalSeq },
          rt,
          projectFromJetStreamStep,
        );
        await msg.ack();
        return;
      }
      await msg.ack(); // plain chunk / stale-fence marker
    }
  } finally {
    await jsm.consumers.delete(DECOPILOT_STREAM_NAME, durable).catch(() => {});
  }
}
