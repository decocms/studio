import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { requireAuth, requireOrganization } from "../../core/studio-context";
import { findOwnedProject } from "./ownership";
import { assertExperimentsV2 } from "./v2-gate";
import { resolveRepositoryForProject } from "./resolve-site-repository";
import { LANES, SUPER_AGENT_ASSIGNEE_ID } from "@decocms/shared/task-board";
import { taskKey } from "@decocms/shared/task-key";
import { emitTaskBoardUpdated } from "../task-board/run-reactions";
import { reactToSuperAgentDelegation } from "@/automations/fire-implementer";

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

This site is instrumented with the deco-ab-testing SDK. The SDK decides which
arm a visitor gets and hands that over; it does NOT touch the DOM. Read the
assignment through one of its two surfaces, and no other way:

1. PREFERRED — the root attribute. The SDK sets \`data-ab-${experiment.key}="<arm>"\`
   on \`<html>\` before first paint, so a plain CSS rule keyed on it applies with
   no flash and no JavaScript:

   \`\`\`css
   [data-ab-${experiment.key}="<arm-id>"] <selector for the affected element> { ... }
   \`\`\`

   Use this whenever the arm is expressible as styling — hiding, showing,
   reordering, recoloring. It is the only approach with no flash.

2. FALLBACK — only when the arm changes logic or data CSS cannot express.
   If this repo has an ab-testing directory with per-test hooks, add one more
   there (a named hook wrapping its \`useExperiment("${experiment.key}")\`,
   re-exported from that directory's \`index.ts\`) and consume it in the
   component. Match that existing shape exactly rather than inventing one —
   it already encodes the hydration rules below. Only if no such directory
   exists, fall back to \`__ab.ready((ab) => ...)\` directly.

HARD RULES:
- NEVER read \`window.__ab.assignments\`, \`__ab.id\` or \`ab.variant(...)\` at module
  scope, during render, or in a \`useState\` initializer. The SDK populates them
  after an \`await\`, so those reads return \`undefined\` or \`null\` — and in React
  a first client render that disagrees with the server's HTML is a hydration
  mismatch that silently keeps the wrong arm on screen. State must start at
  the server's value and move only inside the \`ready\` callback.
- \`ready\` always fires, including when no test applied (\`ab.variant\` returns
  \`null\`). Treat \`null\` as the control arm and make sure the page renders
  something in that case — never gate the first render on the callback.
- Do NOT apply the arm by patching the DOM from JavaScript where CSS would do.

Steps:
1. Find the element the arm descriptions refer to, and decide which of the two
   surfaces above fits.
2. Implement each arm so its rendered behavior matches its description exactly.
   The arm marked "control" is the baseline and usually needs no rule at all —
   but check its description says that before assuming it.
3. Register the test in the site's \`.deco/TestesAB.json\` manifest in the SAME
   pull request, as \`"${experiment.key}": { "variants": [${experiment.variants
     .map((v) => `"${v.id}"`)
     .join(", ")}], "active": true }\` — merging into whatever that file
   already holds, never replacing it. This is NOT optional bookkeeping: the SDK
   resolves the \`?__ab=\` override only for a test its manifest lists, so
   without the entry the forced-arm URLs below silently render the control and
   the change looks like it did nothing.
4. Follow this repo's existing conventions for where such code lives; match an
   existing pattern rather than inventing a new one.
5. Don't touch unrelated code, and don't create or edit anything in the
   Experiments panel itself — the record already exists.
6. In the PR body, list each arm and the exact
   \`?__ab=${experiment.key}:<arm-id>\` URL that forces it, so a reviewer can
   see both arms without waiting for a real assignment.`;
}

export const EXPERIMENT_IMPLEMENT = defineTool({
  name: "EXPERIMENT_IMPLEMENT",
  description:
    "Delegate an already-created experiment's frontend implementation to the Super Agent: it finds the affected element and wires each arm to the deco-ab-testing SDK's assignment — a CSS rule keyed on the `data-ab-<key>` root attribute, or `__ab.ready()` when CSS can't express it — then opens a PR. Requires the site to have a linked GitHub repository; the operator confirms this action explicitly (it is not triggered by EXPERIMENT_CREATE).",
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
  outputSchema: z.object({
    taskBoardItemId: z.string(),
    /** The card's human key (`DECO-07`), so the caller can deep-link to it.
     *  Null when the org has no slug, or for a row predating the key backfill. */
    taskKey: z.string().nullable(),
  }),
  handler: async (input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    const project = await findOwnedProject(ctx, organization.id, input.site);
    await assertExperimentsV2(ctx, organization.id);

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

    /** A second card would mean a second run, a second branch and a second pull
     *  request for the same change — and the screen follows only one of them. */
    if (experiment.taskBoardItemId) {
      const existing = await ctx.storage.taskBoard.getById(
        experiment.taskBoardItemId,
        organization.id,
      );
      if (existing) {
        return {
          taskBoardItemId: existing.id,
          taskKey:
            organization.slug && existing.keySeq != null
              ? taskKey(organization.slug, existing.keySeq)
              : null,
        };
      }
      // The card was deleted; delegate again.
    }

    const repository = await resolveRepositoryForProject(
      ctx,
      organization.id,
      project,
    );
    if (!repository) {
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
      // The run's start doesn't move the card; only In Progress cards get their PR linked.
      status: LANES.progress,
      assigneeId: SUPER_AGENT_ASSIGNEE_ID,
      assignedBy: owner?.userId ?? null,
      repositoryId: repository.id,
      repo: repository.path,
      by: ctx.auth.user!.id,
    });
    emitTaskBoardUpdated(organization.id, item);

    /** Linked BEFORE dispatch: a dispatch that throws still leaves the card
     *  findable, and a retry then reuses it rather than forking a second. */
    await ctx.storage.experiments.linkTaskBoardItem(
      organization.id,
      input.site,
      input.key,
      item.id,
    );

    await reactToSuperAgentDelegation(ctx, item);

    return {
      taskBoardItemId: item.id,
      taskKey: organization.slug
        ? taskKey(organization.slug, item.keySeq)
        : null,
    };
  },
});
