/**
 * COLLECTION_THREADS_CREATE Tool
 *
 * Create a new thread for a virtual MCP.
 *
 * Branch resolution (only meaningful when the vMCP has a githubRepo):
 *   1. Honor `data.branch` when provided.
 *   2. Otherwise isolate the chat on its own synthetic `thread:<id>` branch
 *      (the same per-thread scheme `load_repo` uses), so concurrent chats never
 *      share a working branch.
 *
 * Threads created on a vMCP without a githubRepo always get `branch = null`.
 *
 * Idempotent on `id` collisions (storage uses INSERT … ON CONFLICT DO NOTHING).
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { normalizeThreadForResponse } from "./helpers";
import {
  ThreadCreateDataSchema,
  ThreadEntitySchema,
} from "@decocms/shared/thread/schema";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import { threadBranch } from "../sandbox/thread-repo";

const CreateInputSchema = z.object({
  data: ThreadCreateDataSchema.describe(
    "Data for the new thread (id is auto-generated if not provided)",
  ),
});

export type CreateThreadInput = z.infer<typeof CreateInputSchema>;

const CreateOutputSchema = z.object({
  item: ThreadEntitySchema.describe("The created thread entity"),
});

type GithubRepoMeta = {
  githubRepo?: {
    owner: string;
    name: string;
    connectionId?: string;
  } | null;
};

export const COLLECTION_THREADS_CREATE = defineTool({
  name: "COLLECTION_THREADS_CREATE",
  description: "Create a new thread for organizing messages and conversations.",
  annotations: {
    title: "Create Thread",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: CreateInputSchema,
  outputSchema: CreateOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to create thread");
    }

    const { data } = input;
    const taskId = data.id ?? generatePrefixedId("thrd");

    const vmcp = await ctx.storage.virtualMcps.findById(
      data.virtual_mcp_id,
      organization.id,
    );
    if (!vmcp) {
      throw new Error(`Virtual MCP not found: ${data.virtual_mcp_id}`);
    }

    const metadata = vmcp.metadata as GithubRepoMeta | null | undefined;
    const githubRepo = metadata?.githubRepo;
    const branch = githubRepo
      ? (data.branch ?? threadBranch(taskId, githubRepo.connectionId))
      : null;

    const result = await ctx.storage.threads.create({
      id: taskId,
      organization_id: organization.id,
      title: data.title,
      description: data.description,
      virtual_mcp_id: data.virtual_mcp_id,
      branch,
      created_by: userId,
    });

    // Skip on a replayed/idempotent call (same id already existed) — the
    // conflict path returns the pre-existing row, and firing again would
    // double-count "chat_started" for a thread that was never actually created.
    if (result.isNew) {
      posthog.capture({
        distinctId: userId,
        event: "chat_started",
        groups: { organization: organization.id },
        properties: {
          organization_id: organization.id,
          thread_id: taskId,
          has_title: !!input.data.title,
          created_via: "tool",
        },
      });
    }

    return {
      item: normalizeThreadForResponse(result),
    };
  },
});
