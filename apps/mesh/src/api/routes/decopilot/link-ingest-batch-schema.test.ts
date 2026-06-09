import { describe, expect, it } from "bun:test";
import { linkIngestBatchSchema } from "./link-ingest-batch-schema";

const row = {
  id: "run_1:0",
  seq: 0,
  org_id: "org_1",
  thread_id: "run_1",
  run_id: "run_1",
  message_id: "assistant_1",
  role: "assistant",
  kind: "text",
  payload: { type: "text", text: "hello" },
  payload_ref: null,
  metadata: null,
  created_at: "2026-06-09T00:00:00.000Z",
};

describe("linkIngestBatchSchema", () => {
  it("accepts rows with done false", () => {
    const parsed = linkIngestBatchSchema.parse({
      batchId: "batch_1",
      rows: [row],
      done: false,
    });
    expect(parsed.rows).toHaveLength(1);
  });

  it("accepts a terminal empty batch", () => {
    const parsed = linkIngestBatchSchema.parse({
      batchId: "batch_final",
      rows: [],
      done: true,
    });
    expect(parsed.done).toBe(true);
  });

  it("accepts row shape without path-level run matching", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_bad",
      rows: [{ ...row, run_id: "other" }],
      done: false,
    });
    expect(parsed.success).toBe(true);
  });
});
