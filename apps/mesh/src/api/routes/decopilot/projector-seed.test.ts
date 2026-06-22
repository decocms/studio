import { expect, test } from "bun:test";
import type { ThreadMessagePart } from "@/storage/fold-parts";
import { buildSeedFromParts, foldedToUIMessage } from "./projector-seed";
import { foldParts } from "@/storage/fold-parts";

// Minimal factory for ThreadMessagePart rows
const part = (overrides: Partial<ThreadMessagePart>): ThreadMessagePart => ({
  id: "x",
  seq: 0,
  org_id: "o",
  thread_id: "t",
  run_id: "r",
  message_id: "m1",
  role: "assistant",
  kind: "text",
  payload: {},
  payload_ref: null,
  metadata: null,
  created_at: "2026-01-01T00:00:00Z",
  ...overrides,
});

// --- buildSeedFromParts ---

test("seeds only completed messages (those with a finish part)", () => {
  const seed = buildSeedFromParts([
    part({
      message_id: "m1",
      seq: 1,
      kind: "text",
      payload: { type: "text", text: "done msg" },
    }),
    part({ message_id: "m1", seq: 2, kind: "finish", payload: {} }),
    part({
      message_id: "m2",
      seq: 3,
      kind: "text",
      payload: { type: "text", text: "still open" },
    }),
  ]);
  expect(seed.map((m) => m.id)).toEqual(["m1"]); // m2 has no finish → excluded
});

test("empty input produces empty seed", () => {
  expect(buildSeedFromParts([])).toEqual([]);
});

test("all in-progress messages → empty seed", () => {
  const seed = buildSeedFromParts([
    part({
      message_id: "m1",
      seq: 1,
      kind: "text",
      payload: { type: "text", text: "streaming" },
    }),
  ]);
  expect(seed).toHaveLength(0);
});

test("multiple completed messages all included in order", () => {
  const seed = buildSeedFromParts([
    part({
      message_id: "m1",
      seq: 1,
      kind: "text",
      payload: {},
      created_at: "2026-01-01T00:00:01Z",
    }),
    part({
      message_id: "m1",
      seq: 2,
      kind: "finish",
      payload: {},
      created_at: "2026-01-01T00:00:01Z",
    }),
    part({
      message_id: "m2",
      seq: 3,
      kind: "text",
      payload: {},
      created_at: "2026-01-01T00:00:02Z",
    }),
    part({
      message_id: "m2",
      seq: 4,
      kind: "finish",
      payload: {},
      created_at: "2026-01-01T00:00:02Z",
    }),
  ]);
  expect(seed.map((m) => m.id)).toEqual(["m1", "m2"]);
});

// --- foldedToUIMessage ---

test("foldedToUIMessage maps id/role/parts correctly", () => {
  const [m1] = foldParts([
    part({
      message_id: "m1",
      seq: 1,
      kind: "text",
      payload: { type: "text", text: "hi" },
    }),
    part({ message_id: "m1", seq: 2, kind: "finish", payload: {} }),
  ]);
  const ui = foldedToUIMessage(m1!);
  expect(ui.id).toBe("m1");
  expect(ui.role).toBe("assistant");
  // finish part is excluded from folded.parts, so the UI message has 1 part
  expect((ui.parts as unknown[]).length).toBe(1);
});

test("foldedToUIMessage sets metadata to undefined when null", () => {
  const [m] = foldParts([
    part({ message_id: "m1", seq: 1, kind: "text", payload: {} }),
    part({
      message_id: "m1",
      seq: 2,
      kind: "finish",
      payload: {},
      metadata: null,
    }),
  ]);
  const ui = foldedToUIMessage(m!);
  expect(ui.metadata).toBeUndefined();
});
