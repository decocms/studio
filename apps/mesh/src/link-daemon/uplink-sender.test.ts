import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { UplinkFrame } from "../links/protocol/uplink-frames";
import { openOutbox, type Outbox } from "./outbox";
import { createUplinkSender } from "./uplink-sender";

const FENCE = "fence-1";
const RUN = "run_1";

function withOutbox(fn: (outbox: Outbox) => Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "sender-"));
    const outbox = openOutbox({ path: join(dir, "ob.sqlite") });
    try {
      await fn(outbox);
    } finally {
      outbox.close();
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function appendChunk(outbox: Outbox, wireSeq: number) {
  outbox.append({
    runId: RUN,
    fenceToken: FENCE,
    wireSeq,
    lane: 2,
    line: {
      seq: wireSeq,
      event: {
        type: "ui-message-chunk",
        chunk: { type: "text-delta", delta: "x" },
      },
    },
  });
}

function makeSender(outbox: Outbox, opts?: { onCancel?: () => void }) {
  const sent: UplinkFrame[] = [];
  const sender = createUplinkSender({
    runId: RUN,
    fenceToken: FENCE,
    machineId: "m1",
    outbox,
    getAccessToken: async () => "tok-123",
    send: (frame) => sent.push(frame),
    onCancel: opts?.onCancel ?? (() => {}),
  });
  return { sender, sent };
}

describe("createUplinkSender", () => {
  it(
    "on start sends hello{bearer} then replays the outbox as chunk frames",
    withOutbox(async (outbox) => {
      appendChunk(outbox, 1);
      appendChunk(outbox, 2);
      const { sender, sent } = makeSender(outbox);
      await sender.start();

      expect(sent[0]).toEqual({
        type: "hello",
        machineId: "m1",
        protocol: 2,
        bearer: "tok-123",
      });
      expect(sent.slice(1).map((f) => f.type)).toEqual(["chunk", "chunk"]);
      expect(
        sent.slice(1).map((f) => (f as { wireSeq: number }).wireSeq),
      ).toEqual([1, 2]);
    }),
  );

  it(
    "an ack frame truncates the acked prefix and advances the cursor",
    withOutbox(async (outbox) => {
      appendChunk(outbox, 1);
      appendChunk(outbox, 2);
      appendChunk(outbox, 3);
      const { sender } = makeSender(outbox);
      await sender.start();
      await sender.onFrame({
        type: "ack",
        runId: RUN,
        fenceToken: FENCE,
        ackSeq: 2,
      });
      // wireSeq 1,2 are durably acked → truncated; only 3 remains.
      expect(
        outbox
          .replay({ runId: RUN, fenceToken: FENCE, fromSeq: 1 })
          .map((r) => r.wireSeq),
      ).toEqual([3]);
    }),
  );

  it(
    "an accept frame resumes from ackSeq+1 (resend the unacked tail)",
    withOutbox(async (outbox) => {
      appendChunk(outbox, 1);
      appendChunk(outbox, 2);
      appendChunk(outbox, 3);
      const { sender, sent } = makeSender(outbox);
      await sender.onFrame({
        type: "accept",
        runId: RUN,
        fenceToken: FENCE,
        ackSeq: 1,
        cancelled: false,
      });
      // Resends from wireSeq 2 (the cluster already has 1).
      expect(sent.map((f) => (f as { wireSeq?: number }).wireSeq)).toEqual([
        2, 3,
      ]);
    }),
  );

  it(
    "an accept{cancelled:true} fires onCancel",
    withOutbox(async (outbox) => {
      let cancelled = 0;
      const { sender } = makeSender(outbox, {
        onCancel: () => {
          cancelled++;
        },
      });
      await sender.onFrame({
        type: "accept",
        runId: RUN,
        fenceToken: FENCE,
        ackSeq: 0,
        cancelled: true,
      });
      expect(cancelled).toBe(1);
    }),
  );

  it(
    "a cancel frame fires onCancel",
    withOutbox(async (outbox) => {
      let cancelled = 0;
      const { sender } = makeSender(outbox, {
        onCancel: () => {
          cancelled++;
        },
      });
      await sender.onFrame({ type: "cancel", runId: RUN, fenceToken: FENCE });
      expect(cancelled).toBe(1);
    }),
  );
});
