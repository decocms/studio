import { describe, expect, it } from "bun:test";
import type { UplinkIngestSession } from "./uplink-ingest";
import { createUplinkConnection } from "./uplink-ws-handler";

function fakeSession() {
  const calls: Array<{ kind: string; arg: unknown }> = [];
  const session = {
    ackSeq: 0,
    onFrame: async (f: unknown) => {
      calls.push({ kind: "onFrame", arg: f });
    },
    onResume: async (f: unknown) => {
      calls.push({ kind: "onResume", arg: f });
      return {
        type: "accept" as const,
        runId: "r",
        fenceToken: "f",
        ackSeq: 0,
        cancelled: false,
      };
    },
  } satisfies UplinkIngestSession;
  return { session, calls };
}

function conn(opts?: { onFrameThrows?: boolean }) {
  const closes: Array<{ code: number; reason?: string }> = [];
  const { session, calls } = fakeSession();
  if (opts?.onFrameThrows) {
    session.onFrame = async () => {
      throw new Error("[uplink-ingest] fence mismatch for runId=r");
    };
  }
  const c = createUplinkConnection({
    sessionFor: () => session,
    close: (code, reason) => {
      closes.push({ code, reason });
    },
  });
  return { c, closes, calls };
}

const chunkFrame = {
  type: "chunk",
  runId: "r",
  fenceToken: "f",
  wireSeq: 1,
  lane: 2,
  chunk: { type: "text-delta", id: "m", delta: "x" },
};

describe("createUplinkConnection", () => {
  it("routes a chunk frame to the session's onFrame", async () => {
    const { c, calls } = conn();
    await c.onMessage(JSON.stringify(chunkFrame));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.kind).toBe("onFrame");
  });

  it("routes a resume frame to the session's onResume", async () => {
    const { c, calls } = conn();
    await c.onMessage(
      JSON.stringify({
        type: "resume",
        runId: "r",
        fenceToken: "f",
        fromSeq: 2,
      }),
    );
    expect(calls[0]!.kind).toBe("onResume");
  });

  it("closes 1002 on a non-string (binary) message", async () => {
    const { c, closes } = conn();
    await c.onMessage(new Uint8Array([1, 2, 3]));
    expect(closes[0]!.code).toBe(1002);
  });

  it("closes 1002 on malformed JSON", async () => {
    const { c, closes } = conn();
    await c.onMessage("not-json{{{");
    expect(closes[0]!.code).toBe(1002);
  });

  it("closes 1002 on a schema-invalid frame", async () => {
    const { c, closes } = conn();
    await c.onMessage(JSON.stringify({ type: "bogus" }));
    expect(closes[0]!.code).toBe(1002);
  });

  it("closes 1008 (policy) when the session rejects a frame (P3 / fence)", async () => {
    const { c, closes } = conn({ onFrameThrows: true });
    await c.onMessage(JSON.stringify(chunkFrame));
    expect(closes[0]!.code).toBe(1008);
    expect(closes[0]!.reason).toMatch(/fence/i);
  });
});
