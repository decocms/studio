import { z } from "zod";
import { parseThreadRuntime } from "@decocms/shared/thread/session-runtime";
import { getDecopilotId, isDecopilot } from "@decocms/shared/sdk";
import { defineTool } from "../../core/define-tool";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type StudioContext,
} from "../../core/studio-context";
import {
  listOrgRepoChoices,
  type RepoChoice,
} from "../../git-providers/repo-choices";
import { startThreadSandbox } from "../../harnesses/sandbox-only-chats";
import { COLLECTION_THREADS_CREATE } from "../thread/create";
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

async function createSandboxChat(ctx: StudioContext, agentId: string) {
  const { item } = await COLLECTION_THREADS_CREATE.execute(
    { data: { virtual_mcp_id: agentId, runtime: "sandbox" } },
    ctx,
  );
  return { id: item.id, virtual_mcp_id: agentId, branch: item.branch ?? null };
}

export const THREAD_SANDBOX_START = defineTool({
  name: "THREAD_SANDBOX_START",
  description:
    "Start or resume a chat's sandbox, or create a sandbox chat when threadId is omitted. Returns the chat id and the agent and branch that address its sandbox under /api/:org/sandbox/:virtualMcpId/:branch.",
  annotations: {
    title: "Start Chat Sandbox",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: true,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z
    .object({
      threadId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "The chat whose sandbox to start. Omit to create a new chat.",
        ),
      virtualMcpId: z
        .string()
        .min(1)
        .optional()
        .describe(
          "Agent for the new chat when threadId is omitted. Defaults to the organization's default agent.",
        ),
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
    })
    .refine((input) => !(input.threadId && input.virtualMcpId), {
      message: "Pass threadId or virtualMcpId, not both",
    }),
  outputSchema: z.object({
    threadId: z.string(),
    virtualMcpId: z.string(),
    branch: z.string(),
    sandboxHandle: z.string().nullable(),
    previewUrl: z.string().nullable(),
  }),

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();

    const existing = input.threadId
      ? await ctx.storage.threads.get(input.threadId)
      : null;
    if (input.threadId) {
      if (!existing || existing.organization_id !== organization.id) {
        throw new Error("Chat not found");
      }
      const runtime = parseThreadRuntime(
        (existing.metadata as { runtime?: unknown } | null)?.runtime,
      );
      if (runtime === "cms") {
        throw new Error(
          "This chat is a CMS session and does not use a sandbox. Start a coding session to get one.",
        );
      }
    }
    const agentId =
      existing?.virtual_mcp_id ??
      input.virtualMcpId ??
      getDecopilotId(organization.id);
    // Same rule as `load_repo`: an agent with its own repository is scoped to
    // it. Checked before a new chat is created for it.
    if (input.repository && !isDecopilot(agentId)) {
      throw new Error(
        "Only chats on the default agent can load a repository; this agent uses the one it is configured with.",
      );
    }

    let target = existing ?? (await createSandboxChat(ctx, agentId));
    if (input.repository) {
      const userId = getUserId(ctx);
      if (!userId) throw new Error("User ID required to load a repository");
      const repo = findRepoChoice(
        await listOrgRepoChoices(ctx, organization.id),
        input.repository,
      );
      const { branch } = await bindThreadRepository(
        ctx,
        target.id,
        repo,
        userId,
      );
      target = { ...target, branch };
    }

    const started = await startThreadSandbox(ctx, target, {
      wait: input.wait,
    });
    if (!started) throw new Error("Agent not found");
    return { threadId: target.id, ...started };
  },
});
