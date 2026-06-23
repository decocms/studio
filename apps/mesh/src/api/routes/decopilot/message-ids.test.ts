import { describe, expect, test } from "bun:test";
import {
  assistantMessageIdGenerator,
  synthesizedErrorMessageId,
} from "./message-ids";

describe("projector/live message ids", () => {
  test("distinct turns of one thread never collide", () => {
    // runId == threadId is reused on EVERY turn; only the per-turn fence token
    // differs. Under the old `${runId}:msg:${n}` scheme both turns produced
    // "thread-1:msg:0", so turn 2's parts collided with turn 1's and were
    // silently dropped by ON CONFLICT (id) DO NOTHING ("No response generated").
    const turn1 = assistantMessageIdGenerator("thread-1", "fence-a");
    const turn2 = assistantMessageIdGenerator("thread-1", "fence-b");
    expect(turn1()).not.toBe(turn2());
    expect(synthesizedErrorMessageId("thread-1", "fence-a")).not.toBe(
      synthesizedErrorMessageId("thread-1", "fence-b"),
    );
  });

  test("re-folding the SAME turn yields identical ids (idempotent dedupe preserved)", () => {
    // Terminal projection, checkpoint passes, and the live+projector double
    // write all re-fold the same (runId, fenceToken) → identical ids → the
    // ON CONFLICT (id) DO NOTHING dedupe relied on by #4044 still holds.
    const a = assistantMessageIdGenerator("thread-1", "fence-a");
    const b = assistantMessageIdGenerator("thread-1", "fence-a");
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
    expect(synthesizedErrorMessageId("t", "f")).toBe(
      synthesizedErrorMessageId("t", "f"),
    );
  });

  test("ids increment in fold order and carry the fence namespace", () => {
    const gen = assistantMessageIdGenerator("t", "f");
    expect([gen(), gen()]).toEqual(["t:f:msg:0", "t:f:msg:1"]);
    expect(synthesizedErrorMessageId("t", "f")).toBe("error-t:f");
  });
});
