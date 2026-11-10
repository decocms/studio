import { z } from "zod";
import { parseThreadRuntime } from "@decocms/shared/thread/session-runtime";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { startThreadSandbox } from "../../harnesses/sandbox-only-chats";

export const THREAD_SANDBOX_START = defineTool({
  name: "THREAD_SANDBOX_START",
  description:
    "Start or resume a chat's sandbox and return the agent and branch that address it under /api/:org/sandbox/:virtualMcpId/:branch.",
  annotations: {
    title: "Start Chat Sandbox",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    threadId: z.string().min(1).describe("The chat whose sandbox to start"),
    wait: z
      .boolean()
      .default(true)
      .describe(
        "Wait for the sandbox to be running. false returns once the boot has started, with a null sandboxHandle.",
      ),
  }),
  outputSchema: z.object({
    virtualMcpId: z.string(),
    branch: z.string(),
    sandboxHandle: z.string().nullable(),
    previewUrl: z.string().nullable(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const thread = await ctx.storage.threads.get(input.threadId);
    if (!thread || thread.organization_id !== organization.id) {
      throw new Error("Chat not found");
    }
    const runtime = parseThreadRuntime(
      (thread.metadata as { runtime?: unknown } | null)?.runtime,
    );
    if (runtime === "cms") {
      throw new Error(
        "This chat is a CMS session and does not use a sandbox. Start a coding session to get one.",
      );
    }

    const target = await startThreadSandbox(ctx, thread, {
      wait: input.wait,
    });
    if (!target) throw new Error("Agent not found");
    return target;
  },
});
