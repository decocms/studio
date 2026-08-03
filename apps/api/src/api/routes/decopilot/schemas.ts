/**
 * Decopilot Request Schemas
 *
 * Zod validation schemas for Decopilot API requests.
 */

import { SimpleModeTierSchema } from "@decocms/shared/organization/schema";
import { z } from "zod";
import { DEFAULT_WINDOW_SIZE } from "./constants";

const UIMessageSchema = z.looseObject({
  id: z.string().optional(),
  role: z.enum(["user", "assistant", "system"]),
  parts: z.array(z.record(z.string(), z.unknown())),
  metadata: z.unknown().optional(),
});

const MemoryConfigSchema = z.object({
  // Flows straight into a DB query LIMIT (`Memory.loadHistory` →
  // `listMessages`/`loadWindow`) with no other bound — an unvalidated huge or
  // negative value would either force-load a thread's entire history on every
  // turn or blow up the query at the DB layer.
  windowSize: z.number().int().min(1).max(500).default(DEFAULT_WINDOW_SIZE),
  thread_id: z.string(),
});

const LegacyAgentSchema = z
  .object({
    id: z.string(),
  })
  .loose()
  .describe(
    "Deprecated compatibility field. Hosted execution derives the agent from the thread.",
  );

const StreamRequestInputSchema = z
  .object({
    messages: z
      .array(UIMessageSchema)
      .min(1)
      .refine((msgs) => msgs.filter((m) => m.role !== "system").length === 1, {
        message: "Expected exactly one non-system message",
      }),
    memory: MemoryConfigSchema.optional(),
    tier: SimpleModeTierSchema.optional(),
    agent: LegacyAgentSchema.optional(),
    stream: z.boolean().optional(),
    temperature: z.number().default(0.5),
    thread_id: z.string().optional(),
    /**
     * Git branch to pin the thread to on first-message creation. Only honored
     * when the thread doesn't exist yet; existing threads keep their branch.
     */
    branch: z.string().nullish(),
    toolApprovalLevel: z.enum(["auto", "readonly"]).default("auto"),
    sandboxProviderKind: z
      .enum(["agent-sandbox", "cluster"])
      .nullish()
      .describe(
        "Deprecated compatibility field. Hosted chat always uses the managed agent sandbox.",
      ),
    harnessId: z
      .literal("decopilot")
      .nullish()
      .describe(
        "Deprecated compatibility field. Hosted chat always uses Decopilot.",
      ),
    mode: z
      .enum(["default", "plan", "web-search", "deep-research", "gen-image"])
      .default("default"),
  })
  .strict();

/**
 * Accept the previous hosted request envelope during the rolling client
 * cutover, but remove its routing selectors from the parsed contract. Their
 * schemas remain deliberately narrow so a typo or a retired native runtime is
 * rejected instead of being mistaken for a supported hosted configuration.
 */
export const StreamRequestSchema = StreamRequestInputSchema.transform(
  ({
    agent: _legacyAgent,
    harnessId: _legacyHarnessId,
    sandboxProviderKind: _legacySandboxProviderKind,
    ...request
  }) => request,
);

export type StreamRequest = z.infer<typeof StreamRequestSchema>;
