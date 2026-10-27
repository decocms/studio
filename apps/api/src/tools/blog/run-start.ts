import { z } from "zod";
import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { PartEmitter } from "@/api/routes/decopilot/part-emitter";
import { assertAiBudget } from "@/core/plan-feature-gate";
import { resolveTier } from "@/core/resolve-tier";
import { enqueueThreadRun } from "@/dispatch-queue";
import { RUN_CLASS_METADATA_KEY } from "@/dispatch-queue/run-priority";
import { defineTool } from "../../core/define-tool";
import { resolveCallerProjectScope } from "../../core/project-scope";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import { requireBlogAi } from "./feature-flag";

/**
 * Starting the blog's work as a run, instead of as a request someone waits on.
 *
 * Generation was a tool call from a browser: the tab held the connection open
 * while a model swept a store and wrote a campaign, and the person watched a
 * spinner that said nothing. Two things follow from that, and both are why
 * this exists.
 *
 * The first is a limit. An edge proxy hangs up at around 100 seconds and
 * answers 524 while the server keeps working — so a pass that honestly takes
 * two minutes cannot be a request at all, however it is written. A run answers
 * immediately with the thread it will happen in, and the work outlives the
 * reply.
 *
 * The second is the point of the whole feature. A run has a thread, and a
 * thread shows its steps: which specialist was asked, which tool it reached
 * for, what came back. "What is editing my store" stops being a question
 * nobody can answer.
 *
 * The agent is the project itself. A specialist defined under the project's
 * folder is reachable only through `subtask`, so the prompt names the role and
 * the project agent delegates — which is also what keeps one thread as the
 * whole story of a run rather than one thread per participant.
 */

/** Long enough for a brief with a campaign in it, short of an essay. */
const MAX_PROMPT_CHARS = 10_000;

/** What the thread is called before the run names it from its own work. */
const MAX_TITLE_CHARS = 120;

export const BLOG_RUN_START = defineTool({
  name: "BLOG_RUN_START",
  description:
    "Hand a piece of blog work to the site's own agent and return the thread it happens in. Answers as soon as the run is queued — the work carries on server-side, so a pass that takes minutes is no longer a request anyone has to hold open. Read the thread to watch it: who was asked, what tools they reached for, what came back. Name a specialist in the prompt and the project agent delegates to it.",
  annotations: {
    title: "Start a Blog Run",
    readOnlyHint: false,
    destructiveHint: false,
    /** Two calls with the same prompt are two runs; the caller owns that. */
    idempotentHint: false,
    openWorldHint: true,
  },

  requiresAiBudget: true,

  inputSchema: z.object({
    virtualMcpId: z
      .string()
      .min(1)
      .max(256)
      .describe("The site's project. Its agent is the one that runs."),
    prompt: z
      .string()
      .min(1)
      .max(MAX_PROMPT_CHARS)
      .describe(
        "What to do, in full. The run starts with an empty context and cannot ask a follow-up, so say which brand, which campaign, and what a finished answer looks like.",
      ),
    title: z
      .string()
      .max(MAX_TITLE_CHARS)
      .optional()
      .describe("What to call the thread in a list. Defaults to the work."),
  }),

  outputSchema: z.object({
    threadId: z
      .string()
      .describe("The thread this run happens in. Read it to follow along."),
  }),

  modelSummary: (r) => `Run queued in thread ${r.threadId}.`,

  handler: async (input, ctx) => {
    requireAuth(ctx);
    const organization = requireOrganization(ctx);
    await ctx.access.check();
    await requireBlogAi(ctx, organization.id);
    await assertAiBudget(ctx, organization.id, "running a blog agent");

    const project = await ctx.storage.virtualMcps.findById(
      input.virtualMcpId,
      organization.id,
    );
    const scope = await resolveCallerProjectScope(ctx);
    if (
      !project ||
      project.organization_id !== organization.id ||
      !isProjectAllowed(scope, project.id)
    ) {
      throw new Error(`Project not found: ${input.virtualMcpId}`);
    }
    if (project.status !== "active") {
      throw new Error("Project is not active");
    }

    /** Writing to a thread is the owner's alone, so the run is theirs. */
    const userId = getUserId(ctx);
    if (!userId) throw new Error("A run needs a user to belong to");

    const model = await resolveTier(ctx, "smart");

    const thread = await ctx.storage.threads.create({
      organization_id: organization.id,
      title: input.title?.trim() || defaultTitle(input.prompt),
      status: "in_progress",
      virtual_mcp_id: project.id,
      harness_id: "decopilot",
      /** The sole terminal writer skips v1 runs, so a v1 thread never finishes. */
      message_storage_version: 2,
      created_by: userId,
    });

    const requestMessage = {
      id: crypto.randomUUID(),
      role: "user" as const,
      parts: [{ type: "text" as const, text: input.prompt }],
      /** No browser stamped this, and a timestamp-less turn sorts after the
       *  reply it asked for. */
      metadata: { created_at: new Date().toISOString() },
    };

    /**
     * Before the dispatch, as the chat route does: the projector gives an
     * assistant part `Date.now()` when no user part exists yet, which lands
     * the question after its own answer.
     */
    await new PartEmitter({
      storage: ctx.storage.threads.messageParts(),
      orgId: organization.id,
      threadId: thread.id,
      runId: thread.id,
    }).emitRequestMessage(requestMessage);

    await enqueueThreadRun({
      threadId: thread.id,
      source: "background-tool",
      request: {
        messages: [requestMessage],
        models: {
          credentialId: model.credentialId,
          thinking: { id: model.modelId, title: model.modelMeta.title },
        },
        agent: { id: project.id },
        /** What an automation's runs use when nobody picked one. */
        temperature: 0.5,
        toolApprovalLevel: "auto",
        mode: "default",
        organizationId: organization.id,
        userId,
        harnessId: "decopilot",
        taskId: thread.id,
        runMetadata: { [RUN_CLASS_METADATA_KEY]: "new_task" },
      },
    });

    return { threadId: thread.id };
  },
});

/** The prompt's first line, trimmed to something a list can show. */
function defaultTitle(prompt: string): string {
  const line = prompt.trim().split("\n")[0]?.trim() ?? "";
  return line.length > MAX_TITLE_CHARS
    ? `${line.slice(0, MAX_TITLE_CHARS - 1)}…`
    : line || "Blog run";
}
