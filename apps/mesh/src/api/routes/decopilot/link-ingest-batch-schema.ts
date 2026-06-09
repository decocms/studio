import { z } from "zod";

const partKindSchema = z.enum([
  "text",
  "reasoning",
  "tool_call",
  "tool_result",
  "file",
  "error",
  "finish",
]);

const roleSchema = z.enum(["user", "assistant", "system"]);

const requiredUnknownSchema = z
  .unknown()
  .refine((value) => value !== undefined, {
    message: "Required",
  });

const payloadSchema = requiredUnknownSchema.refine((value) => value !== null, {
  message: "Required",
});

export const linkIngestPartRowSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().nonnegative(),
  org_id: z.string().min(1),
  thread_id: z.string().min(1),
  run_id: z.string().min(1),
  message_id: z.string().min(1),
  role: roleSchema,
  kind: partKindSchema,
  payload: payloadSchema,
  payload_ref: z.string().nullable(),
  metadata: requiredUnknownSchema.nullable(),
  created_at: z.string().datetime(),
});

export const linkIngestBatchSchema = z.object({
  batchId: z.string().min(1),
  rows: z.array(linkIngestPartRowSchema).max(512),
  done: z.boolean().default(false),
});

export type LinkIngestBatch = z.infer<typeof linkIngestBatchSchema>;
