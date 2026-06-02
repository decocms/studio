/**
 * Splitting helpers for the link transport's NATS hop.
 *
 * NATS rejects any single message larger than the server's `max_payload`
 * (default 1 MiB) with MAX_PAYLOAD_EXCEEDED, thrown synchronously by the
 * client. The link response stream is an ordered, single-publisher byte
 * stream the consumer concatenates, so an oversized `chunk` frame is split
 * into smaller ORDERED chunks (no reassembly needed) before publishing.
 *
 * This module is the single source of truth for the per-message byte budget.
 */

/** Per-message ceiling, under the 1 MiB NATS default to leave headroom for
 *  the subject and protocol framing (the server counts payload only). */
export const MAX_PUBLISH_BYTES = 768 * 1024;

/** Worst-case JSON escaping is 6 bytes per UTF-16 code unit (\u00XX); UTF-8 is
 *  at most 4. Using 6 as the per-unit upper bound guarantees a piece's encoded
 *  chunk frame never exceeds the budget without re-encoding per code point. */
const WORST_CASE_BYTES_PER_UNIT = 6;

/**
 * Split `data` into ordered substrings such that each, embedded in a
 * `{type:"chunk",reqId,data}` frame whose envelope is `frameOverheadBytes`,
 * JSON-encodes to <= `maxBytes`. Concatenating the pieces reproduces `data`
 * exactly. Avoids splitting a surrogate pair (cosmetic — lone surrogates also
 * round-trip through JSON, but keeping pairs intact is cleaner).
 */
export function splitChunkData(
  data: string,
  maxBytes: number,
  frameOverheadBytes: number,
): string[] {
  const budget = maxBytes - frameOverheadBytes;
  if (budget <= 0) throw new Error("frame overhead exceeds maxBytes");
  const maxUnits = Math.max(1, Math.floor(budget / WORST_CASE_BYTES_PER_UNIT));
  if (data.length <= maxUnits) return [data];

  const out: string[] = [];
  let i = 0;
  while (i < data.length) {
    let end = Math.min(i + maxUnits, data.length);
    if (end < data.length) {
      const code = data.charCodeAt(end - 1);
      // High surrogate at the cut edge — back off one unit to keep the pair.
      if (code >= 0xd800 && code <= 0xdbff) end -= 1;
    }
    if (end <= i) end = i + 1; // pathological tiny budget — never stall
    out.push(data.slice(i, end));
    i = end;
  }
  return out;
}
