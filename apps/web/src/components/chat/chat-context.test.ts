import { describe, expect, test } from "bun:test";
import { markChatOpened } from "./chat-context";

describe("markChatOpened", () => {
  test("fires once per taskId, then evicts the oldest once past the tracked cap", () => {
    expect(markChatOpened("evict-me")).toBe(true);
    expect(markChatOpened("evict-me")).toBe(false);

    for (let i = 0; i < 500; i++) {
      markChatOpened(`filler-${i}`);
    }

    // The LRU-evicted thread is treated as new again.
    expect(markChatOpened("evict-me")).toBe(true);
  });
});
