/**
 * COLLECTION_THREADS_DELETE Tool
 *
 * Delete a thread with collection binding compliance.
 */

import {
  CollectionDeleteInputSchema,
  createCollectionDeleteOutputSchema,
} from "@decocms/bindings/collections";
import { ThreadEntitySchema } from "@decocms/shared/thread/schema";
import { posthog } from "../../posthog";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { normalizeThreadForResponse } from "./helpers";
import { broadcastRunCancel } from "@/api/routes/decopilot/cancel-registry";
import { cancelHostedHarness } from "@/dispatch-queue";
import { cancelThreadGateHead } from "@/dispatch-queue/thread-gate-queue";
import { cancelThreadBackgroundJobs } from "@/harnesses/decopilot/background-tool-workflow";

export const COLLECTION_THREADS_DELETE = defineTool({
  name: "COLLECTION_THREADS_DELETE",
  description: "Permanently delete a thread and all its messages.",
  annotations: {
    title: "Delete Thread",
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: CollectionDeleteInputSchema,
  outputSchema: createCollectionDeleteOutputSchema(ThreadEntitySchema),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);

    await ctx.access.check();

    const thread = await ctx.storage.threads.get(input.id);
    if (!thread) {
      throw new Error(`Thread not found: ${input.id}`);
    }

    // Stop an in-flight run before deleting its thread, or it keeps running orphaned.
    if (thread.status === "in_progress") {
      const onError = (step: string) => (err: unknown) =>
        console.error("[thread] delete-time run cancel step failed", {
          threadId: input.id,
          step,
          err,
        });
      await cancelThreadBackgroundJobs(input.id).catch(
        onError("background-jobs"),
      );
      await cancelThreadGateHead(input.id).catch(onError("gate-head"));
      const fence = await ctx.storage.threads
        .getRunFence(input.id)
        .catch(() => null);
      if (fence) {
        await cancelHostedHarness(input.id, fence).catch(
          onError("hosted-harness"),
        );
      }
      broadcastRunCancel(input.id);
    }

    await ctx.storage.threads.delete(input.id);

    const userId = getUserId(ctx);
    if (userId) {
      posthog.capture({
        distinctId: userId,
        event: "chat_deleted",
        groups: { organization: organization.id },
        properties: {
          organization_id: organization.id,
          thread_id: input.id,
        },
      });
    }

    return {
      item: normalizeThreadForResponse(thread),
    };
  },
});
