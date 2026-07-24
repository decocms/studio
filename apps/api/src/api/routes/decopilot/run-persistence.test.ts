import { describe, expect, test } from "bun:test";
import type { SqlThreadMessagePartStorage } from "@/storage/thread-message-parts";
import { createRunPersistence } from "./run-persistence";

/**
 * Hand-rolled fake — no DB. `PartEmitter` only ever calls `appendParts` and
 * `replaceMessageParts` on the storage it's given; this fake captures the
 * rows so the test can read the stamped `created_at` without touching
 * Postgres. `maxCreatedAtMsForMessage`/`maxCreatedAtMsForRun` are stubbed to
 * the fixture values under test.
 */
function fakeStorage(opts: {
  maxForMessage?: number | null;
  maxForRun?: number | null;
}) {
  const appended: { id: string; created_at: string }[] = [];
  return {
    appended,
    storage: {
      maxCreatedAtMsForMessage: async () => opts.maxForMessage ?? null,
      maxCreatedAtMsForRun: async () => opts.maxForRun ?? null,
      appendParts: async (rows: { id: string; created_at: string }[]) => {
        appended.push(...rows);
      },
      // NOTE: the real `SqlThreadMessagePartStorage.replaceMessageParts`
      // signature is `(threadId, messageId, parts)` — three args, not the
      // five-arg (org/thread/run/message/rows) shape one might guess from
      // other storage methods. `emitStepParts` (used below) only calls
      // `appendParts`, but this is wired for completeness / future tests
      // that exercise `replaceFinal`.
      replaceMessageParts: async (
        _threadId: string,
        _messageId: string,
        rows: { id: string; created_at: string }[],
      ) => {
        appended.push(...rows);
      },
    } as unknown as SqlThreadMessagePartStorage,
  };
}

const assistantMessage = {
  id: "a1",
  role: "assistant" as const,
  parts: [{ type: "text", text: "hi", state: "done" }],
};

describe("createRunPersistence — assistant created_at base anchoring", () => {
  test("anchors to request message, NOT run max", async () => {
    // Regression: before the fix, the base always came from the run-wide max
    // (301), scrambling a queued turn's reply after later-queued messages.
    const { storage, appended } = fakeStorage({
      maxForMessage: 100,
      maxForRun: 300,
    });
    const persistence = await createRunPersistence({
      messageParts: storage,
      orgId: "org_1",
      runId: "run_1",
      requestMessageId: "u2",
    });

    await persistence.emitStepParts(assistantMessage);

    expect(appended[0]?.created_at).toBe(new Date(101).toISOString());
  });

  test("falls back to run max when no requestMessageId", async () => {
    const { storage, appended } = fakeStorage({ maxForRun: 300 });
    const persistence = await createRunPersistence({
      messageParts: storage,
      orgId: "org_1",
      runId: "run_1",
    });

    await persistence.emitStepParts(assistantMessage);

    expect(appended[0]?.created_at).toBe(new Date(301).toISOString());
  });

  test("falls back to run max when the message has no parts yet", async () => {
    const { storage, appended } = fakeStorage({
      maxForMessage: null,
      maxForRun: 300,
    });
    const persistence = await createRunPersistence({
      messageParts: storage,
      orgId: "org_1",
      runId: "run_1",
      requestMessageId: "u2",
    });

    await persistence.emitStepParts(assistantMessage);

    expect(appended[0]?.created_at).toBe(new Date(301).toISOString());
  });
});
