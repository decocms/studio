/**
 * SANDBOX_DELETE. Dispatches on the caller-supplied `sandboxProviderKind` (not
 * env), so a pod that flipped STUDIO_SANDBOX_PROVIDER between start and stop
 * still tears down the right kind of sandbox.
 */

import { z } from "zod";
import { normalizeSandboxProviderKind } from "@decocms/sandbox/provider";
import { defineTool } from "../../core/define-tool";
import { requireVmEntry } from "./helpers";
import { removeSandboxMapEntry } from "./sandbox-map";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";

const sandboxProviderKindInputSchema = z.enum([
  "agent-sandbox",
  "user-desktop",
  "cluster",
]);

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
    sandboxProviderKind: sandboxProviderKindInputSchema.describe(
      "Kind of sandbox provider the VM was started with. Hosted provider is `agent-sandbox`; legacy `cluster` input is accepted only for compatibility and normalized to `agent-sandbox`. Used to locate the correct 3-level sandboxMap entry.",
    ),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),

  handler: async (input, ctx) => {
    // Normalize here too because direct unit tests call handler() without
    // going through schema parsing.
    const kind = normalizeSandboxProviderKind(input.sandboxProviderKind);

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

    const { provider: runner } = await resolveSandboxProvider(ctx, {
      userId,
      branch: input.branch,
      virtualMcpMetadata: vmEntry.metadata,
      explicitKind: kind,
    });

    // Clear first so the UI returns to idle regardless of teardown outcome.
    await removeSandboxMapEntry(
      ctx.storage.virtualMcps,
      input.virtualMcpId,
      userId,
      userId,
      input.branch,
      kind,
    );

    await runner
      .delete(entry.sandboxHandle)
      .catch((err) =>
        console.error(
          `[SANDBOX_DELETE] ${kind} ${entry.sandboxHandle}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        ),
      );

    return { success: true };
  },
});
