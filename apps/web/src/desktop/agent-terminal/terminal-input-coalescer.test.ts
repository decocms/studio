import { describe, expect, test } from "bun:test";
import { TerminalInputCoalescer } from "./terminal-input-coalescer";

function harness(maxPendingCodeUnits = 4_096) {
  const writes: string[] = [];
  const scheduled: Array<() => void> = [];
  const coalescer = new TerminalInputCoalescer((data) => writes.push(data), {
    maxPendingCodeUnits,
    schedule: (callback) => scheduled.push(callback),
  });
  return { coalescer, scheduled, writes };
}

describe("TerminalInputCoalescer", () => {
  test("writes the first input immediately and coalesces the rest of the turn", () => {
    const state = harness();

    state.coalescer.enqueue("first");
    state.coalescer.enqueue("second");
    state.coalescer.enqueue("third");
    expect(state.writes).toEqual(["first"]);

    state.scheduled.shift()?.();
    expect(state.writes).toEqual(["first", "secondthird"]);
  });

  test("preserves order while bounding coalesced payloads", () => {
    const state = harness(5);

    state.coalescer.enqueue("a");
    state.coalescer.enqueue("1234");
    state.coalescer.enqueue("56");
    state.coalescer.enqueue("oversized");
    state.scheduled.shift()?.();

    expect(state.writes).toEqual(["a", "1234", "56", "oversized"]);
    expect(state.writes.join("")).toBe("a123456oversized");
  });

  test("flushes pending input before a control frame", () => {
    const ordered: string[] = [];
    const scheduled: Array<() => void> = [];
    const coalescer = new TerminalInputCoalescer(
      (data) => ordered.push(`input:${data}`),
      { schedule: (callback) => scheduled.push(callback) },
    );

    coalescer.enqueue("a");
    coalescer.enqueue("b");
    coalescer.flush();
    ordered.push("control:ack");
    scheduled.shift()?.();

    expect(ordered).toEqual(["input:a", "input:b", "control:ack"]);
  });

  test("clear invalidates a scheduled flush across socket replacement", () => {
    const state = harness();

    state.coalescer.enqueue("old-immediate");
    state.coalescer.enqueue("old-pending");
    state.coalescer.clear();
    state.coalescer.enqueue("new-immediate");
    state.coalescer.enqueue("new-pending");

    state.scheduled.shift()?.();
    expect(state.writes).toEqual(["old-immediate", "new-immediate"]);
    state.scheduled.shift()?.();
    expect(state.writes).toEqual([
      "old-immediate",
      "new-immediate",
      "new-pending",
    ]);
  });
});
