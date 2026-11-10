import { z } from "zod";
import { parseThreadRuntime } from "@decocms/shared/thread/session-runtime";
import { isDecopilot } from "@decocms/shared/sdk";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import {
  listOrgRepoChoices,
  type RepoChoice,
} from "../../git-providers/repo-choices";
import { startThreadSandbox } from "../../harnesses/sandbox-only-chats";
import { bindThreadRepository } from "./thread-repo";

/** The choice `ref` names: its id, or `owner/name` (any case). */
export function findRepoChoice(choices: RepoChoice[], ref: string): RepoChoice {
  const byId = choices.find((choice) => choice.id === ref);
  if (byId) return byId;
  const byName = choices.filter(
    (choice) =>
      `${choice.owner}/${choice.name}`.toLowerCase() === ref.toLowerCase(),
  );
  if (byName.length === 1) return byName[0]!;
  const list = (byName.length > 1 ? byName : choices)
    .map((choice) => `${choice.label} (id: ${choice.id})`)
    .join(", ");
  throw new Error(
    byName.length > 1
      ? `"${ref}" names several repositories; pass one id: ${list}.`
      : `No repository "${ref}" is linked to this organization. Linked: ${list || "none"}.`,
  );
}

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
    repository: z
      .string()
      .min(1)
      .optional()
      .describe(
        "Bind one of the organization's linked repositories to the chat first, by id or owner/name. Only for chats on the default agent; other agents use the repository they are configured with.",
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

    let target = thread;
    if (input.repository) {
      // Same rule as `load_repo`: an agent with its own repository is scoped
      // to it.
      if (!isDecopilot(thread.virtual_mcp_id)) {
        throw new Error(
          "Only chats on the default agent can load a repository; this agent uses the one it is configured with.",
        );
      }
      const userId = getUserId(ctx);
      if (!userId) throw new Error("User ID required to load a repository");
      const repo = findRepoChoice(
        await listOrgRepoChoices(ctx, organization.id),
        input.repository,
      );
      const { branch } = await bindThreadRepository(
        ctx,
        thread.id,
        repo,
        userId,
      );
      target = { ...thread, branch };
    }

    const started = await startThreadSandbox(ctx, target, {
      wait: input.wait,
    });
    if (!started) throw new Error("Agent not found");
    return started;
  },
});
