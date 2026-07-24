import { meter } from "@/observability";

// Shared OTel instruments for the decopilot stream producer. Two modules
// publish chunks: `nats-stream-buffer.ts` (pump/publishRawChunk) and the
// link-daemon's `direct-nats-publisher.ts` (the path agent-sandbox runs
// actually take). Defining the instruments once here keeps both producers
// feeding the same metric instead of double-registering the same name.
//
// `meter` is a NoopMeter until initObservability() runs at bootstrap, and
// these modules are imported before that — so create the instruments lazily
// on first use, by which point `meter` is the real provider. (Module-top
// creation binds the dead noop meter and silently never exports.)
const lazyInstrument = <T>(make: () => T): (() => T) => {
  let v: T | undefined;
  return () => (v ??= make());
};

// Per-chunk JSON.stringify+encode time, pod-level (no attributes) so it can be
// correlated with eventloop.delay to see how much of a saturated thread is the
// encode path.
export const encodeMsHistogram = lazyInstrument(() =>
  meter.createHistogram("decopilot.stream.encode_ms", {
    description: "Per-chunk JSON.stringify+encode time for decopilot stream",
    unit: "ms",
  }),
);

// Logical chunks published to JetStream — the proxy for token throughput
// driving socket fan-out.
export const publishedChunksCounter = lazyInstrument(() =>
  meter.createCounter("decopilot.stream.published_chunks", {
    description: "Logical decopilot stream chunks published to JetStream",
    unit: "{chunks}",
  }),
);
