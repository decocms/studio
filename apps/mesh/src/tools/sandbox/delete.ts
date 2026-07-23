/**
 * SANDBOX_DELETE. Dispatches on the caller-supplied `sandboxProviderKind` (not
 * env), so a pod that flipped STUDIO_SANDBOX_PROVIDER between start and stop
 * still tears down the right kind of sandbox.
 */

import { z } from "zod";
import {
  composeSandboxRef,
  normalizeSandboxProviderKind,
  sharedSandboxId,
} from "@decocms/sandbox/provider";
import { defineTool } from "../../core/define-tool";
import { requireVmEntry } from "./helpers";
import { removeSandboxMapEntry } from "./sandbox-map";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { getSettings } from "../../settings";

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

    if (kind === "agent-sandbox" && getSettings().sharedAgentSandboxesEnabled) {
      requireAuth(ctx);
      const organization = requireOrganization(ctx);
      await ctx.access.check();
      const userId = getUserId(ctx);
      if (!userId) throw new Error("User ID required");
      const virtualMcp = await ctx.storage.virtualMcps.findById(
        input.virtualMcpId,
      );
      if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
        return { success: true };
      }

      const locator = {
        organizationId: organization.id,
        virtualMcpId: input.virtualMcpId,
        branch: input.branch,
      };
      const { provider: runner } = await resolveSandboxProvider(ctx, {
        userId,
        branch: input.branch,
        virtualMcpMetadata:
          (virtualMcp.metadata as Record<string, unknown> | null) ?? null,
        explicitKind: "agent-sandbox",
      });
      const projectRef = composeSandboxRef({
        orgId: organization.id,
        virtualMcpId: input.virtualMcpId,
        branch: input.branch,
      });
      const entry = await ctx.storage.agentSandboxSessions.withLock(
        locator,
        (sessions) => sessions.beginStop(locator, userId),
      );
      if (!entry) return { success: true };
      try {
        if (entry.sandboxHandle) {
          await runner
            .delete(entry.sandboxHandle, sharedSandboxId(projectRef))
            .catch((error) =>
              console.error(
                `[SANDBOX_DELETE] agent-sandbox ${entry.sandboxHandle}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              ),
            );
        }
      } finally {
        await ctx.storage.agentSandboxSessions.withLock(locator, (sessions) =>
          sessions.completeStop(locator, entry.generation),
        );
      }
      return { success: true };
    }

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
