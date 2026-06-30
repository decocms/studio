/**
 * Per-message byte budget for the link/decopilot NATS hop — the offload gate's
 * ceiling. NATS rejects any single message larger than the server's
 * `max_payload` (default 1 MiB) with MAX_PAYLOAD_EXCEEDED, thrown synchronously
 * by the client. Kept under 1 MiB to leave headroom for the subject + protocol
 * framing. This is the CANONICAL definition; the run-stream codec
 * (`run-stream-codec.ts`) fragments wire payloads against it so the offload
 * gate and the chunking share one source of truth (a mismatch is a transport
 * bug).
 */
export const MAX_PUBLISH_BYTES = 768 * 1024;

export interface MessagesRef {
  url: string;
  bytes: number;
  sha256: string;
}

/** Envelope the daemon's /dispatch route receives. `messagesRef`, when present,
 *  means `input.messages` was offloaded and must be fetched + spliced back. */
export interface DispatchEnvelope {
  harnessId: string;
  input: unknown;
  messagesRef?: MessagesRef;
}

/** Ephemeral key prefix; a bucket lifecycle rule reclaims `*\/link-dispatch/`. */
export function offloadKey(reqId: string): string {
  return `link-dispatch/${reqId}`;
}

/** Offload only when the encoded body would exceed the per-message budget. */
export function shouldOffload(encodedBodyBytes: number): boolean {
  return encodedBodyBytes > MAX_PUBLISH_BYTES;
}

export function parseMessagesRef(env: unknown): MessagesRef | null {
  if (env && typeof env === "object" && "messagesRef" in env) {
    const r = (env as { messagesRef?: unknown }).messagesRef;
    if (
      r &&
      typeof r === "object" &&
      typeof (r as MessagesRef).url === "string" &&
      typeof (r as MessagesRef).bytes === "number" &&
      typeof (r as MessagesRef).sha256 === "string"
    ) {
      return r as MessagesRef;
    }
  }
  return null;
}

export async function sha256Hex(bytes: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
