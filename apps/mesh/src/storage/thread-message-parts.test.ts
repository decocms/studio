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
});
