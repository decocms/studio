/**
 * VM_DELETE. Dispatches on the caller-supplied `sandboxProviderKind` (not
 * env), so a pod that flipped STUDIO_SANDBOX_RUNNER between start and stop
 * still tears down the right kind of VM.
 */

import { z } from "zod";
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import { defineTool } from "../../core/define-tool";
import { requireVmEntry } from "./helpers";
import { getSandboxProviderByKind } from "../../sandbox/lifecycle";
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
    sandboxProviderKind: z
      .enum(["docker", "agent-sandbox", "remote-user"])
      .describe(
        "Kind of sandbox provider the VM was started with. Used to locate the correct 3-level vmMap entry.",
      ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    // Legacy "host" value can sneak in from pre-removal callers; coalesce to
    // the dev-mode replacement so the stop path doesn't crash.
    const rawKind = input.sandboxProviderKind as string;
    const kind: SandboxProviderKind =
      rawKind === "host" ? "remote-user" : (rawKind as SandboxProviderKind);

    let vmEntry: Awaited<ReturnType<typeof requireVmEntry>>;
    try {
      vmEntry = await requireVmEntry(
        { ...input, sandboxProviderKind: kind },
        ctx,
      );
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
      kind,
    );

    const runner = await getSandboxProviderByKind(ctx, kind);
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
