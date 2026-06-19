/**
 * Cluster-startup wiring for the durable projector SCHEDULER (spec §5.4).
 *
 * Starts the durable JetStream consumer and hands it the (runId → orgId)
 * resolver plus the DBOS `enqueueProjectRun` scheduler. The consumer no longer
 * builds per-run persistence callbacks: on an authoritative fenced done marker
 * it enqueues the durable `projectRunWorkflow`, which reconstructs the run from
 * file-backed JetStream and writes parts/title/terminal status (it is the SOLE
 * v2 DB writer). Pre-existing v1 threads are deprecated read-only legacy.
 * Started on the elected leader in app.ts (leadership is only a scheduler
 * throttle — correctness comes from the workflow ID keyed by (runId, fence)).
 *
 * Integration-only (real NATS + DBOS); the pure scheduling/ack policy is
 * unit-tested in projector-consumer.test.ts.
 */
import type { JetStreamClient, JetStreamManager } from "nats";
import {
  createDurableProjectorConsumer,
  type DurableProjectorConsumerHandle,
} from "./projector-consumer";
import { enqueueProjectRun } from "./projector-workflow";

export interface DurableProjectorWiring {
  jsm: JetStreamManager;
  js: JetStreamClient;
  resolveOrgId: (runId: string) => Promise<string | null>;
}

/**
 * Start the durable projector consumer and return a handle whose `stop()` aborts
 * `consumer.consume()`, so the leader-election controller can hand off the
 * single-active consumer on leadership loss.
 */
export async function startDurableProjector(
  w: DurableProjectorWiring,
): Promise<DurableProjectorConsumerHandle> {
  const consumer = await createDurableProjectorConsumer(w.jsm, w.js);
  return consumer.start({
    resolveOrgId: w.resolveOrgId,
    enqueueProjectRun,
  });
}
