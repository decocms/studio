import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { sleep } from "@decocms/std";
import type { RelayLine } from "@/links/protocol/relay";
import { createRelaySessionRegistry } from "./relay-session";

function chunkLine(seq: number, chunk: unknown): RelayLine {
  return { seq, event: { type: "ui-message-chunk", chunk } };
}

function doneLine(seq: number): RelayLine {
  return { seq, event: { type: "done" } };
}

function errorLine(seq: number, code: string, message: string): RelayLine {
  return { seq, event: { type: "error", code, message } };
}

/**
 * Collect everything an iterable yields plus its terminal outcome, without
 * blocking the caller. Tests drive the session with plain async functions —
 * no kernel, no StudioContext (the registry is deliberately kernel-agnostic).
 */
function collectingConsumer() {
  const received: unknown[] = [];
  let settled: { ok: true } | { ok: false; error: unknown } | null = null;
  const consume = async (chunks: AsyncIterable<UIMessageChunk>) => {
    try {
      for await (const chunk of chunks) received.push(chunk);
      settled = { ok: true };
    } catch (error) {
      settled = { ok: false, error };
      throw error;
    }
  };
  return { received, consume, settledState: () => settled };
}

describe("relay session registry", () => {
  test("delivers pushed chunks in order and ends the iterable on done", async () => {
    const registry = createRelaySessionRegistry();
    const { received, consume } = collectingConsumer();
    const session = registry.open("run_1", { consume });

    session.push(chunkLine(1, { type: "start", messageId: "m1" }));
    session.push(chunkLine(2, { type: "text-delta", id: "t1", delta: "hi" }));
    expect(session.ended).toBe(false);
    session.push(doneLine(3));
    expect(session.ended).toBe(true);
    expect(session.lastSeq).toBe(3);

    await session.whenComplete;
    expect(received).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-delta", id: "t1", delta: "hi" },
    ]);
  });

  test("waits for chunks pushed after the consumer started pulling", async () => {
    const registry = createRelaySessionRegistry();
    const { received, consume } = collectingConsumer();
    const session = registry.open("run_1", { consume });

    // Let the consumer reach its first await (empty queue) before pushing.
    await sleep(0);
    session.push(chunkLine(1, { type: "start-step" }));
    await sleep(0);
    session.push(chunkLine(2, { type: "finish-step" }));
    session.push(doneLine(3));

    await session.whenComplete;
    expect(received).toEqual([{ type: "start-step" }, { type: "finish-step" }]);
  });

  test("drops replayed lines (seq <= lastSeq) so reconnect resends are safe", async () => {
    const registry = createRelaySessionRegistry();
    const { received, consume } = collectingConsumer();
    const session = registry.open("run_1", { consume });

    session.push(chunkLine(1, { type: "start", messageId: "m1" }));
    session.push(chunkLine(2, { type: "text-delta", id: "t1", delta: "a" }));
    // Reconnect: the daemon resends the FULL prefix from seq 1, then new lines.
    session.push(chunkLine(1, { type: "start", messageId: "m1" }));
    session.push(chunkLine(2, { type: "text-delta", id: "t1", delta: "a" }));
    session.push(chunkLine(3, { type: "text-delta", id: "t1", delta: "b" }));
    session.push(doneLine(4));

    await session.whenComplete;
    expect(session.lastSeq).toBe(4);
    expect(received).toEqual([
      { type: "start", messageId: "m1" },
      { type: "text-delta", id: "t1", delta: "a" },
      { type: "text-delta", id: "t1", delta: "b" },
    ]);
  });

  test("error line rejects the iterable with code + message; later lines still bump lastSeq", async () => {
    const registry = createRelaySessionRegistry();
    const { received, consume, settledState } = collectingConsumer();
    const session = registry.open("run_1", { consume });

    session.push(chunkLine(1, { type: "start", messageId: "m1" }));
    session.push(errorLine(2, "sandbox_dead", "sandbox went away"));
    expect(session.ended).toBe(true);
    // The daemon synthesizes a terminal done after an error — it must count
    // toward lastSeq (the daemon checks lastSeq >= terminal seq) but deliver
    // nothing.
    session.push(doneLine(3));
    expect(session.lastSeq).toBe(3);

    await expect(session.whenComplete).rejects.toThrow(
      "sandbox_dead: sandbox went away",
    );
    const settled = settledState();
    expect(settled).not.toBeNull();
    expect(settled!.ok).toBe(false);
    const error = (settled as { ok: false; error: unknown }).error as Error & {
      code?: string;
    };
    expect(error.code).toBe("sandbox_dead");
    expect(received).toEqual([{ type: "start", messageId: "m1" }]);
  });

  test("chunks queued before an error are delivered before the rejection", async () => {
    const registry = createRelaySessionRegistry();
    const { received, consume } = collectingConsumer();
    const session = registry.open("run_1", { consume });

    // Push everything before the consumer gets a chance to pull: the queued
    // chunk must still be yielded before the failure is thrown.
    session.push(chunkLine(1, { type: "text-delta", id: "t1", delta: "x" }));
    session.push(errorLine(2, "boom", "late failure"));

    await session.whenComplete.catch(() => {});
    expect(received).toEqual([{ type: "text-delta", id: "t1", delta: "x" }]);
  });

  test("whenComplete settles only after consume settles (post-done work included)", async () => {
    const registry = createRelaySessionRegistry();
    let consumeFinished = false;
    const session = registry.open("run_1", {
      consume: async (chunks) => {
        for await (const _ of chunks) {
          // drain
        }
        await sleep(5); // post-stream persistence work
        consumeFinished = true;
      },
    });

    session.push(doneLine(1));
    expect(consumeFinished).toBe(false);
    await session.whenComplete;
    expect(consumeFinished).toBe(true);
  });

  test("registry entry is removed after consume resolves", async () => {
    const registry = createRelaySessionRegistry();
    const { consume } = collectingConsumer();
    const session = registry.open("run_1", { consume });
    expect(registry.get("run_1")).toBe(session);

    session.push(doneLine(1));
    await session.whenComplete;
    // Removal runs in a .finally on the consume promise — yield once.
    await sleep(0);
    expect(registry.get("run_1")).toBeUndefined();
  });

  test("registry entry is removed after consume rejects", async () => {
    const registry = createRelaySessionRegistry();
    const session = registry.open("run_1", {
      consume: async () => {
        throw new Error("persistence exploded");
      },
    });

    await expect(session.whenComplete).rejects.toThrow("persistence exploded");
    await sleep(0);
    expect(registry.get("run_1")).toBeUndefined();
  });

  test("get returns undefined for unknown runs and open rejects duplicates", () => {
    const registry = createRelaySessionRegistry();
    expect(registry.get("missing")).toBeUndefined();

    const { consume } = collectingConsumer();
    const session = registry.open("run_1", { consume });
    expect(() => registry.open("run_1", { consume })).toThrow(
      /already has an open relay session/,
    );
    session.push(doneLine(1));
  });

  test("sessions are independent per run", async () => {
    const registry = createRelaySessionRegistry();
    const a = collectingConsumer();
    const b = collectingConsumer();
    const sessionA = registry.open("run_a", { consume: a.consume });
    const sessionB = registry.open("run_b", { consume: b.consume });

    sessionA.push(chunkLine(1, { type: "text-delta", id: "t", delta: "A" }));
    sessionB.push(chunkLine(1, { type: "text-delta", id: "t", delta: "B" }));
    sessionA.push(doneLine(2));
    sessionB.push(doneLine(2));

    await Promise.all([sessionA.whenComplete, sessionB.whenComplete]);
    expect(a.received).toEqual([{ type: "text-delta", id: "t", delta: "A" }]);
    expect(b.received).toEqual([{ type: "text-delta", id: "t", delta: "B" }]);
  });
});
