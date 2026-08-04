import { describe, expect, test } from "bun:test";
import type { TerminalControllerOutputFrame } from "./terminal-controller";
import { TerminalOutputScheduler } from "./terminal-output-scheduler";

const encoder = new TextEncoder();

function frame(
  data: string,
  options: Partial<TerminalControllerOutputFrame> = {},
): TerminalControllerOutputFrame {
  return {
    kind: "output",
    seq: encoder.encode(data).byteLength,
    data: encoder.encode(data),
    allowCapabilityReplies: false,
    restorePendingCapabilityReplies: false,
    restoreUntilSeq: null,
    ...options,
  };
}

function harness(
  options: { chunkBytes?: number; maxQueuedBytes?: number } = {},
) {
  const scheduled: Array<() => void> = [];
  const writes: Array<{ data: string; parsed: () => void }> = [];
  const started: TerminalControllerOutputFrame[] = [];
  const parsed: TerminalControllerOutputFrame[] = [];
  let overflowCount = 0;
  const scheduler = new TerminalOutputScheduler({
    ...options,
    schedule: (callback) => scheduled.push(callback),
    write: (data, onParsed) =>
      writes.push({ data: new TextDecoder().decode(data), parsed: onParsed }),
    onFrameStart: (next) => started.push(next),
    onFrameParsed: (next) => parsed.push(next),
    onOverflow: () => overflowCount++,
  });
  return {
    scheduler,
    scheduled,
    writes,
    started,
    parsed,
    overflowCount: () => overflowCount,
  };
}

describe("TerminalOutputScheduler", () => {
  test("coalesces compatible small frames into one xterm write", () => {
    const state = harness({ chunkBytes: 16 });
    const acknowledged: string[] = [];
    state.scheduler.enqueue(frame("one"), () => acknowledged.push("one"));
    state.scheduler.enqueue(frame("two"), () => acknowledged.push("two"));

    state.scheduled.shift()?.();
    expect(state.writes.map((write) => write.data)).toEqual(["onetwo"]);
    expect(state.started).toHaveLength(2);
    expect(acknowledged).toEqual([]);

    state.writes[0]?.parsed();
    expect(acknowledged).toEqual(["one", "two"]);
    expect(state.parsed).toHaveLength(2);
    expect(state.scheduler.snapshot()).toMatchObject({
      queuedBytes: 0,
      writeCount: 1,
      writtenBytes: 6,
    });
  });

  test("does not coalesce frames with different reply authority", () => {
    const state = harness({ chunkBytes: 16 });
    state.scheduler.enqueue(
      frame("query", { allowCapabilityReplies: true }),
      () => {},
    );
    state.scheduler.enqueue(frame("replay"), () => {});

    state.scheduled.shift()?.();
    expect(state.writes.map((write) => write.data)).toEqual(["query"]);
    state.writes[0]?.parsed();
    state.scheduled.shift()?.();
    expect(state.writes.map((write) => write.data)).toEqual([
      "query",
      "replay",
    ]);
  });

  test("does not coalesce history restoration with live output", () => {
    const state = harness({ chunkBytes: 16 });
    state.scheduler.enqueue(frame("history", { restoreUntilSeq: 7 }), () => {});
    state.scheduler.enqueue(frame("live"), () => {});

    state.scheduled.shift()?.();
    expect(state.writes.map((write) => write.data)).toEqual(["history"]);
    state.writes[0]?.parsed();
    state.scheduled.shift()?.();
    expect(state.writes.map((write) => write.data)).toEqual([
      "history",
      "live",
    ]);
  });

  test("chunks large frames and acknowledges only after every chunk parses", () => {
    const state = harness({ chunkBytes: 4 });
    let acknowledged = false;
    state.scheduler.enqueue(frame("abcdefghij"), () => {
      acknowledged = true;
    });

    state.scheduled.shift()?.();
    expect(state.writes[0]?.data).toBe("abcd");
    state.writes[0]?.parsed();
    state.scheduled.shift()?.();
    expect(state.writes[1]?.data).toBe("efgh");
    expect(acknowledged).toBeFalse();
    state.writes[1]?.parsed();
    state.scheduled.shift()?.();
    expect(state.writes[2]?.data).toBe("ij");
    state.writes[2]?.parsed();
    expect(acknowledged).toBeTrue();
  });

  test("bounds queued bytes and settles discarded frame leases", () => {
    const state = harness({ chunkBytes: 4, maxQueuedBytes: 8 });
    const acknowledged: string[] = [];
    state.scheduler.enqueue(frame("123456"), () => acknowledged.push("first"));
    state.scheduler.enqueue(frame("overflow"), () =>
      acknowledged.push("overflow"),
    );

    expect(state.overflowCount()).toBe(1);
    expect(acknowledged).toEqual(["overflow", "first"]);
    expect(state.scheduler.snapshot()).toMatchObject({
      queuedBytes: 0,
      overflowCount: 1,
    });
  });

  test("a reset supersedes queued output without leaking acknowledgements", () => {
    const state = harness();
    const acknowledged: string[] = [];
    state.scheduler.enqueue(frame("stale"), () => acknowledged.push("stale"));
    state.scheduler.enqueue(frame("", { kind: "reset", seq: 9 }), () =>
      acknowledged.push("reset"),
    );

    expect(acknowledged).toEqual(["stale"]);
    state.scheduled.shift()?.();
    expect(state.started[0]?.kind).toBe("reset");
    expect(acknowledged).toEqual(["stale", "reset"]);
  });

  test("a reset waits for an in-flight write and discards only its queued tail", () => {
    const state = harness({ chunkBytes: 8 });
    const acknowledged: string[] = [];
    state.scheduler.enqueue(frame("active"), () => acknowledged.push("active"));
    state.scheduled.shift()?.();
    state.scheduler.enqueue(
      frame("queued", { allowCapabilityReplies: true }),
      () => acknowledged.push("queued"),
    );
    state.scheduler.enqueue(frame("", { kind: "reset", seq: 12 }), () =>
      acknowledged.push("reset"),
    );

    expect(acknowledged).toEqual(["queued"]);
    state.writes[0]?.parsed();
    expect(acknowledged).toEqual(["queued", "active"]);
    state.scheduled.shift()?.();
    expect(state.started.map((next) => next.kind)).toEqual(["output", "reset"]);
    expect(acknowledged).toEqual(["queued", "active", "reset"]);
  });
});
