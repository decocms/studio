import { describe, it, expect } from "bun:test";
import { serializePayload } from "./thread-message-parts";

describe("serializePayload", () => {
  it("passes small payloads through as-is", () => {
    const payload = { type: "text", text: "hello" };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });

  it("stores large-but-legitimate payloads in full (no data loss)", () => {
    const big = { type: "tool-result", output: "x".repeat(2_000_000) };
    expect(serializePayload(big)).toBe(JSON.stringify(big));
  });

  it("circuit-breaks a single oversized string without stringifying it", () => {
    const pathological = {
      type: "tool-result",
      output: "x".repeat(60_000_000),
    };
    const out = JSON.parse(serializePayload(pathological));
    expect(out.truncated).toBe(true);
  });

  it("circuit-breaks many small strings that sum past the cap", () => {
    const chunks = Array.from({ length: 1000 }, () => "x".repeat(60_000));
    const pathological = { type: "tool-result", output: chunks }; // 60MB total
    const out = JSON.parse(serializePayload(pathological));
    expect(out.truncated).toBe(true);
  });

  // Postgres jsonb rejects U+0000 with SQLSTATE 22P05, which would strand the
  // whole run in_progress. A tool result that inlined raw binary (e.g. a PNG)
  // is the real-world trigger.
  it("strips NUL bytes so the payload is storable in jsonb", () => {
    const payload = { type: "text", text: "before\u0000after" };
    const serialized = serializePayload(payload);
    expect(serialized).not.toContain("\\u0000");
    expect(JSON.parse(serialized).text).toBe("beforeafter");
  });

  it("strips NUL bytes nested deep in the payload tree", () => {
    const payload = { a: { b: [{ c: "x\u0000y" }] } };
    const out = JSON.parse(serializePayload(payload));
    expect(out.a.b[0].c).toBe("xy");
  });

  // Postgres jsonb also rejects unpaired UTF-16 surrogates as an unsupported
  // Unicode escape sequence; replace them with the Unicode replacement char.
  it("replaces lone surrogates with U+FFFD", () => {
    const payload = { text: `lead\uD800 trail\uDC00 pair\u{1F600}` };
    const out = JSON.parse(serializePayload(payload));
    expect(out.text).toBe("lead\uFFFD trail\uFFFD pair\u{1F600}");
  });

  it("leaves a well-formed emoji (surrogate pair) intact", () => {
    const payload = { text: "hi \u{1F600}" };
    expect(serializePayload(payload)).toBe(JSON.stringify(payload));
  });
});
