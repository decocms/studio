/**
 * Per-message byte budget for the link/decopilot NATS hop.
 *
 * NATS rejects any single message larger than the server's `max_payload`
 * (default 1 MiB) with MAX_PAYLOAD_EXCEEDED, thrown synchronously by the
 * client. Consumers (decopilot's `nats-stream-buffer.ts`, the pull work queue,
 * and the message-offload gate) keep their payloads under this ceiling.
 *
 * The canonical definition lives in `@decocms/harness` (the offload gate owns
 * the threshold); re-exported here so the NATS chunking/work-queue and the
 * offload gate share ONE source of truth — a mismatch is a transport bug.
 */
export { MAX_PUBLISH_BYTES } from "@decocms/harness/offload-messages";
