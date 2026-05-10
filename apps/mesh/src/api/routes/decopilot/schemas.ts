/**
 * Decopilot Request Schemas
 *
 * Zod validation schemas for Decopilot API requests.
 */

import { SimpleModeTierSchema } from "@/tools/organization/schema";
import { z } from "zod";
import { DEFAULT_WINDOW_SIZE } from "./constants";

const UIMessageSchema = z.looseObject({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(z.record(z.string(), z.unknown())),
  metadata: z.unknown().optional(),
});

const MemoryConfigSchema = z.object({
  windowSize: z.number().default(DEFAULT_WINDOW_SIZE),
  thread_id: z.string(),
});

export const StreamRequestSchema = z.object({
  messages: z
    .array(UIMessageSchema)
    .min(1)
    .refine((msgs) => msgs.filter((m) => m.role !== "system").length === 1, {
      message: "Expected exactly one non-system message",
    }),
  memory: MemoryConfigSchema.optional(),
  tier: SimpleModeTierSchema.optional(),
  agent: z
    .object({
      id: z.string(),
    })
    .loose(),
  stream: z.boolean().optional(),
  temperature: z.number().default(0.5),
  thread_id: z.string().optional(),
  /**
   * Git branch to pin the thread to on first-message creation. Only honored
   * when the thread doesn't exist yet; existing threads keep their branch.
   */
  branch: z.string().nullish(),
  toolApprovalLevel: z.enum(["auto", "readonly"]).default("auto"),
  mode: z
    .enum(["default", "plan", "web-search", "gen-image"])
    .default("default"),
});

export type StreamRequest = z.infer<typeof StreamRequestSchema>;
