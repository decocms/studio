/**
 * E2E relay driver over direct NATS (protocol v2, post-`/chunks` removal).
 *
 * A real desktop daemon no longer POSTs harness output to a cluster HTTP
 * endpoint — it publishes each seq-numbered `RelayLine` straight to the
 * JetStream subject `decopilot.stream.<runId>` (see
 * `link-daemon/handle-local-dispatch.ts` + `link-daemon/direct-nats-publisher.ts`),
 * and the always-on durable projector consumes that stream and commits parts.
 *
 * These helpers do EXACTLY what the daemon does: build a JetStream client over
 * the same NATS the cluster uses and run the canned relay body through the very
 * same `publishRelayBodyToNats` production unit. So an e2e "fake daemon" relay is
 * `publishRelayBody({ runId, fenceToken, body })` — a drop-in for the old
 * `api.post('/api/:org/links/runs/:runId/chunks', ...)`.
 *
 * Persistence is therefore ASYNC: publishing returns once the lines (and the
 * terminal `done`) are on the stream; the projector materializes parts +
 * flips `threads.status` shortly after. Callers must POLL the DB for durable
 * effects (the old synchronous `/chunks` ack is gone).
 */

import { jetstream } from "@nats-io/jetstream";
import {
  createDirectNatsPublisher,
  publishRelayBodyToNats,
} from "./relay-publisher";
import { openNats } from "./links-presence";

export interface PublishRelayResult {
  /** Highest wire seq observed across all lines (incl. the terminal `done`),
   *  matching what the old `/chunks` ack returned as `lastSeq`. */
  lastSeq: number;
}

/**
 * Relay a canned NDJSON body (from `relay-chunks.ts`) to a run's JetStream
 * stream as the fake daemon. Opens a short-lived NATS connection, publishes
 * every line + the terminal marker via the production publisher, then drains.
 */
export async function publishRelayBody(opts: {
  runId: string;
  fenceToken: string;
  body: string;
}): Promise<PublishRelayResult> {
  const nc = await openNats();
  try {
    const js = jetstream(nc);
    const publisher = createDirectNatsPublisher({ js });
    const { lastSeq } = await publishRelayBodyToNats({
      body: opts.body,
      runId: opts.runId,
      fenceToken: opts.fenceToken,
      publisher,
    });
    // Ensure the publishes have flushed to the server before we return.
    await nc.flush();
    return { lastSeq };
  } finally {
    await nc.drain();
  }
}
