/**
 * COLLECTION_THREADS_CREATE Tool
 *
 * Create a new thread for a virtual MCP.
 *
 * Branch resolution (only meaningful when the vMCP has a githubRepo):
 *   1. Honor `data.branch` when provided.
 *   2. Otherwise pick the most-recently-touched AgentSandbox branch from the
 *      user's `sandboxMap[userId]` so a new task lands on a warm hosted sandbox.
 *   3. Fall back to `generateBranchName` (`<user-slug>-<timestamp>`) when the
 *      user has no hosted sandboxMap entries for this vMCP.
 *
 * Step 2 only sees sandboxes that finished provisioning — the AgentSandbox map
 * writer runs after `provider.ensure` returns. So a SANDBOX_START in flight is
 * invisible here and step 3 mints a sibling branch; the frontend must never
 * auto-start without a branch (see `shouldAutoStart`).
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
import { normalizeThreadForResponse, type GithubRepoMeta } from "./helpers";
import {
  ThreadCreateDataSchema,
  ThreadEntitySchema,
} from "@decocms/shared/thread/schema";
import { generatePrefixedId } from "@decocms/shared/utils/generate-id";
import {
  branchUserLabel,
  generateBranchName,
} from "@decocms/shared/branch-name";
import { AGENT_SANDBOX_KIND } from "../sandbox/sandbox-map";

const CreateInputSchema = z.object({
  data: ThreadCreateDataSchema.describe(
    "Data for the new thread (id is auto-generated if not provided)",
  ),
});

export type CreateThreadInput = z.infer<typeof CreateInputSchema>;

const CreateOutputSchema = z.object({
  item: ThreadEntitySchema.describe("The created thread entity"),
});

type SandboxMapMeta = {
  sandboxMap?: Record<
    string,
    Record<string, Record<string, { createdAt?: number }>>
  >;
};

/**
 * Pick the user's most-recently-touched hosted branch. Legacy desktop cells
 * remain in the stored 3-level map for compatibility but never select a hosted
 * thread branch.
 */
function pickWarmBranchFromSandboxMap(
  sandboxMap: SandboxMapMeta["sandboxMap"],
  userId: string,
): string | undefined {
  const branchMap = sandboxMap?.[userId];
  if (!branchMap) return undefined;
  const candidates = Object.entries(branchMap).flatMap(([branch, kinds]) => {
    const entry = kinds[AGENT_SANDBOX_KIND];
    return entry ? [{ branch, createdAt: entry.createdAt ?? 0 }] : [];
  });
  candidates.sort((a, b) => b.createdAt - a.createdAt);
  return candidates[0]?.branch;
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
    // Keep the explicit entity check as defense in depth for synthesized
    // well-known agents; normal rows are scoped in SQL by findById.
    if (!vmcp || vmcp.organization_id !== organization.id) {
      throw new Error(`Virtual MCP not found: ${data.virtual_mcp_id}`);
    }

    const metadata = vmcp.metadata as
      | (GithubRepoMeta & SandboxMapMeta)
      | null
      | undefined;
    const githubRepo = metadata?.githubRepo;
    let branch: string | null = null;
    if (githubRepo) {
      branch =
        data.branch ??
        pickWarmBranchFromSandboxMap(metadata?.sandboxMap, userId) ??
        generateBranchName(branchUserLabel(ctx.auth.user));
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
