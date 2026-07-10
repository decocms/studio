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

  it("only circuit-breaks truly pathological payload sizes", () => {
    const pathological = {
      type: "tool-result",
      output: "x".repeat(60_000_000),
    };
    const out = JSON.parse(serializePayload(pathological));
    expect(out.truncated).toBe(true);
    expect(out.originalBytes).toBeGreaterThan(50_000_000);
  });
});
