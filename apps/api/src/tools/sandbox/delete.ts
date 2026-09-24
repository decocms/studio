import { SandboxDrainingError } from "@decocms/sandbox/provider/remote";
import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { getAgentSandboxProviderForTeardown } from "../../sandbox/lifecycle";
import { requireVmEntry } from "./helpers";
import { AGENT_SANDBOX_KIND, removeSandboxMapEntry } from "./sandbox-map";

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

    try {
      const runner = await getAgentSandboxProviderForTeardown(ctx);
      await runner.delete(entry.sandboxHandle);
    } catch (err) {
      // Still draining: keep the entry so a retry reaches the same claim, and
      // nothing provisions a second daemon beside it meanwhile.
      if (err instanceof SandboxDrainingError) {
        throw new Error(
          "The sandbox is still shutting down. Retry the delete in a few seconds.",
        );
      }
      // Any other failure still clears the entry, so the UI returns to idle
      // even when no controller is configured to reach.
      console.error(
        `[SANDBOX_DELETE] ${AGENT_SANDBOX_KIND} ${entry.sandboxHandle}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }

    await removeSandboxMapEntry(
      ctx.storage.virtualMcps,
      input.virtualMcpId,
      userId,
      sandboxUserId,
      input.branch,
    );

    return { success: true };
  },
});
