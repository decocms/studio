/**
 * VM_DELETE. Dispatches on the entry's persisted `runnerKind` (not env),
 * so a pod that flipped STUDIO_SANDBOX_RUNNER between start and stop still
 * tears down the right kind of VM.
 */

import { z } from "zod";
import type { RunnerKind } from "@decocms/sandbox/runner";
import { defineTool } from "../../core/define-tool";
import { requireVmEntry } from "./helpers";
import { getRunnerByKind } from "../../sandbox/lifecycle";
import { removeVmMapEntry } from "./vm-map";

export const VM_DELETE = defineTool({
  name: "VM_DELETE",
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
      .describe("Branch whose vm should be deleted (vmMap[userId][branch])"),
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
    const { entry, userId } = vmEntry;

    if (!entry) {
      return { success: true };
    }

    // Clear first so the UI returns to idle regardless of teardown outcome.
    await removeVmMapEntry(
      ctx.storage.virtualMcps,
      input.virtualMcpId,
      userId,
      userId,
      input.branch,
    );

    // Legacy entries (pre-runnerKind column) default to freestyle.
    const kind: RunnerKind = entry.runnerKind ?? "freestyle";
    const runner = await getRunnerByKind(ctx, kind);
    await runner
      .delete(entry.vmId)
      .catch((err) =>
        console.error(
          `[VM_DELETE] ${kind} ${entry.vmId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    return { success: true };
  },
});
