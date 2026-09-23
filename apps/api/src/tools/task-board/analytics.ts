/**
 * Task board analytics — six tools, one per question a person actually asks,
 * covering all 31 SQL panels of the two Grafana dashboards. The
 * `/taskboard-analytics` page and Super Agent read the same payload: three
 * section shapes, so 31 panels collapse to 3 renderers.
 *
 * `org` defaults to the caller's own org. `org: "all"` is the cross-tenant
 * aggregate and needs an admin org (see `core/task-board-admin.ts`); a normal
 * member asking for it gets their own org's row, not an error — "all" is a
 * widening request, not a different question. Naming another org explicitly is
 * the admin-only case, and it fails closed.
 */

import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import {
  auditTaskBoardAdminAction,
  isAdminOrgId,
  isTaskBoardAdminCtx,
} from "@/core/task-board-admin";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import type { AnalyticsQuery } from "@/storage/task-board-analytics";

const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

const AnalyticsInputSchema = z
  .object({
    org: z
      .string()
      .optional()
      .describe(
        'Org slug or id to report on. Omit for the current org. "all" is the cross-tenant aggregate (admin orgs only).',
      ),
    from: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("ISO start of the range. Defaults to 30 days ago."),
    to: z
      .string()
      .datetime({ offset: true })
      .optional()
      .describe("ISO end of the range. Defaults to now."),
  })
  .refine((v) => !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to), {
    message: "`from` must not be after `to`",
    path: ["from"],
  });

const StatSectionSchema = z.object({
  kind: z.literal("stat"),
  title: z.string(),
  values: z.array(
    z.object({
      label: z.string(),
      value: z.number().nullable(),
      unit: z.string().optional(),
    }),
  ),
});

const SeriesSectionSchema = z.object({
  kind: z.literal("series"),
  title: z.string(),
  unit: z.string().optional(),
  points: z.array(
    z.record(z.string(), z.union([z.number(), z.string(), z.null()])),
  ),
});

const TableSectionSchema = z.object({
  kind: z.literal("table"),
  title: z.string(),
  columns: z.array(z.string()),
  rows: z.array(z.array(z.union([z.string(), z.number(), z.null()]))),
});

const SectionSchema = z.discriminatedUnion("kind", [
  StatSectionSchema,
  SeriesSectionSchema,
  TableSectionSchema,
]);

const AnalyticsOutputSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  org: z.string(),
  sections: z.array(SectionSchema),
});

type AnalyticsInput = z.infer<typeof AnalyticsInputSchema>;
type AnalyticsOutput = z.infer<typeof AnalyticsOutputSchema>;

/**
 * Turn the shared input into a scoped query. The only place the admin gate is
 * applied for analytics, so both the "all" aggregate and a named other org go
 * through one check.
 */
export async function resolveScope(
  input: AnalyticsInput,
  ctx: StudioContext,
  toolName: string,
): Promise<{ query: AnalyticsQuery; org: string }> {
  const organization = requireOrganization(ctx);
  const own = {
    query: {
      orgIds: [organization.id],
    },
    org: organization.slug ?? organization.id,
  };

  const to = input.to ?? new Date().toISOString();
  const from =
    input.from ?? new Date(Date.parse(to) - DEFAULT_RANGE_MS).toISOString();
  const range = { from, to };

  const orgRef = input.org;
  if (!orgRef || orgRef === organization.slug || orgRef === organization.id) {
    return { query: { ...range, ...own.query }, org: own.org };
  }

  const isAdmin =
    isAdminOrgId(organization.id) && (await isTaskBoardAdminCtx(ctx));

  if (orgRef === "all") {
    if (!isAdmin) return { query: { ...range, ...own.query }, org: own.org };
    auditTaskBoardAdminAction({
      action: "analytics_read",
      actorUserId: ctx.auth?.user?.id,
      actorOrgId: organization.id,
      targetOrgId: "all",
      tool: toolName,
    });
    return { query: { ...range, orgIds: null }, org: "all" };
  }

  if (!isAdmin) {
    throw new Error(
      "Not allowed to read another organization's task board analytics",
    );
  }
  const target = await ctx.storage.taskBoardAnalytics.resolveOrgRef(orgRef);
  if (!target) throw new Error(`Organization not found: ${orgRef}`);
  auditTaskBoardAdminAction({
    action: "analytics_read",
    actorUserId: ctx.auth?.user?.id,
    actorOrgId: organization.id,
    targetOrgId: target.id,
    tool: toolName,
  });
  return {
    query: { ...range, orgIds: [target.id] },
    org: target.slug || target.id,
  };
}

/** One line for the model; the page still gets the full structuredContent. */
function summarize(result: AnalyticsOutput): string {
  const stats = result.sections
    .filter((s) => s.kind === "stat")
    .flatMap((s) => s.values)
    .map((v) => `${v.label}: ${v.value ?? "—"}${v.unit ? ` ${v.unit}` : ""}`)
    .join(", ");
  const tables = result.sections
    .filter((s) => s.kind === "table")
    .map((s) => `${s.title} (${s.rows.length} rows)`)
    .join(", ");
  return [
    `${result.org}, ${result.range.from}..${result.range.to}`,
    stats,
    tables,
  ]
    .filter(Boolean)
    .join(" — ");
}

export function defineAnalyticsTool<TName extends string>(
  name: TName,
  title: string,
  description: string,
  run: (
    ctx: StudioContext,
    query: AnalyticsQuery,
  ) => Promise<AnalyticsOutput["sections"]>,
) {
  return defineTool({
    name,
    description,
    annotations: {
      title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    },
    inputSchema: AnalyticsInputSchema,
    outputSchema: AnalyticsOutputSchema,
    modelSummary: summarize,
    handler: async (input, ctx) => {
      requireAuth(ctx);
      await ctx.access.check();
      const { query, org } = await resolveScope(input, ctx, name);
      return {
        range: { from: query.from, to: query.to },
        org,
        sections: await run(ctx, query),
      };
    },
  });
}

export const TASK_BOARD_DELIVERY = defineAnalyticsTool(
  "TASK_BOARD_DELIVERY",
  "Task Board Delivery",
  "Task board throughput and flow: tasks completed, how many shipped a PR, lead vs cycle time, completions per day by board, time in review, and dwell by lane.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.delivery(query),
);

export const TASK_BOARD_STUCK = defineAnalyticsTool(
  "TASK_BOARD_STUCK",
  "Task Board Stuck Work",
  "What is stuck on the task board right now: open lane visits oldest first, and work in progress bucketed by age. Deliberately not time-filtered.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.stuck(query),
);

export const TASK_BOARD_COST = defineAnalyticsTool(
  "TASK_BOARD_COST",
  "Task Board Cost",
  "Task board spend: total USD, cost per completed task and per shipped PR, spend burned on abandoned work, spend per day, cost by tenant, and the coverage % that says how much of it was actually priced.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.cost(query),
);

export const TASK_BOARD_QUALITY = defineAnalyticsTool(
  "TASK_BOARD_QUALITY",
  "Task Board Quality",
  "Task board quality: first-pass yield, rework rate, autonomy (finished without a human), abandonment, rework over time, and retry burn.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.quality(query),
);

export const TASK_BOARD_ERRORS = defineAnalyticsTool(
  "TASK_BOARD_ERRORS",
  "Task Board Errors",
  "Task board run failures: failed runs, quota-blocked runs, failures per day, failure kinds, a live error feed, error signatures, and superseded runs.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.errors(query),
);

export const TASK_BOARD_TENANTS = defineAnalyticsTool(
  "TASK_BOARD_TENANTS",
  "Task Board Tenants",
  'Per-tenant task board scorecard and queue wait. Pass org: "all" for the cross-tenant view (admin orgs only).',
  (ctx, query) => ctx.storage.taskBoardAnalytics.tenants(query),
);

export const TASK_BOARD_ADMIN_ORG_LIST = defineTool({
  name: "TASK_BOARD_ADMIN_ORG_LIST",
  description:
    "Whether the caller may read every org's task board, and if so the orgs that have board items. Non-admins get an empty list.",
  annotations: {
    title: "List Task Board Admin Orgs",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: z.object({}),
  outputSchema: z.object({
    isTaskBoardAdmin: z.boolean(),
    orgs: z.array(
      z.object({ id: z.string(), slug: z.string(), name: z.string() }),
    ),
  }),
  handler: async (_input, ctx) => {
    requireAuth(ctx);
    await ctx.access.check();
    const organization = requireOrganization(ctx);
    // BOTH conditions: the org being asked about has to be an admin org, and
    // the caller has to belong to one. Membership alone would light the picker
    // up in every tenant the caller happens to be in.
    if (!isAdminOrgId(organization.id) || !(await isTaskBoardAdminCtx(ctx))) {
      return { isTaskBoardAdmin: false, orgs: [] };
    }
    return {
      isTaskBoardAdmin: true,
      orgs: await ctx.storage.taskBoardAnalytics.orgsWithBoardItems(),
    };
  },
});
