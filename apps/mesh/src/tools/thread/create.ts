/**
 * COLLECTION_THREADS_CREATE Tool
 *
 * Create a new thread for a virtual MCP.
 *
 * Branch resolution (only meaningful when the vMCP has a githubRepo):
 *   1. Honor `data.branch` when provided.
 *   2. Otherwise pick the most-recently-touched branch from the user's
 *      `vmMap[userId]` so a new task lands on a warm sandbox.
 *   3. Fall back to a freshly generated `deco/<adj>-<noun>` name when the
 *      user has no vmMap entries for this vMCP.
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
} from "../../core/mesh-context";
import { ThreadCreateDataSchema, ThreadEntitySchema } from "./schema";
import { generatePrefixedId } from "@/shared/utils/generate-id";
import { generateBranchName } from "@/shared/branch-name";

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

type VmMapMeta = {
  vmMap?: Record<string, Record<string, { createdAt?: number }>>;
};

/**
 * Pick the user's most-recently-touched branch from vmMap. Returns undefined
 * when the user has no entries (caller falls back to generateBranchName).
 */
function pickWarmBranchFromVmMap(
  vmMap: VmMapMeta["vmMap"],
  userId: string,
): string | undefined {
  const entries = vmMap?.[userId];
  if (!entries) return undefined;
  const sorted = Object.entries(entries).sort(
    ([, a], [, b]) => (b.createdAt ?? 0) - (a.createdAt ?? 0),
  );
  return sorted[0]?.[0];
}

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

    const metadata = vmcp.metadata as
      | (GithubRepoMeta & VmMapMeta)
      | null
      | undefined;
    const githubRepo = metadata?.githubRepo;
    let branch: string | null = null;
    if (githubRepo) {
      branch =
        data.branch ??
        pickWarmBranchFromVmMap(metadata?.vmMap, userId) ??
        generateBranchName();
    }

    const result = await ctx.storage.threads.create({
      id: taskId,
      organization_id: organization.id,
      title: data.title,
      description: data.description,
      virtual_mcp_id: data.virtual_mcp_id,
      branch,
      created_by: userId,
    });

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

    return {
      item: {
        ...result,
        hidden: result.hidden ?? false,
      },
    };
  },
});
