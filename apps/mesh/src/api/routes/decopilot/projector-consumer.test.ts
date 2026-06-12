import { describe, expect, test } from "bun:test";
import type { HarnessStreamPersistence } from "./consume-harness-stream";
import {
  consumeProjectorMessages,
  runIdFromSubject,
} from "./projector-consumer";

interface FakeMsg {
  subject: string;
  data: Uint8Array;
  ack(): Promise<void>;
  term(): Promise<void>;
}

function source() {
  const acked: unknown[] = [];
  const termed: unknown[] = [];
  const msgs: FakeMsg[] = [];
  const pushRaw = (subject: string, raw: string) => {
    msgs.push({
      subject,
      data: new TextEncoder().encode(raw),
      ack: async () => {
        acked.push(raw);
      },
      term: async () => {
        termed.push(raw);
      },
    });
  };
  const push = (subject: string, payload: unknown) =>
    pushRaw(subject, JSON.stringify(payload));
  const iterable = (async function* () {
    for (const m of msgs) yield m;
  })();
  return { push, pushRaw, iterable, acked, termed };
}

describe("runIdFromSubject", () => {
  test("extracts the run id token from decopilot.stream.<runId>", () => {
    expect(runIdFromSubject("decopilot.stream.run_123")).toBe("run_123");
    expect(runIdFromSubject("garbage")).toBeNull();
  });
});

describe("consumeProjectorMessages", () => {
  test("projects a run's chunks on the done sentinel and acks every message", async () => {
    const s = source();
    const finals: unknown[] = [];
    const subj = "decopilot.stream.run_1";
    s.push(subj, { p: { type: "start", messageId: "m" } });
    s.push(subj, { p: { type: "text-start", id: "t" } });
    s.push(subj, { p: { type: "text-delta", id: "t", delta: "hi" } });
    s.push(subj, { p: { type: "text-end", id: "t" } });
    s.push(subj, { p: { type: "finish", finishReason: "stop" } });
    s.push(subj, { done: true });

    await consumeProjectorMessages({
      messages: s.iterable,
      persistenceFor: (): HarnessStreamPersistence => ({
        emitStepParts: async () => {},
        emitFinal: async (m) => {
          finals.push(m);
        },
        emitError: async () => {},
      }),
      onRunErrored: async () => {},
    });

    expect(finals).toHaveLength(1);
    expect(s.acked).toHaveLength(6);
    expect(s.termed).toHaveLength(0);
  });

  test("a poison run is surfaced (onRunErrored) and still acked so it never wedges", async () => {
    const s = source();
    const erroredRuns: string[] = [];
    const subj = "decopilot.stream.run_x";
    s.push(subj, { p: { type: "start" } });
    s.push(subj, { p: { type: "finish" } });
    s.push(subj, { done: true });

    await consumeProjectorMessages({
      messages: s.iterable,
      persistenceFor: (): HarnessStreamPersistence => ({
        emitStepParts: async () => {},
        emitFinal: async () => {
          throw new Error("db down");
        },
        emitError: async () => {},
      }),
      onRunErrored: async (runId) => {
        erroredRuns.push(runId);
      },
    });

    expect(erroredRuns).toEqual(["run_x"]);
    // Acked (not termed) — the run is marked failed; redelivery would just wedge.
    expect(s.acked).toHaveLength(3);
    expect(s.termed).toHaveLength(0);
  });

  test("groups concurrent runs independently", async () => {
    const s = source();
    const finals = new Map<string, number>();
    s.push("decopilot.stream.A", { p: { type: "start" } });
    s.push("decopilot.stream.B", { p: { type: "start" } });
    s.push("decopilot.stream.A", { p: { type: "finish" } });
    s.push("decopilot.stream.A", { done: true });
    s.push("decopilot.stream.B", { p: { type: "finish" } });
    s.push("decopilot.stream.B", { done: true });

    await consumeProjectorMessages({
      messages: s.iterable,
      persistenceFor: (runId): HarnessStreamPersistence => ({
        emitStepParts: async () => {},
        emitFinal: async () => {
          finals.set(runId, (finals.get(runId) ?? 0) + 1);
        },
        emitError: async () => {},
      }),
      onRunErrored: async () => {},
    });

    expect(finals.get("A")).toBe(1);
    expect(finals.get("B")).toBe(1);
  });

  test("skips a malformed message and recovers", async () => {
    const s = source();
    let finalCount = 0;
    const subj = "decopilot.stream.run_m";
    s.push(subj, { p: { type: "start" } });
    s.pushRaw(subj, "not-json{{{");
    s.push(subj, { p: { type: "finish" } });
    s.push(subj, { done: true });

    await consumeProjectorMessages({
      messages: s.iterable,
      persistenceFor: (): HarnessStreamPersistence => ({
        emitStepParts: async () => {},
        emitFinal: async () => {
          finalCount++;
        },
        emitError: async () => {},
      }),
      onRunErrored: async () => {},
    });

    expect(finalCount).toBe(1);
    expect(s.acked.length).toBeGreaterThanOrEqual(3);
  });
});
