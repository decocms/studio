/**
 * App-side adapter over the shared relay publisher
 * (`@decocms/sandbox/dispatch/relay-publisher` — single source of truth for the
 * wire format). This file's only job is to inject the app's OpenTelemetry
 * metrics into the metrics-agnostic core via `hooks`; everything else is
 * re-exported so existing importers (handle-local-dispatch, dispatch-link-work-item)
 * are unchanged. The e2e "fake daemon" imports the package directly.
 */
import type { JetStreamClient } from "@nats-io/jetstream";
import {
  createDirectNatsPublisher as createCoreDirectNatsPublisher,
  type DirectNatsPublisher,
} from "@decocms/sandbox/dispatch/relay-publisher";
import {
  encodeMsHistogram,
  publishedChunksCounter,
} from "../api/routes/decopilot/stream-metrics";

export {
  publishRelayBodyToNats,
  type DirectNatsPublisher,
  type PublishRelayBodyResult,
} from "@decocms/sandbox/dispatch/relay-publisher";

export function createDirectNatsPublisher(input: {
  js: Pick<JetStreamClient, "publish">;
}): DirectNatsPublisher {
  return createCoreDirectNatsPublisher({
    js: input.js,
    hooks: {
      onChunkEncoded: (ms) => encodeMsHistogram().record(ms),
      onChunkPublished: () => publishedChunksCounter().add(1),
    },
  });
}
