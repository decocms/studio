import { describe, expect, test } from "bun:test";
import {
  buildCheckpointMsgId,
  buildChunkMsgId,
  buildDoneMsgId,
  isCheckpointEnvelope,
  isDoneEnvelope,
  parseRunStreamMsgId,
  runIdFromSubject,
  streamSubject,
} from "./projector-stream-messages";

describe("projector stream message helpers", () => {
  test("builds and parses chunk msg ids", () => {
    const msgId = buildChunkMsgId({
      runId: "run_1",
      fenceToken: "fence_a",
      seq: 12,
    });
    expect(msgId).toBe("run_1:fence_a:12");
    expect(parseRunStreamMsgId(msgId)).toEqual({
      kind: "chunk",
      runId: "run_1",
      fenceToken: "fence_a",
      seq: 12,
      fragmentIndex: null,
    });
  });

  test("builds and parses fragment msg ids", () => {
    const msgId = buildChunkMsgId({
      runId: "run_1",
      fenceToken: "fence_a",
      seq: 12,
      fragmentIndex: 3,
    });
    expect(msgId).toBe("run_1:fence_a:12:frag:3");
    expect(parseRunStreamMsgId(msgId)).toEqual({
      kind: "chunk",
      runId: "run_1",
      fenceToken: "fence_a",
      seq: 12,
      fragmentIndex: 3,
    });
  });

  test("builds and parses done msg ids", () => {
    const msgId = buildDoneMsgId({
      runId: "run_1",
      fenceToken: "fence_a",
      finalSeq: 42,
    });
    expect(msgId).toBe("run_1:fence_a:done:42");
    expect(parseRunStreamMsgId(msgId)).toEqual({
      kind: "done",
      runId: "run_1",
      fenceToken: "fence_a",
      finalSeq: 42,
    });
  });

  test("rejects malformed msg ids", () => {
    expect(parseRunStreamMsgId(undefined)).toBeNull();
    expect(parseRunStreamMsgId("run:f:not-a-number")).toBeNull();
    expect(parseRunStreamMsgId("run:f:done:not-a-number")).toBeNull();
    expect(parseRunStreamMsgId("run:f:1:frag:not-a-number")).toBeNull();
  });

  test("builds and parses safe stream subjects", () => {
    expect(streamSubject("run_1")).toBe("decopilot.stream.run_1");
    expect(runIdFromSubject("decopilot.stream.run_1")).toBe("run_1");
    expect(runIdFromSubject("other.stream.run_1")).toBeNull();
    expect(() => streamSubject("bad token")).toThrow(
      "Invalid NATS subject token",
    );
  });

  test("recognizes done envelopes with a final sequence", () => {
    expect(isDoneEnvelope({ done: true, finalSeq: 3 })).toBe(true);
    expect(isDoneEnvelope({ done: true })).toBe(false);
    expect(isDoneEnvelope({ done: false, finalSeq: 3 })).toBe(false);
    expect(isDoneEnvelope(null)).toBe(false);
  });
});

// --- checkpoint build/parse ---
test("buildCheckpointMsgId produces the expected format", () => {
  expect(
    buildCheckpointMsgId({ runId: "r1", fenceToken: "f1", headSeq: 42 }),
  ).toBe("r1:f1:ckpt:42");
});

test("parseRunStreamMsgId round-trips a checkpoint msgId", () => {
  const id = buildCheckpointMsgId({
    runId: "r1",
    fenceToken: "f1",
    headSeq: 42,
  });
  expect(parseRunStreamMsgId(id)).toEqual({
    kind: "checkpoint",
    runId: "r1",
    fenceToken: "f1",
    headSeq: 42,
  });
});

test("parseRunStreamMsgId returns null for malformed checkpoint (non-positive)", () => {
  expect(parseRunStreamMsgId("r1:f1:ckpt:0")).toBeNull();
  expect(parseRunStreamMsgId("r1:f1:ckpt:-1")).toBeNull();
  expect(parseRunStreamMsgId("r1:f1:ckpt:notanumber")).toBeNull();
});

// --- isCheckpointEnvelope ---
test("isCheckpointEnvelope accepts valid checkpoint envelope", () => {
  expect(isCheckpointEnvelope({ checkpoint: true, headSeq: 5 })).toBe(true);
});

test("isCheckpointEnvelope rejects done envelope", () => {
  expect(isCheckpointEnvelope({ done: true, finalSeq: 5 })).toBe(false);
});

test("isCheckpointEnvelope rejects partial objects", () => {
  expect(isCheckpointEnvelope({ checkpoint: true })).toBe(false);
  expect(isCheckpointEnvelope({ headSeq: 5 })).toBe(false);
  expect(isCheckpointEnvelope(null)).toBe(false);
});

// --- existing tests: chunk + done still parse ---
test("parseRunStreamMsgId still handles chunk msgId", () => {
  expect(parseRunStreamMsgId("r1:f1:3")).toEqual({
    kind: "chunk",
    runId: "r1",
    fenceToken: "f1",
    seq: 3,
    fragmentIndex: null,
  });
});

test("parseRunStreamMsgId still handles done msgId", () => {
  expect(parseRunStreamMsgId("r1:f1:done:10")).toEqual({
    kind: "done",
    runId: "r1",
    fenceToken: "f1",
    finalSeq: 10,
  });
});
