/**
 * Cluster-startup wiring for the durable projector consumer (spec §5.4).
 *
 * Builds the per-run persistence the standalone DB-writer needs and starts the
 * durable JetStream consumer. The NATS subject carries only the runId, so we
 * resolve the run's org + storage version lazily (on first emit) via an injected
 * resolver — the durable projector only persists v2 (PartEmitter) runs; v1 stays
 * the inline path's domain. Gated default-off in app.ts behind
 * LINK_DURABLE_PROJECTOR so it never double-writes with the inline projector
 * until the cutover is validated by multi-pod e2e.
 *
 * Integration-only (real NATS + storage); the pure accumulation/ack policy is
 * unit-tested in projector-consumer.test.ts.
 */
import type { JetStreamClient, JetStreamManager } from "nats";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import { PartEmitter } from "./part-emitter";
import { createDurableProjectorConsumer } from "./projector-consumer";

export interface DurableProjectorWiring {
  jsm: JetStreamManager;
  js: JetStreamClient;
  /** Per-run thread-message-parts storage (the PartEmitter sink). */
  messageParts: SqlThreadMessagePartStorage;
  /** Resolve a run's org + storage version (a global threads lookup). */
  resolveRunOrg: (
    runId: string,
  ) => Promise<{ orgId: string; version: number } | null>;
}

function lazyV2Persistence(
  runId: string,
  w: DurableProjectorWiring,
): HarnessStreamPersistence {
  let emitter: Promise<PartEmitter | null> | null = null;
  const get = () => {
    if (!emitter) {
      emitter = w.resolveRunOrg(runId).then((org) => {
        // v1 / unknown runs are persisted by the inline path; the durable
        // projector only owns v2 (PartEmitter) runs.
        if (!org || org.version !== 2) return null;
        return new PartEmitter({
          storage: w.messageParts,
          orgId: org.orgId,
          threadId: runId,
          runId,
        });
      });
    }
    return emitter;
  };
  return {
    emitStepParts: async (message) => {
      const e = await get();
      if (e) await e.emitStepParts(message);
    },
    emitFinal: async (message) => {
      const e = await get();
      if (e) await e.emitFinal(message);
    },
    emitError: async (messageId, errorText) => {
      const e = await get();
      if (e) await e.emitError(messageId, errorText);
    },
  };
}

export async function startDurableProjector(
  w: DurableProjectorWiring,
): Promise<void> {
  const consumer = await createDurableProjectorConsumer(w.jsm, w.js);
  await consumer.start({
    persistenceFor: (runId) => lazyV2Persistence(runId, w),
    onRunErrored: async (runId, error) => {
      console.error("[durable-projector] run poisoned:", { runId, error });
    },
  });
}
