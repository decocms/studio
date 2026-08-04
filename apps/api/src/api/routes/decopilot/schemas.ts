/**
 * Decopilot Request Schemas
 *
 * Zod validation schemas for Decopilot API requests.
 */

import { SimpleModeTierSchema } from "@decocms/shared/organization/schema";
import { z } from "zod";
import { DEFAULT_WINDOW_SIZE } from "./constants";

// AI SDK messages are intentionally extensible at the message boundary.
// Routing authority lives only on the strict request envelope below.
const UIMessageSchema = z.looseObject({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(z.record(z.string(), z.unknown())),
  metadata: z.unknown().optional(),
});

const MemoryConfigSchema = z
  .object({
    // Flows straight into a DB query LIMIT (`Memory.loadHistory` →
    // `listMessages`/`loadWindow`) with no other bound — an unvalidated huge or
    // negative value would either force-load a thread's entire history on every
    // turn or blow up the query at the DB layer.
    windowSize: z.number().int().min(1).max(500).default(DEFAULT_WINDOW_SIZE),
  })
  .strict();

export const StreamRequestSchema = z
  .object({
    messages: z
      .array(UIMessageSchema)
      .min(1)
      .refine((msgs) => msgs.filter((m) => m.role !== "system").length === 1, {
        message: "Expected exactly one non-system message",
      }),
    memory: MemoryConfigSchema.optional(),
    tier: SimpleModeTierSchema.optional(),
    temperature: z.number().default(0.5),
    /**
     * Git branch to pin the thread to on first-message creation. Only honored
     * when the thread doesn't exist yet; existing threads keep their branch.
     */
    branch: z.string().nullish(),
    toolApprovalLevel: z.enum(["auto", "readonly"]).default("auto"),
    mode: z
      .enum(["default", "plan", "web-search", "deep-research", "gen-image"])
      .default("default"),
  })
  .strict();

export type StreamRequest = z.infer<typeof StreamRequestSchema>;
