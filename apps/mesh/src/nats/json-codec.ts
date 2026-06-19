/**
 * JSON codec for NATS payloads. Replaces v2 `JSONCodec<T>()` (removed in
 * nats-core v3). Encodes to UTF-8 JSON bytes and decodes back — byte-for-byte
 * compatible with the old codec, so KV values written by either version
 * interoperate.
 */
export interface JsonCodec<T> {
  encode(value: T): Uint8Array;
  decode(bytes: Uint8Array): T;
}

export function jsonCodec<T = unknown>(): JsonCodec<T> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  return {
    encode: (value) => encoder.encode(JSON.stringify(value)),
    decode: (bytes) => JSON.parse(decoder.decode(bytes)) as T,
  };
}
