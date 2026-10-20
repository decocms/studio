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

import { isProjectAllowed } from "@decocms/shared/auth/project-scope";
import { isScopableProject } from "@decocms/shared/sdk";
import type { VirtualMCPEntity } from "@decocms/shared/sdk/types";
import { z } from "zod";
import { defineTool } from "@/core/define-tool";
import { resolveCallerProjectScope } from "@/core/project-scope";
import {
  auditTaskBoardAdminAction,
  isAdminOrgId,
  isTaskBoardAdminCtx,
} from "@/core/task-board-admin";
import { requireAuth, requireOrganization } from "@/core/studio-context";
import type { StudioContext } from "@/core/studio-context";
import {
  type AnalyticsQuery,
  parseDrill,
} from "@/storage/task-board-analytics";

const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1000;

const AnalyticsFields = z.object({
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
  project: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Project (virtual MCP) id to narrow to: its runs and the cards naming its repository. Omit for the whole board.",
    ),
});

const rangeInOrder = (v: { from?: string; to?: string }) =>
  !v.from || !v.to || Date.parse(v.from) <= Date.parse(v.to);
const RANGE_ORDER = {
  message: "`from` must not be after `to`",
  path: ["from"],
};

const AnalyticsInputSchema = AnalyticsFields.refine(rangeInOrder, RANGE_ORDER);

const OperationTasksInputSchema = AnalyticsFields.extend({
  drill: z
    .string()
    .max(500)
    .refine(
      (v) => parseDrill(v) !== null,
      "Unknown drill: use a figure's `drill` from the report",
    )
    .describe(
      "Which figure to list, as `&`-joined parts: a cohort (`shipped`, `failed_qa`, `returned`, ...), `touch:<kind>` for the cards a person stepped in on that way, or a card field (`type:bug`, `priority:urgent`, `tag:<id>`, `sprint:<id>`, `author:<user id>`; `none` for unset). The reports return each figure's `drill`.",
    ),
}).refine(rangeInOrder, RANGE_ORDER);

const StatSectionSchema = z.object({
  kind: z.literal("stat"),
  title: z.string(),
  values: z.array(
    z.object({
      label: z.string(),
      value: z.number().nullable(),
      unit: z.string().optional(),
      previous: z.number().nullable().optional(),
      better: z.enum(["up", "down"]).optional(),
      detail: z.string().optional(),
      drill: z.string().optional(),
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
  units: z.record(z.string(), z.string()).optional(),
  drills: z.array(z.string().nullable()).optional(),
});

const FunnelSectionSchema = z.object({
  kind: z.literal("funnel"),
  title: z.string(),
  stages: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      drill: z.string().optional(),
    }),
  ),
});

const BarsSectionSchema = z.object({
  kind: z.literal("bars"),
  title: z.string(),
  unit: z.string().optional(),
  total: z.object({ value: z.number(), label: z.string() }).optional(),
  bars: z.array(
    z.object({
      label: z.string(),
      value: z.number(),
      detail: z.string().optional(),
      note: z.string().optional(),
      drill: z.string().optional(),
    }),
  ),
});

const MetricSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string().optional(),
  better: z.enum(["up", "down"]).optional(),
});

const MetricValuesSchema = z.record(z.string(), z.number().nullable());

const BreakdownSectionSchema = z.object({
  kind: z.literal("breakdown"),
  title: z.string(),
  metrics: z.array(MetricSchema),
  dimensions: z.array(
    z.object({
      label: z.string(),
      rows: z.array(
        z.object({
          label: z.string(),
          count: z.number(),
          drill: z.string().optional(),
          values: MetricValuesSchema,
        }),
      ),
    }),
  ),
});

const MatrixSectionSchema = z.object({
  kind: z.literal("matrix"),
  title: z.string(),
  rowLabel: z.string(),
  colLabel: z.string(),
  metrics: z.array(MetricSchema),
  rows: z.array(z.string()),
  cols: z.array(z.string()),
  cells: z.array(
    z.object({
      row: z.string(),
      col: z.string(),
      count: z.number(),
      drill: z.string().optional(),
      values: MetricValuesSchema,
    }),
  ),
});

const CategoriesSectionSchema = z.object({
  kind: z.literal("categories"),
  title: z.string(),
  unit: z.string().optional(),
  layout: z.enum(["stacked", "grouped"]),
  keys: z.array(z.string()),
  baseline: z.string().optional(),
  categories: z.array(
    z.object({
      label: z.string(),
      drill: z.string().optional(),
      values: MetricValuesSchema,
    }),
  ),
});

const SectionSchema = z.discriminatedUnion("kind", [
  StatSectionSchema,
  SeriesSectionSchema,
  TableSectionSchema,
  FunnelSectionSchema,
  BarsSectionSchema,
  BreakdownSectionSchema,
  MatrixSectionSchema,
  CategoriesSectionSchema,
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

/**
 * Narrow a resolved scope to one project. Only within a single org — a project
 * lives in exactly one — and only one the caller's role may see; anything else
 * reads as not found, so a project id never confirms another tenant's project.
 */
async function narrowToProject(
  projectId: string | undefined,
  query: AnalyticsQuery,
  ctx: StudioContext,
): Promise<AnalyticsQuery> {
  if (!projectId) return query;
  const orgId = query.orgIds?.length === 1 ? query.orgIds[0] : undefined;
  const project = orgId
    ? await ctx.storage.virtualMcps.findById(projectId, orgId)
    : null;
  const allowed =
    project?.organization_id === orgId &&
    (orgId !== ctx.organization?.id ||
      isProjectAllowed(await resolveCallerProjectScope(ctx), projectId));
  if (!project || !allowed || !orgId) {
    throw new Error(`Project not found: ${projectId}`);
  }
  return {
    ...query,
    project: {
      id: project.id,
      repo: await ownRepo(ctx, orgId, project),
    },
  };
}

/** The project's `owner/name`, lowercased — or null when another project in
 *  the org pins the same repository, since then the repository alone does not
 *  say whose a card is (`entryForTask` in `apps/web/src/lib/project-index.ts`). */
export async function ownRepo(
  ctx: StudioContext,
  orgId: string,
  project: VirtualMCPEntity,
): Promise<string | null> {
  const repoOf = (p: VirtualMCPEntity) => {
    const repo = p.metadata?.repository;
    return repo ? `${repo.owner}/${repo.name}`.toLowerCase() : null;
  };
  const repo = repoOf(project);
  if (!repo) return null;
  const siblings = (await ctx.storage.virtualMcps.list(orgId)).filter(
    (p) => p.id !== project.id && isScopableProject(p) && repoOf(p) === repo,
  );
  return siblings.length > 0 ? null : repo;
}

/** One line for the model; the page still gets the full structuredContent. */
function summarize(result: AnalyticsOutput): string {
  const stats = result.sections
    .filter((s) => s.kind === "stat")
    .flatMap((s) => s.values)
    .map((v) => `${v.label}: ${v.value ?? "—"}${v.unit ? ` ${v.unit}` : ""}`)
    .join(", ");
  const funnels = result.sections
    .filter((s) => s.kind === "funnel")
    .map((s) => s.stages.map((st) => `${st.label} ${st.value}`).join(" > "))
    .join(", ");
  const breakdowns = result.sections
    .filter((s) => s.kind === "breakdown")
    .flatMap((s) =>
      s.dimensions.map(
        (d) =>
          `by ${d.label}: ${d.rows
            .map(
              (r) =>
                `${r.label} (${r.count}: ${s.metrics
                  .map(
                    (m) =>
                      `${m.label} ${r.values[m.key] ?? "—"}${m.unit ?? ""}`,
                  )
                  .join(", ")})`,
            )
            .join("; ")}`,
      ),
    )
    .join(" | ");
  const tables = result.sections
    .filter((s) => s.kind === "table")
    .map((s) => `${s.title} (${s.rows.length} rows)`)
    .join(", ");
  return [
    `${result.org}, ${result.range.from}..${result.range.to}`,
    stats,
    funnels,
    breakdowns,
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
    handler: (input, ctx) =>
      runAnalytics(input, ctx, name, (query) => run(ctx, query)),
  });
}

async function runAnalytics(
  input: AnalyticsInput,
  ctx: StudioContext,
  toolName: string,
  run: (query: AnalyticsQuery) => Promise<AnalyticsOutput["sections"]>,
): Promise<AnalyticsOutput> {
  requireAuth(ctx);
  await ctx.access.check();
  const scope = await resolveScope(input, ctx, toolName);
  const query = await narrowToProject(input.project, scope.query, ctx);
  return {
    range: { from: query.from, to: query.to },
    org: scope.org,
    sections: await run(query),
  };
}

export const TASK_BOARD_DELIVERY = defineAnalyticsTool(
  "TASK_BOARD_DELIVERY",
  "Task Board Delivery",
  "Task board throughput and flow: tasks completed, how many shipped a PR, lead vs cycle time, completions per day by board, time in review, time in each lane and time to done by priority, by assignee, and dwell by lane.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.delivery(query),
);

export const TASK_BOARD_OPERATION = defineAnalyticsTool(
  "TASK_BOARD_OPERATION",
  "Task Board Operation",
  "How autonomously the agent delivers: of the cards it picked up, how many ran without errors, passed QA (and the customer, where the board has that lane) on the first try, shipped, and shipped on its own (no person sent it back); the failed-QA rate; each against the previous period; and where people stepped in, by intent (sent back, guided, approved or shipped, admin).",
  (ctx, query) => ctx.storage.taskBoardAnalytics.operation(query),
);

export const TASK_BOARD_OPERATION_TASKS = defineTool({
  name: "TASK_BOARD_OPERATION_TASKS",
  description:
    "The cards behind one TASK_BOARD_OPERATION figure (e.g. which tasks failed QA, or which a person re-ran), newest first, up to 200.",
  annotations: {
    title: "Task Board Operation Tasks",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  inputSchema: OperationTasksInputSchema,
  outputSchema: AnalyticsOutputSchema,
  modelSummary: summarize,
  handler: (input, ctx) =>
    runAnalytics(input, ctx, "TASK_BOARD_OPERATION_TASKS", (query) =>
      ctx.storage.taskBoardAnalytics.operationTasks(
        query,
        parseDrill(input.drill) ?? [],
      ),
    ),
});

export const TASK_BOARD_REWORK = defineAnalyticsTool(
  "TASK_BOARD_REWORK",
  "Task Board Rework",
  "Why tasks come back: of the cards the agent picked up, the failed-QA and sent-back-by-a-person rates, who sent work back (QA Agent, team, customer), the QA escape rate, USD spent on rework, and the rates cut by type, priority, tag, sprint and who wrote the brief. Each figure's `drill` lists its cards via TASK_BOARD_OPERATION_TASKS.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.rework(query),
);

export const TASK_BOARD_SPRINTS = defineAnalyticsTool(
  "TASK_BOARD_SPRINTS",
  "Task Board Sprints",
  "Sprint velocity: for each sprint overlapping the range, what it committed to, what shipped, and how much of that shipped with no human; plus the active sprint's progress.",
  (ctx, query) => ctx.storage.taskBoardAnalytics.sprints(query),
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
