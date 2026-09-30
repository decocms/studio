import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { assertOwnsSite } from "./ownership";
import { resolveSiteRepositoryId } from "./resolve-site-repository";
import { SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { emitTaskBoardUpdated } from "../task-board/run-reactions";
import { reactToSuperAgentDelegation } from "../task-board/enqueue-super-agent";

function buildInstruction(experiment: {
  key: string;
  name: string;
  variants: Array<{
    id: string;
    weight: number;
    role?: "control" | "treatment" | null;
    description?: string | null;
  }>;
}): string {
  const arms = experiment.variants
    .map(
      (v) =>
        `- ${v.id} (${v.role ?? "arm"}, ${v.weight}%): ${
          v.description ?? "no description given"
        }`,
    )
    .join("\n");

  return `Implement the frontend for the A/B test "${experiment.name}" (key \`${experiment.key}\`), already registered in the Experiments panel — this task is only about the site code, not the experiment record.

Arms, as specified when the test was created:
${arms}

Steps:
1. Find the component that currently renders the element the arm descriptions refer to.
2. Add a small hook next to this repo's existing ones under its ab-testing directory — a one-line wrapper around \`useExperiment("${experiment.key}")\`, re-exported from that directory's \`index.ts\`. Use an existing hook + its gate as the reference shape to imitate (e.g. a hook wrapping \`useExperiment\` with a conditional gate added directly in the component that renders the affected item) — match this codebase's established pattern rather than inventing a new one.
3. Add the minimal conditional in that component so each arm's rendered behavior matches its description above exactly — the arm marked "control" must match its own description too (usually "nothing changes"), not just the non-control arm.
4. Don't touch unrelated code, and don't create or edit anything in the Experiments panel itself — the record already exists.
5. Open a PR with the change.`;
}

export const EXPERIMENT_IMPLEMENT = defineTool({
  name: "EXPERIMENT_IMPLEMENT",
  description:
    "Delegate an already-created experiment's frontend implementation to the Super Agent: it finds the affected component, wires up `useExperiment(key)` following this site's existing pattern, and opens a PR. Requires the site to have a linked GitHub repository; the operator confirms this action explicitly (it is not triggered by EXPERIMENT_CREATE).",
  annotations: {
    title: "Implement Experiment In Frontend",
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: false,
  },
  inputSchema: z.object({
    site: z.string().min(1),
    key: z.string().min(1),
  }),
  outputSchema: z.object({ taskBoardItemId: z.string() }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    await assertOwnsSite(ctx, organization.id, input.site);

    const experiment = await ctx.storage.experiments.getByKey(
      organization.id,
      input.site,
      input.key,
    );
    if (!experiment) {
      throw new Error(`No experiment "${input.key}" found on ${input.site}.`);
    }
    if (experiment.variants.length === 0) {
      throw new Error(
        `Experiment "${input.key}" has no variants yet — add them before implementing.`,
      );
    }

    const repositoryId = await resolveSiteRepositoryId(
      ctx,
      organization.id,
      input.site,
    );
    if (!repositoryId) {
      throw new Error(
        `${input.site} has no linked GitHub repository — connect one before implementing an experiment.`,
      );
    }

    const owner = await ctx.db
      .selectFrom("member")
      .select(["userId"])
      .where("organizationId", "=", organization.id)
      .where("role", "=", "owner")
      .orderBy("createdAt", "asc")
      .executeTakeFirst();

    const item = await ctx.storage.taskBoard.create({
      organizationId: organization.id,
      title: `Implement experiment: ${experiment.name}`,
      description: buildInstruction(experiment),
      status: "todo",
      assigneeId: SUPER_AGENT_ASSIGNEE_ID,
      assignedBy: owner?.userId ?? null,
      repositoryId,
      by: ctx.auth.user!.id,
    });
    emitTaskBoardUpdated(organization.id, item);

    // Not best-effort: a swallowed `TaskQuotaError` here would leave the
    // operator thinking implementation started when billing blocked it —
    // same contract as the task-board rerun tool.
    await reactToSuperAgentDelegation(ctx, item, { userInitiated: true });

    return { taskBoardItemId: item.id };
  },
});
