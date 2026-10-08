/**
 * COLLECTION_THREADS_UPDATE Tool
 *
 * Update an existing thread (organization-scoped) with collection binding compliance.
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import {
  normalizeThreadForResponse,
  requireOwnedVirtualMcp,
  type RepositoryMetadata,
} from "./helpers";
import {
  ThreadEntitySchema,
  ThreadUpdateDataSchema,
} from "@decocms/shared/thread/schema";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types/virtual-mcp";
import { parseThreadRuntime } from "@decocms/shared/thread/session-runtime";
import { stripServerManagedMetadata } from "../strip-server-managed-metadata";
import type { StudioContext } from "../../core/studio-context";
import type { Thread } from "../../storage/types";
import { sandboxOnlyChatsEnabled } from "../../harnesses/sandbox-only-chats";
import { getAgentSandboxProvider } from "../../sandbox/lifecycle";
import { getSettings } from "../../settings";
import { readSandboxMap, resolveVm } from "../sandbox/sandbox-map";
import { threadIdFromBranch } from "../sandbox/thread-repo";

/**
 * Bring shutdown of an archived chat's own sandboxes forward. Not a delete: an
 * archived chat can be reopened, and its work is pushed on shutdown. Never
 * throws.
 */
async function releaseThreadSandboxes(
  ctx: StudioContext,
  thread: Thread,
): Promise<void> {
  const sandboxMap = readSandboxMap(thread.metadata);
  const handles = Object.entries(sandboxMap).flatMap(([userId, branches]) =>
    Object.keys(branches ?? {})
      .filter((branch) => threadIdFromBranch(branch) === thread.id)
      .flatMap(
        (branch) => resolveVm(sandboxMap, userId, branch)?.sandboxHandle ?? [],
      ),
  );
  if (handles.length === 0) return;
  try {
    const provider = await getAgentSandboxProvider(ctx);
    await Promise.allSettled(
      handles.map((handle) =>
        provider.releaseAfter(handle, getSettings().sandboxReleaseGraceMs),
      ),
    );
  } catch (err) {
    console.warn("[threads:update] sandbox release on archive failed", err);
  }
}

/**
 * Input schema for updating threads
 */
const UpdateInputSchema = z.object({
  id: z.string().describe("ID of the thread to update"),
  data: ThreadUpdateDataSchema.describe("Partial thread data to update"),
});

/**
 * Output schema for updated thread
 */
const UpdateOutputSchema = z.object({
  item: ThreadEntitySchema.describe("The updated thread entity"),
});

export const COLLECTION_THREADS_UPDATE = defineTool({
  name: "COLLECTION_THREADS_UPDATE",
  description: "Update a thread's title, description, or visibility.",
  annotations: {
    title: "Update Thread",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: UpdateInputSchema,
  outputSchema: UpdateOutputSchema,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID required to update thread");
    }

    const { id, data } = input;

    const existing = await ctx.storage.threads.get(id);
    if (!existing) {
      throw new Error("Thread not found in organization");
    }

    let effectiveVmcp: VirtualMCPEntity | undefined;
    if (data.virtual_mcp_id !== undefined) {
      // Guards against re-pointing a thread at another org's agent.
      effectiveVmcp = await requireOwnedVirtualMcp(
        ctx.storage.virtualMcps,
        data.virtual_mcp_id,
        organization.id,
      );
    }

    // Check the vMCP this update points to, not the one being replaced.
    const effectiveVirtualMcpId =
      data.virtual_mcp_id !== undefined
        ? data.virtual_mcp_id
        : existing.virtual_mcp_id;

    if (data.branch === null && effectiveVirtualMcpId) {
      const vmcp =
        effectiveVmcp ??
        (await ctx.storage.virtualMcps.findById(
          effectiveVirtualMcpId,
          organization.id,
        ));
      const repository = (
        vmcp?.metadata as RepositoryMetadata | null | undefined
      )?.repository;
      if (repository) {
        throw new Error(
          "Cannot set branch=null on a repository-linked thread (vMCP has repository)",
        );
      }
    }

    const updateData: Parameters<typeof ctx.storage.threads.update>[1] = {
      title: data.title,
      description: data.description,
      hidden: data.hidden,
      updated_by: userId,
    };

    if (data.status) {
      updateData.status = data.status;
    }

    if (data.metadata !== undefined) {
      // `runtime` is stamped once at creation and immutable; `metadata` is a full-replacement write, so preserve it.
      const incomingMetadata = stripServerManagedMetadata(data.metadata) ?? {};
      const existingRuntime = parseThreadRuntime(
        (existing.metadata as { runtime?: unknown } | null)?.runtime,
      );
      const incomingRuntime = parseThreadRuntime(
        (incomingMetadata as { runtime?: unknown }).runtime,
      );
      if (
        existingRuntime &&
        incomingRuntime &&
        incomingRuntime !== existingRuntime
      ) {
        throw new Error(
          `Cannot change a thread's runtime (${existingRuntime} → ${incomingRuntime}); it is stamped once at creation. Start a new chat instead.`,
        );
      }
      const existingSandboxMap = (
        existing.metadata as { sandboxMap?: unknown } | null
      )?.sandboxMap;
      updateData.metadata = {
        ...incomingMetadata,
        ...(existingRuntime ? { runtime: existingRuntime } : {}),
        ...(existingSandboxMap !== undefined
          ? { sandboxMap: existingSandboxMap }
          : {}),
      };
    }

    if (data.branch !== undefined) {
      updateData.branch = data.branch;
    }

    if (data.virtual_mcp_id !== undefined) {
      updateData.virtual_mcp_id = data.virtual_mcp_id;
    }

    const thread = await ctx.storage.threads.update(id, updateData);

    if (
      data.hidden === true &&
      !existing.hidden &&
      (await sandboxOnlyChatsEnabled(ctx, organization.id))
    ) {
      await releaseThreadSandboxes(ctx, existing);
    }

    // Fire chat_archived / chat_unarchived when the hidden flag flips. Only
    // fires on the specific transition, not on title/description edits that
    // happen to include `hidden` unchanged.
    if (data.hidden !== undefined && data.hidden !== existing.hidden) {
      posthog.capture({
        distinctId: userId,
        event: data.hidden ? "chat_archived" : "chat_unarchived",
        groups: { organization: organization.id },
        properties: {
          organization_id: organization.id,
          thread_id: id,
        },
      });
    }

    return {
      item: normalizeThreadForResponse(thread),
    };
  },
});
