/**
 * Per-message byte budget for the link/decopilot NATS hop.
 *
 * NATS rejects any single message larger than the server's `max_payload`
 * (default 1 MiB) with MAX_PAYLOAD_EXCEEDED, thrown synchronously by the
 * client. Consumers (decopilot's `nats-stream-buffer.ts`, the message-offload
 * gate in `harnesses/offload-messages.ts`, and the pull work queue) keep their
 * payloads under this ceiling.
 */

/** Per-message ceiling, under the 1 MiB NATS default to leave headroom for
 *  the subject and protocol framing (the server counts payload only). */
export const MAX_PUBLISH_BYTES = 768 * 1024;
