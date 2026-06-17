import { describe, expect, it } from "bun:test";
import { MAX_TOOL_CALL_KEY_BYTES, storageKey } from "./async-research-jobs";

// `storageKey` is the bounded btree-key derivation that keeps an oversized
// tool_call_id (LiteLLM packs Gemini thought signatures into the id —
// `call_<hex>__thought__<base64>`, up to several KB) from blowing Postgres's
// ~2704-byte index-row limit on the (org, tool_call_id) unique index and the
// thread_messages PK.
describe("storageKey", () => {
  it("returns short ids verbatim (readable, back-compat)", () => {
    expect(storageKey("call_abc123")).toBe("call_abc123");
    const atLimit = "x".repeat(MAX_TOOL_CALL_KEY_BYTES);
    expect(storageKey(atLimit)).toBe(atLimit);
  });

  it("hashes ids above the byte limit to a bounded sha256 key", () => {
    const huge = `call_${"A".repeat(6800)}`;
    const key = storageKey(huge);
    expect(key).toMatch(/^sha256:[0-9a-f]{64}$/);
    // 7 ("sha256:") + 64 hex — comfortably under the limit.
    expect(Buffer.byteLength(key)).toBeLessThanOrEqual(MAX_TOOL_CALL_KEY_BYTES);
  });

  it("is deterministic — same id maps to the same key (idempotent inserts/replay)", () => {
    const huge = `call_${"B".repeat(5000)}`;
    expect(storageKey(huge)).toBe(storageKey(huge));
  });

  it("is idempotent: storageKey(storageKey(x)) === storageKey(x)", () => {
    // The sweeper rebuilds stub ids from the already-stored column value, so
    // re-keying a derived key must be a no-op.
    const huge = `call_${"C".repeat(4000)}`;
    const once = storageKey(huge);
    expect(storageKey(once)).toBe(once);
  });

  it("maps distinct oversized ids to distinct keys (no cross-tool collision)", () => {
    const a = `call_aaaa__thought__${"Z".repeat(4000)}`;
    const b = `call_bbbb__thought__${"Z".repeat(4000)}`;
    expect(storageKey(a)).not.toBe(storageKey(b));
  });

  it("keys by raw bytes, so a multibyte id over the limit is still bounded", () => {
    // "é" is 2 bytes in UTF-8 — 1300 chars = 2600 bytes > 2400.
    const multibyte = "é".repeat(1300);
    expect(Buffer.byteLength(multibyte)).toBeGreaterThan(
      MAX_TOOL_CALL_KEY_BYTES,
    );
    expect(storageKey(multibyte)).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});
