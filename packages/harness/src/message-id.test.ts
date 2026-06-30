import { describe, expect, test } from "bun:test";
import { generateMessageId } from "./message-id";

describe("generateMessageId", () => {
  test("produces unique msg_-prefixed ids", () => {
    const a = generateMessageId();
    const b = generateMessageId();
    expect(a).toMatch(/^msg_/);
    expect(b).toMatch(/^msg_/);
    expect(a).not.toBe(b);
  });
});
