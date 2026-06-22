/**
 * Durable explicit-ack JetStream projector SCHEDULER (spec §5.4). It reads raw
 * `{p: chunk}` / `{done: true, finalSeq}` envelopes from DECOPILOT_STREAMS
 * (subject `decopilot.stream.<runId>`) and, on an AUTHORITATIVE fenced done
 * marker, enqueues a DBOS projection workflow (`enqueueProjectRun`) keyed by
 * (runId, fenceToken). It NO LONGER accumulates chunks or projects inline — the
 * durable `projectRunWorkflow` reconstructs the run from file-backed JetStream
 * and writes parts/title/terminal status. The consumer is now a thin scheduler:
 *
 *  - `{p}` chunks and non-authoritative messages are acked-and-skipped (the
 *    workflow re-reads them from JetStream, so the consumer keeps none).
 *  - A fenced `{done, finalSeq}` (msgId `<runId>:<fence>:done:<N>`) schedules the
 *    projection workflow and is acked ONLY after `enqueueProjectRun` succeeds. If
 *    enqueue throws, the message is left unacked so JetStream redelivers it after
 *    the ack wait — the workflow ID dedups duplicate scheduler starts.
 *  - The pump's legacy unfenced `{done:true}` (no msgId, no finalSeq) is purely a
 *    tail-close signal and is ignored (acked-and-skipped).
 *
 * The pure scheduling/ack policy (`consumeProjectorMessages`) is unit-testable
 * via an injected message iterable. The NATS binding
 * (`createDurableProjectorConsumer`) is thin + integration-only (multi-pod e2e).
 *
 * SINGLE WRITER: every pod runs a consumer. The durable pull consumer
 * distributes each done marker to exactly one pod (competing consumers), and the
 * DBOS workflow ID keyed by (runId, fenceToken) dedups any redelivery overlap,
 * so duplicate scheduler starts collapse instead of double-projecting. No leader
 * election; multi-pod e2e validates redelivery/replay.
 */
import {
  AckPolicy,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
} from "@nats-io/jetstream";
import { computeLagMs, recordLag } from "./projector-metrics";
import {
  DECOPILOT_STREAM_NAME,
  isCheckpointEnvelope,
  isDoneEnvelope,
  parseRunStreamMsgId,
  runIdFromSubject,
} from "./projector-stream-messages";
import type {
  ProjectorCheckpointInput,
  ProjectorWorkflowInput,
} from "./projector-workflow";

// Re-exported so existing importers can keep resolving `runIdFromSubject` from
// this module; the implementation lives in the shared identity helper.
export { runIdFromSubject } from "./projector-stream-messages";

const CONSUMER_NAME = "decopilot-projector";
const FILTER_SUBJECT = "decopilot.stream.>";

export interface ProjectorMessage {
  /** NATS subject (`decopilot.stream.<runId>`). */
  subject: string;
  data: Uint8Array;
  /**
   * The publisher-supplied `Nats-Msg-Id` (`<runId>:<fenceToken>:<seq>` for
   * chunks, `<runId>:<fenceToken>:done:<N>` for the authoritative done marker).
   * Used to extract the fence token + finalSeq for the projection workflow.
   * Optional for back-compat: a message without it is acked-and-skipped.
   */
  msgId?: string;
  /**
   * JetStream publish time in ms (`msg.info.timestampNanos / 1e6`). Optional:
   * the fake iterable used in unit tests may omit it, in which case lag is not
   * recorded for that message.
   */
  publishedAtMs?: number;
  ack(): Promise<void>;
  term(): Promise<void>;
}

export interface ProjectorConsumerOptions {
  /** Source of decoded messages (injected — a NATS consumer in prod, a fake in tests). */
  messages: AsyncIterable<ProjectorMessage>;
  /** Resolve a run's org id (a global threads lookup). Null → unknown run. */
  resolveOrgId: (runId: string) => Promise<string | null>;
  /** Schedule the durable projection workflow for a completed run. */
  enqueueProjectRun: (
    input: ProjectorWorkflowInput & { orgId: string },
  ) => Promise<unknown>;
  /**
   * Schedule a non-terminal checkpoint projection pass. Optional: only wired
   * when incremental projection is enabled (Task 10). When absent, checkpoint
   * markers are acked-and-skipped (the terminal `done` pass still projects the
   * whole run, so correctness is preserved when the feature is off).
   */
  enqueueProjectCheckpoint?: (
    input: ProjectorCheckpointInput,
  ) => Promise<unknown>;
}

/**
 * Pure scheduling + ack policy. Ack-and-skip everything that is not an
 * AUTHORITATIVE fenced done marker; on a valid done marker, schedule the
 * projection workflow and ack only after `enqueueProjectRun` succeeds. If
 * scheduling throws the message is left UNACKED so JetStream redelivers it.
 */
export async function consumeProjectorMessages(
  options: ProjectorConsumerOptions,
): Promise<void> {
  const decoder = new TextDecoder();

  for await (const msg of options.messages) {
    try {
      if (msg.publishedAtMs !== undefined) {
        recordLag(computeLagMs(msg.publishedAtMs, Date.now()));
      }
      const runId = runIdFromSubject(msg.subject);
      if (!runId) {
        await msg.ack();
        continue;
      }
      const payload = JSON.parse(decoder.decode(msg.data)) as unknown;
      if (isCheckpointEnvelope(payload)) {
        if (options.enqueueProjectCheckpoint) {
          const parsed = parseRunStreamMsgId(msg.msgId);
          if (
            parsed &&
            parsed.kind === "checkpoint" &&
            parsed.runId === runId &&
            parsed.headSeq === payload.headSeq
          ) {
            const orgId = await options.resolveOrgId(runId);
            if (orgId) {
              await options.enqueueProjectCheckpoint({
                runId,
                fenceToken: parsed.fenceToken,
                headSeq: payload.headSeq,
                orgId,
              });
            }
          }
        }
        await msg.ack();
        continue;
      }
      if (!isDoneEnvelope(payload)) {
        await msg.ack();
        continue;
      }
      const parsed = parseRunStreamMsgId(msg.msgId);
      if (
        !parsed ||
        parsed.kind !== "done" ||
        parsed.runId !== runId ||
        parsed.finalSeq !== payload.finalSeq
      ) {
        console.error("[projector-consumer] invalid done marker", {
          subject: msg.subject,
          msgId: msg.msgId,
        });
        await msg.ack();
        continue;
      }
      const orgId = await options.resolveOrgId(runId);
      if (!orgId) {
        console.warn("[projector-consumer] done for unknown run", { runId });
        await msg.ack();
        continue;
      }
      await options.enqueueProjectRun({
        runId,
        fenceToken: parsed.fenceToken,
        finalSeq: parsed.finalSeq,
        orgId,
      });
      await msg.ack();
    } catch (error) {
      console.error("[projector-consumer] scheduling failed:", error);
      // Do not ack. JetStream redelivers the done marker after ack wait.
    }
  }
}

/**
 * Handle for a running durable projector consumer. `stop()` aborts the underlying
 * `consumer.consume()` iterator so leadership loss can hand off cleanly (the
 * consumption loop returns once the iterator is stopped).
 */
export interface DurableProjectorConsumerHandle {
  stop(): Promise<void>;
}

/**
 * Thin NATS binding: ensure the durable explicit-ack consumer exists on
 * DECOPILOT_STREAMS and return a handle that drives `consumeProjectorMessages`.
 * Integration-only (multi-pod e2e); the pure policy above is the unit boundary.
 */
export async function createDurableProjectorConsumer(
  jsm: JetStreamManager,
  js: JetStreamClient,
): Promise<{
  start(
    opts: Omit<ProjectorConsumerOptions, "messages">,
  ): Promise<DurableProjectorConsumerHandle>;
}> {
  try {
    await jsm.consumers.add(DECOPILOT_STREAM_NAME, {
      name: CONSUMER_NAME,
      durable_name: CONSUMER_NAME,
      filter_subject: FILTER_SUBJECT,
      ack_policy: AckPolicy.Explicit,
      deliver_policy: DeliverPolicy.All,
    });
  } catch (err: unknown) {
    const exists =
      err instanceof Error &&
      (err.message.includes("already in use") ||
        err.message.includes("already exists"));
    if (!exists) throw err;
  }

  return {
    async start(opts) {
      const consumer = await js.consumers.get(
        DECOPILOT_STREAM_NAME,
        CONSUMER_NAME,
      );
      const sub = await consumer.consume();
      const messages = (async function* () {
        for await (const m of sub) {
          yield {
            subject: m.subject,
            data: m.data,
            msgId: m.headers?.get("Nats-Msg-Id") || undefined,
            // v3: JsMsg.info.timestampNanos is a bigint — convert before
            // dividing (bigint / number throws "Cannot mix BigInt").
            publishedAtMs: Number(m.info.timestampNanos) / 1e6,
            ack: async () => m.ack(),
            term: async () => m.term(),
          } satisfies ProjectorMessage;
        }
      })();
      // Run the consumption loop in the background so the caller gets a handle
      // it can stop on leadership loss. `sub.stop()` ends the iterator, which
      // lets `consumeProjectorMessages` return and the promise settle.
      const done = consumeProjectorMessages({ ...opts, messages }).catch(
        (err: unknown) => {
          console.error("[projector-consumer] consumption loop failed", err);
        },
      );
      return {
        async stop() {
          sub.stop();
          await done;
        },
      };
    },
  };
}
