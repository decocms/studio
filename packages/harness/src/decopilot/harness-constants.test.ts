import { describe, expect, it } from "bun:test";
import { DEFAULT_MAX_TOKENS, generateMessageId } from "./harness-constants";

describe("harness-constants", () => {
  it("exposes the default max tokens", () => {
    expect(DEFAULT_MAX_TOKENS).toBe(32768);
  });
  it("generates msg-prefixed ids", () => {
    const id = generateMessageId();
    expect(id.startsWith("msg_")).toBe(true);
    expect(generateMessageId()).not.toBe(id);
  });
});
