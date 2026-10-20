import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getUserId, type StudioContext } from "../../core/studio-context";
import { getAgentSandboxProviderForTeardown } from "../../sandbox/lifecycle";
import type { Thread } from "../../storage/types";
import { requireVmEntry } from "./helpers";
import {
  AGENT_SANDBOX_KIND,
  readSandboxMap,
  removeSandboxMapEntry,
  resolveVm,
} from "./sandbox-map";
import { threadIdFromBranch } from "./thread-repo";

export const SANDBOX_DELETE = defineTool({
  name: "SANDBOX_DELETE",
  description: "Delete a sandbox.",
  annotations: {
    title: "Delete VM Preview",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    virtualMcpId: z.string().describe("Virtual MCP ID that owns this VM"),
    branch: z
      .string()
      .min(1)
      .describe(
        "Branch whose vm should be deleted (sandboxMap[userId][branch])",
      ),
    removeWorktree: z
      .boolean()
      .optional()
      .default(false)
      .describe(
        "Also reclaim the sandbox's workspace (local worktree + disk). Ignored by hosted teardown, whose filesystem is already destroyed.",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    let vmEntry: Awaited<ReturnType<typeof requireVmEntry>>;
    try {
      vmEntry = await requireVmEntry(input, ctx);
    } catch (err) {
      if (err instanceof Error && err.message === "Virtual MCP not found") {
        return { success: true };
      }
      throw err;
    }
    // `sandboxUserId` is the sandbox's owner (the thread's creator on a
    // thread-scoped branch), `userId` the caller — so stopping a thread's
    // sandbox reaches the one sandbox it has, from either side.
    const { entry, userId, sandboxUserId } = vmEntry;

    if (!entry) {
      return { success: true };
    }

    const runner = await getAgentSandboxProviderForTeardown(ctx);

    // Clear first so the UI returns to idle regardless of teardown outcome.
    await removeSandboxMapEntry(
      ctx.storage.virtualMcps,
      input.virtualMcpId,
      userId,
      sandboxUserId,
      input.branch,
    );

    await runner
      .delete(entry.sandboxHandle)
      .catch((err) =>
        console.error(
          `[SANDBOX_DELETE] ${AGENT_SANDBOX_KIND} ${entry.sandboxHandle}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    return { success: true };
  },
});

/**
 * The sandboxes keyed to this thread alone (`thread:<id>[/<conn>]`). The
 * thread's sandboxMap can also record shared keys (`ephemeral`, a pinned git
 * ref reused by task re-runs); other threads still run on those.
 */
function threadOwnedSandboxes(
  thread: Pick<Thread, "id" | "metadata">,
): { userId: string; branch: string; handle: string }[] {
  const map = readSandboxMap(thread.metadata);
  return Object.entries(map).flatMap(([userId, branches]) =>
    Object.keys(branches).flatMap((branch) => {
      if (threadIdFromBranch(branch) !== thread.id) return [];
      const entry = resolveVm(map, userId, branch);
      return entry ? [{ userId, branch, handle: entry.sandboxHandle }] : [];
    }),
  );
}

/** Tear down a deleted thread's own sandboxes. Never throws. */
export async function deleteThreadSandboxes(
  ctx: StudioContext,
  thread: Pick<Thread, "id" | "metadata" | "virtual_mcp_id">,
): Promise<void> {
  const owned = threadOwnedSandboxes(thread);
  if (owned.length === 0) return;
  const log = (handle: string) => (err: unknown) =>
    console.error(
      `[thread-delete] sandbox teardown failed for ${handle}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  try {
    const runner = await getAgentSandboxProviderForTeardown(ctx);
    await Promise.all(
      owned.map(async ({ userId, branch, handle }) => {
        await removeSandboxMapEntry(
          ctx.storage.virtualMcps,
          thread.virtual_mcp_id,
          getUserId(ctx) ?? userId,
          userId,
          branch,
        ).catch(log(handle));
        await runner.delete(handle).catch(log(handle));
      }),
    );
  } catch (err) {
    log(owned.map((s) => s.handle).join(","))(err);
  }
}
