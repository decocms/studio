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

  it("rejects terminal batches with rows", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_final_with_rows",
      rows: [row],
      done: true,
    });
    expect(parsed.success).toBe(false);
  });

  it("accepts row shape without path-level run matching", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_bad",
      rows: [{ ...row, run_id: "other" }],
      done: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects rows without payload", () => {
    const { payload, ...rowWithoutPayload } = row;
    void payload;

    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_missing_payload",
      rows: [rowWithoutPayload],
      done: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects rows without metadata", () => {
    const { metadata, ...rowWithoutMetadata } = row;
    void metadata;

    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_missing_metadata",
      rows: [rowWithoutMetadata],
      done: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects rows with null payload", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_null_payload",
      rows: [{ ...row, payload: null }],
      done: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects rows with invalid kind", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_invalid_kind",
      rows: [{ ...row, kind: "unknown" }],
      done: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects rows with invalid role", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_invalid_role",
      rows: [{ ...row, role: "tool" }],
      done: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects rows with invalid created_at", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_invalid_created_at",
      rows: [{ ...row, created_at: "not-a-date" }],
      done: false,
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects batches with more than 512 rows", () => {
    const parsed = linkIngestBatchSchema.safeParse({
      batchId: "batch_too_large",
      rows: Array.from({ length: 513 }, (_, seq) => ({
        ...row,
        id: `run_1:${seq}`,
        seq,
      })),
      done: false,
    });
    expect(parsed.success).toBe(false);
  });
});
