import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { sleep } from "@decocms/std";
import type { RelayLine } from "@/links/protocol/relay";
import {
  createRelaySessionRegistry,
  RELAY_SESSION_IDLE_TIMEOUT_MS,
} from "./relay-session";

const FENCE = "fence_1";

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
    const session = registry.open("run_1", FENCE, { consume });

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
    const session = registry.open("run_1", FENCE, { consume });

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
    const session = registry.open("run_1", FENCE, { consume });

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
    const session = registry.open("run_1", FENCE, { consume });

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
    const session = registry.open("run_1", FENCE, { consume });

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
    const session = registry.open("run_1", FENCE, {
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
    const session = registry.open("run_1", FENCE, { consume });
    expect(registry.get("run_1")).toBe(session);

    session.push(doneLine(1));
    await session.whenComplete;
    // Removal runs in a .finally on the consume promise — yield once.
    await sleep(0);
    expect(registry.get("run_1")).toBeUndefined();
  });

  test("registry entry is removed after consume rejects", async () => {
    const registry = createRelaySessionRegistry();
    const session = registry.open("run_1", FENCE, {
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
    const session = registry.open("run_1", FENCE, { consume });
    expect(() => registry.open("run_1", FENCE, { consume })).toThrow(
      /already has an open relay session/,
    );
    session.push(doneLine(1));
  });

  test("sessions are independent per run", async () => {
    const registry = createRelaySessionRegistry();
    const a = collectingConsumer();
    const b = collectingConsumer();
    const sessionA = registry.open("run_a", FENCE, { consume: a.consume });
    const sessionB = registry.open("run_b", FENCE, { consume: b.consume });

    sessionA.push(chunkLine(1, { type: "text-delta", id: "t", delta: "A" }));
    sessionB.push(chunkLine(1, { type: "text-delta", id: "t", delta: "B" }));
    sessionA.push(doneLine(2));
    sessionB.push(doneLine(2));

    await Promise.all([sessionA.whenComplete, sessionB.whenComplete]);
    expect(a.received).toEqual([{ type: "text-delta", id: "t", delta: "A" }]);
    expect(b.received).toEqual([{ type: "text-delta", id: "t", delta: "B" }]);
  });

  test("exposes the fence token a session was opened with", () => {
    const registry = createRelaySessionRegistry();
    const { consume } = collectingConsumer();
    const session = registry.open("run_1", FENCE, { consume });
    expect(session.fenceToken).toBe(FENCE);
    session.push(doneLine(1));
  });

  test("evict relay_superseded fails the iterable with the coded error", async () => {
    const registry = createRelaySessionRegistry();
    const { consume, settledState } = collectingConsumer();
    const session = registry.open("run_1", FENCE, { consume });

    session.push(chunkLine(1, { type: "start", messageId: "m1" }));
    registry.evict("run_1", "relay_superseded");

    await expect(session.whenComplete).rejects.toThrow("relay_superseded");
    const settled = settledState() as {
      ok: false;
      error: Error & { code?: string };
    };
    expect(settled.error.code).toBe("relay_superseded");
    // Eviction removes the entry immediately so a fresh open() can take over.
    expect(registry.get("run_1")).toBeUndefined();
  });

  test("a different fence supersedes: stale session evicted, fresh one consumes from seq 1", async () => {
    const registry = createRelaySessionRegistry();
    const stale = collectingConsumer();
    const fresh = collectingConsumer();

    // First run's session parks (daemon died mid-run, no terminal line).
    const staleSession = registry.open("run_1", "fence_old", {
      consume: stale.consume,
    });
    staleSession.push(
      chunkLine(1, { type: "text-delta", id: "t", delta: "STALE" }),
    );

    // Route resolution on a new run with a fresh fence: evict + reopen.
    const current = registry.get("run_1")!;
    expect(current.fenceToken).toBe("fence_old");
    registry.evict("run_1", "relay_superseded");
    const freshSession = registry.open("run_1", "fence_new", {
      consume: fresh.consume,
    });
    expect(freshSession.fenceToken).toBe("fence_new");

    // New run relays from seq 1 again.
    freshSession.push(
      chunkLine(1, { type: "text-delta", id: "t", delta: "FRESH" }),
    );
    freshSession.push(doneLine(2));

    await expect(staleSession.whenComplete).rejects.toThrow("relay_superseded");
    await freshSession.whenComplete;

    // The fresh lines are consumed by the fresh session — never spliced into
    // the stale kernel.
    expect(fresh.received).toEqual([
      { type: "text-delta", id: "t", delta: "FRESH" },
    ]);
    expect(stale.received).toEqual([
      { type: "text-delta", id: "t", delta: "STALE" },
    ]);
    // The fresh session's settle .finally must NOT delete a now-absent entry,
    // and the registry holds the fresh session until it settles.
    await sleep(0);
    expect(registry.get("run_1")).toBeUndefined();
  });

  test("evict is a no-op for an unknown run", () => {
    const registry = createRelaySessionRegistry();
    expect(() => registry.evict("missing", "relay_superseded")).not.toThrow();
  });

  test("evict after a terminal line is a no-op (terminal wins the race)", async () => {
    const registry = createRelaySessionRegistry();
    const { received, consume } = collectingConsumer();
    const session = registry.open("run_1", FENCE, { consume });

    session.push(chunkLine(1, { type: "text-delta", id: "t", delta: "x" }));
    session.push(doneLine(2));
    registry.evict("run_1", "relay_idle_timeout"); // loses — already ended

    await session.whenComplete; // resolves (done), not rejected
    expect(received).toEqual([{ type: "text-delta", id: "t", delta: "x" }]);
  });

  test("idle reaper evicts a session with no pushes (relay_idle_timeout)", async () => {
    const registry = createRelaySessionRegistry({ idleTimeoutMs: 15 });
    const { settledState, consume } = collectingConsumer();
    const session = registry.open("run_1", FENCE, { consume });

    // No push for > idle window → reaper fires.
    await expect(session.whenComplete).rejects.toThrow("relay_idle_timeout");
    const settled = settledState() as {
      ok: false;
      error: Error & { code?: string };
    };
    expect(settled.error.code).toBe("relay_idle_timeout");
    await sleep(0);
    expect(registry.get("run_1")).toBeUndefined();
  });

  test("idle reaper resets on every push and clears on terminal", async () => {
    const registry = createRelaySessionRegistry({ idleTimeoutMs: 30 });
    const { received, consume } = collectingConsumer();
    const session = registry.open("run_1", FENCE, { consume });

    // Keep pushing inside the window — the reaper must keep resetting.
    for (let seq = 1; seq <= 4; seq++) {
      await sleep(15);
      session.push(
        chunkLine(seq, { type: "text-delta", id: "t", delta: `${seq}` }),
      );
    }
    session.push(doneLine(5)); // terminal clears the timer

    // Well past the idle window after the terminal — must NOT be reaped.
    await sleep(60);
    await session.whenComplete; // resolved, not rejected by the reaper
    expect(received).toHaveLength(4);
  });

  test("default idle timeout is 15 minutes", () => {
    expect(RELAY_SESSION_IDLE_TIMEOUT_MS).toBe(15 * 60 * 1000);
  });
});
