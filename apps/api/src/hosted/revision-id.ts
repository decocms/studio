/**
 * A hosted CMS revision id: `<inv>-<uuidv7>` (contract §1.2). The UUIDv7
 * starts with a 48-bit millisecond timestamp; `<inv>` is 12 hex digits of
 * `2^48 − 1 − that timestamp`, so ids sort newest first and R2's ascending
 * LIST of `revisions/` returns the newest revision folders first. The whole
 * string is the id: nothing is derived from it or stored beside it.
 *
 * Only Studio mints ids, one per publish or rollback attempt.
 */

const REVISION_ID_RE =
  /^[0-9a-f]{12}-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isRevisionId(value: unknown): value is string {
  return typeof value === "string" && REVISION_ID_RE.test(value);
}

const MAX48 = 2n ** 48n - 1n;

/**
 * A key fragment that sorts below every revision id minted before `nowMs`:
 * the 12-hex inverted prefix of `nowMs` itself. LIST from it (`StartAfter`)
 * and the keys that sort before any id are never paged through.
 */
export function revisionIdFloor(nowMs: number): string {
  return (MAX48 - BigInt(nowMs)).toString(16).padStart(12, "0");
}

export function newRevisionId(
  nowMs: number = Date.now(),
  rand: Uint8Array = crypto.getRandomValues(new Uint8Array(10)),
): string {
  const b = new Uint8Array(16);
  let t = BigInt(nowMs);
  for (let i = 5; i >= 0; i--) {
    b[i] = Number(t & 0xffn);
    t >>= 8n;
  }
  b.set(rand.subarray(0, 10), 6);
  b[6] = 0x70 | (b[6]! & 0x0f);
  b[8] = 0x80 | (b[8]! & 0x3f);
  const h = Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
  const uuid = `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
  return `${(MAX48 - BigInt(nowMs)).toString(16).padStart(12, "0")}-${uuid}`;
}
