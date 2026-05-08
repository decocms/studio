/**
 * AUTOMATION_RUN Tool
 *
 * Manually triggers an automation run.
 */

import { z } from "zod";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  requireAuth,
  requireOrganization,
  getUserId,
} from "../../core/mesh-context";

export const AUTOMATION_RUN = defineTool({
  name: "AUTOMATION_RUN",
  description:
    "Manually trigger an automation run. Bypasses configured triggers.",
  annotations: {
    title: "Run Automation",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    id: z.string(),
  }),
  outputSchema: z.object({
    threadId: z.string().optional(),
    error: z.string().optional(),
    skipped: z.string().optional(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    const org = requireOrganization(ctx);
    await ctx.access.check();

    if (!ctx.automationRunner) {
      throw new Error("Automation runner not available");
    }

    const userId = getUserId(ctx);
    if (!userId) {
      throw new Error("User ID not available");
    }

    const result = await ctx.automationRunner(input.id, org.id, userId);

    posthog.capture({
      distinctId: userId,
      event: "automation_run",
      groups: { organization: org.id },
      properties: {
        organization_id: org.id,
        automation_id: input.id,
        thread_id: "taskId" in result ? result.taskId : undefined,
        status:
          "skipped" in result
            ? "skipped"
            : "error" in result
              ? "error"
              : "started",
        skip_reason: "skipped" in result ? result.skipped : undefined,
        error_message: "error" in result ? result.error : undefined,
      },
    });

    if ("skipped" in result) {
      return { skipped: result.skipped };
    }
    if ("error" in result) {
      return { threadId: result.taskId, error: result.error };
    }
    return { threadId: result.taskId };
  },
});
