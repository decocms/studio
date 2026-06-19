import type { MessagesRef } from "@decocms/harness/offload-messages";
import { z } from "zod";

const workItemRepoSchema = z.object({
  cloneUrl: z.string(),
  branch: z.string().optional(),
  userName: z.string().optional(),
  userEmail: z.string().optional(),
});

const workItemWorkloadSchema = z.object({
  runtime: z.enum(["node", "bun", "deno"]),
  packageManager: z.enum(["npm", "pnpm", "yarn", "bun", "deno"]),
  devPort: z.number().optional(),
  packageManagerPath: z.string().optional(),
});

const workItemOperatorSchema = z.object({
  userName: z.string(),
  userEmail: z.string().optional(),
});

const workItemSandboxSchema = z.object({
  handle: z.string(),
  repo: workItemRepoSchema.optional(),
  workload: workItemWorkloadSchema.optional(),
  operator: workItemOperatorSchema.optional(),
  offloadAllowedHosts: z.array(z.string()).optional(),
  offloadAllowSameHostDev: z.boolean().optional(),
  orgFsConfigJson: z.string().optional(),
});

export type WorkItemSandbox = z.infer<typeof workItemSandboxSchema>;

export const workItemSchema = z.object({
  runId: z.string(),
  threadId: z.string(),
  orgId: z.string(),
  userId: z.string(),
  runFenceToken: z.string(),
  harnessInput: z.record(z.string(), z.unknown()),
  sandbox: workItemSandboxSchema.optional(),
  orgSlug: z.string(),
  messagesRef: z
    .object({
      url: z.string(),
      bytes: z.number(),
      sha256: z.string(),
    })
    .optional(),
});

export type WorkItem = z.infer<typeof workItemSchema>;
export type { MessagesRef };
