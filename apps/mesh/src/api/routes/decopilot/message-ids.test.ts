import { describe, expect, test } from "bun:test";
import { synthesizedErrorMessageId } from "./message-ids";

describe("synthesizedErrorMessageId", () => {
  test("distinct turns of one thread produce distinct error ids", () => {
    // runId == threadId is reused on EVERY turn; only the per-turn fence token
    // differs. The fence namespace ensures turn 1 and turn 2 never collide.
    expect(synthesizedErrorMessageId("thread-1", "fence-a")).not.toBe(
      synthesizedErrorMessageId("thread-1", "fence-b"),
    );
  });

  test("same args always produce the same id (idempotent dedupe preserved)", () => {
    // The live path and the durable projector both call synthesizedErrorMessageId
    // with the same (runId, fenceToken) → identical ids → ON CONFLICT DO NOTHING
    // dedupes instead of duplicating.
    expect(synthesizedErrorMessageId("t", "f")).toBe(
      synthesizedErrorMessageId("t", "f"),
    );
  });

  test("id format is error-<runId>:<fenceToken>", () => {
    expect(synthesizedErrorMessageId("t", "f")).toBe("error-t:f");
  });
});
