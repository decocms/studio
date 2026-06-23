import { describe, expect, test } from "bun:test";
import {
  consumeProjectorMessages,
  runIdFromSubject,
} from "./projector-consumer";

function source() {
  const acked: string[] = [];
  const msgs: Array<{
    subject: string;
    data: Uint8Array;
    msgId?: string;
    ack(): Promise<void>;
    term(): Promise<void>;
  }> = [];
  const push = (subject: string, payload: unknown, msgId?: string) => {
    const raw = JSON.stringify(payload);
    msgs.push({
      subject,
      data: new TextEncoder().encode(raw),
      msgId,
      ack: async () => {
        acked.push(raw);
      },
      term: async () => {},
    });
  };
  const pushRaw = (subject: string, raw: string, msgId?: string) => {
    msgs.push({
      subject,
      data: new TextEncoder().encode(raw),
      msgId,
      ack: async () => {
        acked.push(raw);
      },
      term: async () => {},
    });
  };
  return {
    push,
    pushRaw,
    acked,
    iterable: (async function* () {
      for (const m of msgs) yield m;
    })(),
  };
}

describe("projector scheduler consumer", () => {
  test("acks chunks without accumulating them", async () => {
    const s = source();
    const scheduled: unknown[] = [];
    s.push(
      "decopilot.stream.run_1",
      { p: { type: "start" } },
      "run_1:fence_a:1",
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async (input) => {
        scheduled.push(input);
      },
    });

    expect(s.acked).toHaveLength(1);
    expect(scheduled).toEqual([]);
  });

  test("acks an unparseable fragment instead of looping on it", async () => {
    const s = source();
    // A fragmented chunk delivers a raw byte-slice of `{"p":...}` JSON, which
    // is not valid JSON on its own. It must be acked-and-skipped, NOT left
    // unacked (which would make JetStream redeliver the poison fragment forever
    // — the prod stdout-spam bug).
    s.pushRaw(
      "decopilot.stream.run_1",
      '{"p":{"text":"unter',
      "run_1:fence_a:1",
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async () => {},
    });

    expect(s.acked).toHaveLength(1);
  });

  test("schedules done and acks only after enqueue succeeds", async () => {
    const s = source();
    const scheduled: unknown[] = [];
    s.push(
      "decopilot.stream.run_1",
      { done: true, finalSeq: 7 },
      "run_1:fence_a:done:7",
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async (input) => {
        scheduled.push(input);
      },
    });

    expect(scheduled).toEqual([
      { runId: "run_1", fenceToken: "fence_a", finalSeq: 7, orgId: "org_1" },
    ]);
    expect(s.acked).toHaveLength(1);
  });

  test("does not ack done when enqueue fails", async () => {
    const s = source();
    s.push(
      "decopilot.stream.run_1",
      { done: true, finalSeq: 7 },
      "run_1:fence_a:done:7",
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async () => {
        throw new Error("dbos down");
      },
    });

    expect(s.acked).toHaveLength(0);
  });

  test("schedules a checkpoint and acks it", async () => {
    const s = source();
    const checkpoints: unknown[] = [];
    s.push(
      "decopilot.stream.run_1",
      { checkpoint: true, headSeq: 5 },
      "run_1:fence_a:ckpt:5",
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async () => {},
      enqueueProjectCheckpoint: async (input) => {
        checkpoints.push(input);
      },
    });

    expect(checkpoints).toEqual([
      { runId: "run_1", fenceToken: "fence_a", headSeq: 5, orgId: "org_1" },
    ]);
    expect(s.acked).toHaveLength(1);
  });

  test("acks checkpoint without scheduling when handler is absent", async () => {
    const s = source();
    s.push(
      "decopilot.stream.run_1",
      { checkpoint: true, headSeq: 5 },
      "run_1:fence_a:ckpt:5",
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async () => {},
      // no enqueueProjectCheckpoint
    });

    expect(s.acked).toHaveLength(1);
  });

  test("does not ack checkpoint when enqueue throws", async () => {
    const s = source();
    s.push(
      "decopilot.stream.run_1",
      { checkpoint: true, headSeq: 5 },
      "run_1:fence_a:ckpt:5",
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async () => {},
      enqueueProjectCheckpoint: async () => {
        throw new Error("dbos down");
      },
    });

    expect(s.acked).toHaveLength(0);
  });

  test("ignores checkpoint with mismatched msgId headSeq", async () => {
    const s = source();
    const checkpoints: unknown[] = [];
    s.push(
      "decopilot.stream.run_1",
      { checkpoint: true, headSeq: 5 },
      "run_1:fence_a:ckpt:9", // msgId headSeq 9 != payload headSeq 5
    );

    await consumeProjectorMessages({
      messages: s.iterable,
      resolveOrgId: async () => "org_1",
      enqueueProjectRun: async () => {},
      enqueueProjectCheckpoint: async (input) => {
        checkpoints.push(input);
      },
    });

    expect(checkpoints).toEqual([]); // validation failed → not scheduled
    expect(s.acked).toHaveLength(1); // but still acked (best-effort)
  });
});

describe("runIdFromSubject", () => {
  test("extracts the run id token from decopilot.stream.<runId>", () => {
    expect(runIdFromSubject("decopilot.stream.run_123")).toBe("run_123");
    expect(runIdFromSubject("garbage")).toBeNull();
  });
});
