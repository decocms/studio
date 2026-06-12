/**
 * Durable explicit-ack JetStream projector consumer (spec §5.4) — the standalone
 * DB-writer. It reads raw `{p: chunk}` / `{done: true}` envelopes from
 * DECOPILOT_STREAMS (subject `decopilot.stream.<runId>`), accumulates per run,
 * and on the terminal sentinel hands the run's chunks to projectRun for
 * persistence (bounded retry + DLQ).
 *
 * The pure accumulation/ack/poison policy (`consumeProjectorMessages`) is
 * unit-testable via an injected message iterable. The NATS binding
 * (`createDurableProjectorConsumer`) is thin + integration-only (multi-pod e2e).
 *
 * DOUBLE-WRITER GATE: this is the §5.4 "independent consumer" topology. It must
 * only run when the inline projector (consumeRelayedRun) is NOT also persisting.
 * app.ts wires it behind a default-off LINK_DURABLE_PROJECTOR flag; the cutover
 * (inline path stops persisting + flag on) is validated by multi-pod e2e before
 * it becomes the sole DB-writer.
 */
import type { UIMessageChunk } from "ai";
import {
  AckPolicy,
  DeliverPolicy,
  type JetStreamClient,
  type JetStreamManager,
} from "nats";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { projectRun } from "./project-run";

const STREAM_NAME = "DECOPILOT_STREAMS";
const CONSUMER_NAME = "decopilot-projector";
const FILTER_SUBJECT = "decopilot.stream.>";

/** Extract the run id token from `decopilot.stream.<runId>`; null if malformed. */
export function runIdFromSubject(subject: string): string | null {
  const parts = subject.split(".");
  if (parts.length < 3 || parts[0] !== "decopilot" || parts[1] !== "stream") {
    return null;
  }
  const runId = parts.slice(2).join(".");
  return runId.length > 0 ? runId : null;
}

export interface ProjectorMessage {
  /** NATS subject (`decopilot.stream.<runId>`). */
  subject: string;
  data: Uint8Array;
  ack(): Promise<void>;
  term(): Promise<void>;
}

export interface ProjectorConsumerOptions {
  /** Source of decoded messages (injected — a NATS consumer in prod, a fake in tests). */
  messages: AsyncIterable<ProjectorMessage>;
  /** Per-run persistence callbacks (the PartEmitter triplet) for projectRun. */
  persistenceFor: (runId: string) => HarnessStreamPersistence;
  /** Fired when a run is poisoned (projectRun exhausts retries). Must not throw. */
  onRunErrored: (runId: string, error: unknown) => Promise<void>;
}

interface RunAccumulator {
  chunks: UIMessageChunk[];
}

/**
 * Pure accumulation + ack/poison policy. Accumulate `{p}` chunks per runId; on
 * `{done}` project the run via projectRun. Every message is acked (poison runs
 * too — projectRun's onDlq marks them failed; redelivery would just wedge the
 * consumer on a bad run). Malformed messages are skipped + acked.
 */
export async function consumeProjectorMessages(
  options: ProjectorConsumerOptions,
): Promise<void> {
  const runs = new Map<string, RunAccumulator>();
  const decoder = new TextDecoder();

  for await (const msg of options.messages) {
    try {
      const runId = runIdFromSubject(msg.subject);
      if (!runId) {
        await msg.ack();
        continue;
      }
      const payload = JSON.parse(decoder.decode(msg.data)) as {
        p?: unknown;
        done?: boolean;
      };

      if (payload.done) {
        const run = runs.get(runId);
        runs.delete(runId);
        const result = await projectRun({
          runId,
          chunks: run?.chunks ?? [],
          persistence: options.persistenceFor(runId),
          onDlq: async (id, error) => {
            await options.onRunErrored(id, error);
          },
        });
        void result; // ok|poison both ack; poison is surfaced via onDlq above
        await msg.ack();
      } else if (payload.p !== undefined) {
        let run = runs.get(runId);
        if (!run) {
          run = { chunks: [] };
          runs.set(runId, run);
        }
        run.chunks.push(payload.p as UIMessageChunk);
        await msg.ack();
      } else {
        await msg.ack();
      }
    } catch (error) {
      // Malformed/undecodable message — ack to avoid wedging the consumer.
      console.error("[projector-consumer] skipping bad message:", error);
      await msg.ack();
    }
  }
}

/**
 * Thin NATS binding: ensure the durable explicit-ack consumer exists on
 * DECOPILOT_STREAMS (same pattern as link-work-queue.ts) and return a handle
 * that drives `consumeProjectorMessages`. Integration-only (multi-pod e2e); the
 * pure policy above is the unit boundary.
 */
export async function createDurableProjectorConsumer(
  jsm: JetStreamManager,
  js: JetStreamClient,
): Promise<{
  start(opts: Omit<ProjectorConsumerOptions, "messages">): Promise<void>;
}> {
  try {
    await jsm.consumers.add(STREAM_NAME, {
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
      const consumer = await js.consumers.get(STREAM_NAME, CONSUMER_NAME);
      const sub = await consumer.consume();
      const messages = (async function* () {
        for await (const m of sub) {
          yield {
            subject: m.subject,
            data: m.data,
            ack: async () => m.ack(),
            term: async () => m.term(),
          } satisfies ProjectorMessage;
        }
      })();
      await consumeProjectorMessages({ ...opts, messages });
    },
  };
}
