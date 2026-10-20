/**
 * Read-only SQL behind the task board analytics surface.
 *
 * Every query here is lifted verbatim from the Grafana dashboards
 * `studio-taskboard-delivery` / `studio-taskboard-quality` (folder uid
 * `efnjfj9ue28zkf`); only the two Grafana macros are translated —
 * `${org:sqlstring}` becomes `orgIn()` and `$__timeFilter(col)` becomes
 * `inRange()`. Two copies of this SQL now exist; a panel and a method
 * disagreeing is the signal to revisit, not a reason to rewrite either.
 *
 * The measurement traps encoded below (Jira classification via the link table,
 * the first-pass-yield denominator, the failure-kind exclusions, percentiles
 * over means, terminal lanes having no dwell) were each found by validating
 * against production. A "cleanup" that removes one silently changes the number.
 */

import { CANONICAL_COLUMN_KEYS } from "@decocms/shared/task-board";
import { sql, type Kysely } from "kysely";
import type { Database } from "./types";

export interface StatSection {
  kind: "stat";
  title: string;
  values: {
    label: string;
    value: number | null;
    unit?: string;
    /** The same figure over the equal-length window before `from`. */
    previous?: number | null;
    /** Which way is good, so a delta can say whether it improved. */
    better?: "up" | "down";
    /** What the figure is out of, e.g. "3 of 34 that reached QA". */
    detail?: string;
    /** The cards behind the figure, for `TASK_BOARD_OPERATION_TASKS`. */
    drill?: string;
  }[];
}

export interface SeriesSection {
  kind: "series";
  title: string;
  unit?: string;
  points: Record<string, number | string | null>[];
}

export interface TableSection {
  kind: "table";
  title: string;
  columns: string[];
  rows: (string | number | null)[][];
  /** Unit per column name (`s`, `USD`, `%`), so a reader formats it. */
  units?: Record<string, string>;
  /** Per row, the drill listing that row's cards. */
  drills?: (string | null)[];
}

/** Nested stages: each one is a subset of the stage before it. */
export interface FunnelSection {
  kind: "funnel";
  title: string;
  stages: { label: string; value: number; drill?: string }[];
}

/** A ranked breakdown — one bar per category, longest first. */
export interface BarsSection {
  kind: "bars";
  title: string;
  /** What `value` counts, e.g. "tasks". */
  unit?: string;
  /** The card's figure, when the bars don't sum to one (a task can be in several). */
  total?: { value: number; label: string };
  bars: {
    label: string;
    value: number;
    /** Beside the figure, e.g. "5 actions". */
    detail?: string;
    /** Beside the label, e.g. what the bar is made of. */
    note?: string;
    drill?: string;
  }[];
}

/** A rate or figure a breakdown or matrix reports for each group of cards. */
export interface Metric {
  key: string;
  label: string;
  unit?: string;
  /** Which way is good, so a reader can colour it. */
  better?: "up" | "down";
}

/** Groups of cards with the same metrics, cut several ways (by type, tag...). */
export interface BreakdownSection {
  kind: "breakdown";
  title: string;
  metrics: Metric[];
  dimensions: {
    label: string;
    rows: {
      label: string;
      count: number;
      drill?: string;
      values: Record<string, number | null>;
    }[];
  }[];
}

/** Two dimensions crossed: one cell per pair, each a group of cards. */
export interface MatrixSection {
  kind: "matrix";
  title: string;
  rowLabel: string;
  colLabel: string;
  metrics: Metric[];
  rows: string[];
  cols: string[];
  cells: {
    row: string;
    col: string;
    count: number;
    drill?: string;
    values: Record<string, number | null>;
  }[];
}

/** Bars per category rather than per day: stacked parts of a whole, or grouped figures side by side. */
export interface CategoriesSection {
  kind: "categories";
  title: string;
  unit?: string;
  layout: "stacked" | "grouped";
  /** The series, in order. Lane keys are drawn as the board's lanes. */
  keys: string[];
  /** The key the others are measured against, drawn neutral (e.g. committed). */
  baseline?: string;
  categories: {
    label: string;
    drill?: string;
    values: Record<string, number | null>;
  }[];
}

export type Section =
  | StatSection
  | SeriesSection
  | TableSection
  | FunnelSection
  | BarsSection
  | BreakdownSection
  | MatrixSection
  | CategoriesSection;

export interface AnalyticsQuery {
  /** Org ids to scope to, or `null` for the cross-tenant aggregate. */
  orgIds: string[] | null;
  from: string;
  to: string;
  /** Narrow to one project's cards; absent for the whole board. */
  project?: AnalyticsProject;
}

export interface AnalyticsProject {
  id: string;
  /** The project's `owner/name`, lowercased; null for a repo-less project or
   *  one whose repository another project also pins. */
  repo: string | null;
}

/** Grafana's `${org:sqlstring}`. `null` is the "All" selection. */
export const orgIn = (orgIds: string[] | null, col: string) =>
  orgIds === null ? sql`true` : sql`${sql.raw(col)} = any(${orgIds}::text[])`;

/**
 * The project-scoped board's attribution (`tasksForProject` in
 * `apps/web/src/lib/project-index.ts`), as SQL: a card stamped for the project,
 * or an unstamped one that a run of the project started, that carries its id
 * in `repo`, or that names its repository in `repo`.
 */
const projectIn = (p: AnalyticsProject) => sql`(
  i.virtual_mcp_id = ${p.id}
  or (i.virtual_mcp_id is null and (
    exists (select 1 from task_board_item_threads pl
            join threads pt on pt.id = pl.thread_id
            where pl.task_board_item_id = i.id and pt.virtual_mcp_id = ${p.id})
    or trim(coalesce(i.repo, '')) = ${p.id}
    or (${p.repo}::text is not null and lower(trim(coalesce(i.repo, ''))) = ${p.repo}::text)
  ))
)`;

/** Every query's card filter; each one aliases `task_board_items` as `i`. */
const scoped = (q: AnalyticsQuery) =>
  q.project
    ? sql`${orgIn(q.orgIds, "i.organization_id")} and ${projectIn(q.project)}`
    : orgIn(q.orgIds, "i.organization_id");

/** Grafana's `$__timeFilter(col)`. */
export const inRange = (col: string, q: AnalyticsQuery) =>
  sql`${sql.raw(col)} between ${q.from}::timestamptz and ${q.to}::timestamptz`;

/**
 * One lane visit per row: when a card entered a lane, when it left, and who
 * moved it. Copy-pasted into ~8 dashboard panels; extracted once here, logic
 * untouched.
 */
const movesCte = (q: AnalyticsQuery) => sql`
  select i.organization_id            as org_id,
         o.slug                       as org_slug,
         i.id                         as item_id,
         case
           when exists (select 1 from task_board_item_jira_links j where j.item_id = i.id)
             then case when i.source = 'jira' then 'jira-anchor' else 'jira' end
           else 'studio'
         end                          as board,
         i.type                       as task_type,
         i.title                      as title,
         i.priority                   as priority,
         coalesce(i.assigned_by, i.created_by) as sent_by,
         a.data->>'from'              as from_lane,
         a.data->>'to'                as lane,
         a.data->>'reason'            as reason,
         a.actor_id                   as actor_id,
         a.occurred_at                as entered_at,
         lead(a.occurred_at) over w   as left_at,
         lead(a.actor_id)    over w   as next_actor
  from task_board_activity a
  join task_board_items i on i.id = a.task_board_item_id
  join organization o     on o.id = i.organization_id
  where a.action = 'status_changed' and ${scoped(q)}
  window w as (partition by a.task_board_item_id order by a.occurred_at, a.id)
`;

/** The lanes a card reaches when its work ships: Post-deploy Validation, then
 *  Done (or the previous board's Merged). */
const SHIPPED_LANES = sql.raw("('done','merged','post_deploy_validation')");

/**
 * Each card's FIRST move into a shipped lane, from `moves`. A card goes
 * through Post-deploy Validation and then Done, and counting both would ship
 * it twice, on two different days.
 */
const firstShippedCte = sql`
  select distinct on (item_id) *
  from moves where lane in ${SHIPPED_LANES}
  order by item_id, entered_at
`;

/** USD per card, from the OpenRouter price recorded on `finish` parts. */
const taskCostCte = (q: AnalyticsQuery) => sql`
  select l.task_board_item_id as item_id,
         i.organization_id    as org_id,
         o.slug               as org_slug,
         sum(coalesce((p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric, 0)) as usd,
         min(l.created_at)    as first_run_at
  from task_board_item_threads l
  join thread_message_parts p on p.thread_id = l.thread_id and p.kind = 'finish'
  join task_board_items i     on i.id = l.task_board_item_id
  join organization o         on o.id = i.organization_id
  where ${scoped(q)}
  group by 1, 2, 3
`;

/** Cards that reached done/merged AND actually went through review. */
const reviewedCompletedCte = (q: AnalyticsQuery) => sql`
  select i.organization_id as org_id, o.slug as org_slug, a.task_board_item_id as item_id,
         min(a.occurred_at) as done_at
  from task_board_activity a
  join task_board_items i on i.id = a.task_board_item_id
  join organization o     on o.id = i.organization_id
  where a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES}
    and ${scoped(q)}
    and exists (select 1 from task_board_activity a2
                where a2.task_board_item_id = a.task_board_item_id
                  and a2.action = 'status_changed' and a2.data->>'to' = 'in_review')
  group by 1, 2, 3
`;

const reworkCte = (q: AnalyticsQuery) => sql`
  select a.task_board_item_id as item_id, count(*) as changes_requested
  from task_board_activity a
  join task_board_items i on i.id = a.task_board_item_id
  where a.action = 'review_changes_requested' and ${scoped(q)}
  group by 1
`;

/** Failure kinds that are settled history, not errors (see `errors()`). */
const NOT_AN_ERROR = sql.raw(
  "('superseded','ended_after_delivery','cancelled','abandoned','credits')",
);

/** A `status_changed` row (aliased `t`) moving the card to an earlier lane.
 *  Archive sorts last, so leaving it isn't a move back. */
const movedBack = (t: "a" | "b") => sql`coalesce(
  array_position(${[...CANONICAL_COLUMN_KEYS]}::text[], ${sql.raw(t)}.data->>'to')
    < array_position(${[...CANONICAL_COLUMN_KEYS]}::text[], ${sql.raw(t)}.data->>'from')
    and ${sql.raw(t)}.data->>'from' <> 'archived', false)`;
const MOVED_BACK = movedBack("a");

/**
 * An activity row (`a`) that sent work back: changes requested, a re-run, or a
 * move to an earlier lane. The system's own moves after a verdict are the same
 * return again, so only people's moves count, plus anything leaving the
 * customer's lane, which is the customer's call however it was recorded.
 */
const isReturn = (t: "a" | "b") => {
  const r = sql.raw(t);
  return sql`(${r}.action = 'review_changes_requested'
    or (${r}.action = 'status_changed'
        and (${r}.data->>'reason' = 'rerun' or ${movedBack(t)})
        and (${r}.actor_id is not null or ${r}.data->>'from' = 'customer_approval')))`;
};
const RETURNED = isReturn("a");

/** Who sent a `RETURNED` row back. */
const RETURN_SOURCE = sql`case
  when a.action = 'review_changes_requested' and a.actor_id is null then 'QA Agent'
  when a.data->>'from' = 'customer_approval' then 'Customer'
  else 'Team' end`;

/** Order and labels of the classes a person's step falls into. */
const TOUCH_CLASSES = [
  { key: "return", label: "Sent back" },
  { key: "steer", label: "Guided" },
  { key: "gate", label: "Approved or shipped" },
  { key: "admin", label: "Admin" },
] as const;

/**
 * One row per card first run in range, or (`sprints`) every card in a sprint.
 * QA is the review lane: a card reached it when it entered In Review or got a
 * verdict, and failed it when the reviewer — agent or person — asked for
 * changes. `returned` (a person or the customer sent it back) is all autonomy counts.
 */
const operationFacts = (
  q: AnalyticsQuery,
  cohort: "ran" | "sprints" = "ran",
  /** Ignore activity after this, so an earlier period is judged at the same age. */
  asOf?: string,
) => {
  const seen = asOf ? sql`and a.occurred_at <= ${asOf}::timestamptz` : sql``;
  return sql`
  select i.id as item_id, r.first_run_at, coalesce(r.errored, false) as errored,
         i.title, i.status, i.type, i.priority, i.sprint_id, i.created_by,
         exists (select 1 from task_board_activity a
                 where a.task_board_item_id = i.id ${seen}
                   and ((a.action = 'status_changed' and a.data->>'to' = 'in_review')
                        or a.action in ('review_approved','review_changes_requested'))) as reached_qa,
         (select count(*) from task_board_activity a
          where a.task_board_item_id = i.id ${seen}
            and a.action = 'review_changes_requested') as qa_failures,
         exists (select 1 from task_board_activity a
                 where a.task_board_item_id = i.id ${seen}
                   and a.action = 'review_changes_requested') as failed_qa,
         exists (select 1 from task_board_activity a
                 where a.task_board_item_id = i.id ${seen}
                   and a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES}) as shipped,
         exists (select 1 from task_board_activity a
                 where a.task_board_item_id = i.id ${seen} and a.occurred_at > r.first_run_at
                   and ${RETURNED} and ${RETURN_SOURCE} <> 'QA Agent') as returned,
         -- Rounds: a send-back within a day of the last one is the same round.
         (select count(*) from task_board_activity a
          where a.task_board_item_id = i.id ${seen} and a.occurred_at > r.first_run_at
            and ${RETURNED}
            and not exists (select 1 from task_board_activity b
                            where b.task_board_item_id = i.id and b.occurred_at > r.first_run_at
                              and b.occurred_at < a.occurred_at
                              and b.occurred_at >= a.occurred_at - interval '1 day'
                              and ${isReturn("b")})) as returns,
         exists (select 1 from task_board_activity a
                 where a.task_board_item_id = i.id ${seen} and a.occurred_at > r.first_run_at
                   and ${RETURNED} and ${RETURN_SOURCE} = 'Customer') as customer_returned,
         exists (select 1 from task_board_activity a
                 where a.task_board_item_id = i.id ${seen}
                   and a.action = 'status_changed' and a.data->>'to' = 'customer_approval') as reached_customer
  from task_board_items i
  left join (
    select l.task_board_item_id as item_id,
           min(l.created_at) as first_run_at,
           bool_or(t.status = 'failed' and coalesce(t.failure_kind, 'error') not in ${NOT_AN_ERROR}) as errored
    from task_board_item_threads l
    join threads t on t.id = l.thread_id
    join task_board_items ri on ri.id = l.task_board_item_id
    where ${orgIn(q.orgIds, "ri.organization_id")}
      ${
        cohort === "ran"
          ? // Only cards with a run in range can have their first one there.
            sql`and l.task_board_item_id in (
                  select task_board_item_id from task_board_item_threads
                  where ${orgIn(q.orgIds, "organization_id")} and ${inRange("created_at", q)})`
          : sql``
      }
    group by 1
  ) r on r.item_id = i.id
  where ${scoped(q)}
    and ${cohort === "sprints" ? sql`i.sprint_id is not null` : inRange("r.first_run_at", q)}
`;
};

/** Each operation cohort, as a filter over `operationFacts`' columns. */
const OPERATION_COHORTS = {
  ran: "first_run_at is not null",
  reached_qa: "reached_qa",
  first_pass: "reached_qa and not failed_qa",
  clean: "reached_qa and not failed_qa and not errored",
  customer_first_pass:
    "reached_qa and not failed_qa and not errored and not customer_returned",
  shipped_first_pass:
    "reached_qa and not failed_qa and not errored and not customer_returned and shipped",
  zero_touch:
    "reached_qa and not failed_qa and not errored and not customer_returned and shipped and not returned",
  failed_qa: "failed_qa",
  shipped: "shipped",
  shipped_untouched: "shipped and not returned and first_run_at is not null",
  returned: "returned",
  sent_back: "failed_qa or returned",
  reached_customer: "reached_customer",
  customer_returned: "customer_returned",
  failed_qa_repeat: "qa_failures >= 2",
  still_open: "not shipped and status <> 'archived'",
  shipped_round_1: "shipped and returns = 0",
  shipped_round_2: "shipped and returns = 1",
  shipped_round_3: "shipped and returns >= 2",
} as const;

export type OperationCohort = keyof typeof OPERATION_COHORTS;

const isOperationCohort = (v: string): v is OperationCohort =>
  Object.hasOwn(OPERATION_COHORTS, v);

/** The card fields a drill can narrow on, as `field:value`. */
const DRILL_FIELDS = [
  "touch",
  "class",
  "source",
  "type",
  "priority",
  "tag",
  "sprint",
  "author",
] as const;
type DrillField = (typeof DRILL_FIELDS)[number];

export type DrillPart =
  | { cohort: OperationCohort }
  | { scope: "planned" }
  | { field: DrillField; value: string };

/**
 * A figure's cards, as `&`-joined parts: a cohort (`failed_qa`), a kind of
 * human step (`touch:Re-ran`), or a card field (`tag:<id>`, `sprint:none`).
 * `failed_qa&tag:tag_ui` is the cards tagged UI that failed QA. The cards are
 * those first run in range, or with `planned`, every card in a sprint. Null
 * when any part is unknown, so a typo is an error rather than every card.
 */
export function parseDrill(drill: string): DrillPart[] | null {
  const parts: DrillPart[] = [];
  for (const raw of drill.split("&")) {
    if (isOperationCohort(raw)) {
      parts.push({ cohort: raw });
      continue;
    }
    if (raw === "planned") {
      parts.push({ scope: "planned" });
      continue;
    }
    const colon = raw.indexOf(":");
    const field = DRILL_FIELDS.find((f) => f === raw.slice(0, colon));
    const value = raw.slice(colon + 1);
    if (colon < 0 || !field || !value) return null;
    parts.push({ field, value });
  }
  return parts.length > 0 ? parts : null;
}

/** One drill part as a filter over `f` (`operationFacts`), with `t` in scope. */
function drillWhere(part: DrillPart) {
  if ("cohort" in part) return sql.raw(OPERATION_COHORTS[part.cohort]);
  if ("scope" in part) return sql`true`;
  const { field, value } = part;
  const none = value === "none";
  switch (field) {
    case "touch":
      return sql`exists (select 1 from t where t.item_id = f.item_id and t.kind = ${value})`;
    case "class":
      return sql`exists (select 1 from t where t.item_id = f.item_id and t.class = ${value})`;
    case "source":
      return sql`exists (select 1 from task_board_activity a
                         where a.task_board_item_id = f.item_id and a.occurred_at > f.first_run_at
                           and ${RETURNED} and ${RETURN_SOURCE} = ${value})`;
    case "type":
      return sql`f.type = ${value}`;
    case "priority":
      return sql`f.priority = ${value}`;
    case "tag":
      return none
        ? sql`not exists (select 1 from task_board_item_tags g where g.task_board_item_id = f.item_id)`
        : sql`exists (select 1 from task_board_item_tags g where g.task_board_item_id = f.item_id and g.id = ${value})`;
    case "sprint":
      return none ? sql`f.sprint_id is null` : sql`f.sprint_id = ${value}`;
    case "author":
      return sql`f.created_by = ${value}`;
    default: {
      const unhandled: never = field;
      return unhandled;
    }
  }
}

const cohortCount = (key: OperationCohort) =>
  sql`count(*) filter (where ${sql.raw(OPERATION_COHORTS[key])})`;

/** Every person's action on a card in `f` after its first run, by kind. */
const humanTouches = () => sql`
  select item_id, at, kind,
         case
           when kind in ('Re-ran','Moved back','Requested changes') then 'return'
           when kind in ('Commented','Rewrote the brief') then 'steer'
           when kind in ('Approved by hand','Shipped by hand','Moved forward') then 'gate'
           else 'admin'
         end as class
  from (
    select f.item_id, a.occurred_at as at,
           case
             when a.action = 'status_changed' and a.data->>'reason' = 'rerun' then 'Re-ran'
             when a.action = 'status_changed' and ${MOVED_BACK} then 'Moved back'
             when a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES} then 'Shipped by hand'
             when a.action = 'status_changed' and 'archived' in (a.data->>'to', a.data->>'from') then 'Archived'
             when a.action = 'status_changed' then 'Moved forward'
             when a.action = 'review_changes_requested' then 'Requested changes'
             when a.action = 'review_approved' then 'Approved by hand'
             when a.action in ('title_changed','description_changed') then 'Rewrote the brief'
             when a.action = 'assignee_changed' then 'Reassigned'
             when a.action in ('priority_changed','due_date_changed','tags_changed','type_changed') then 'Re-triaged'
             else 'Other'
           end as kind
    from f
    join task_board_activity a on a.task_board_item_id = f.item_id
    where a.actor_id is not null and a.action <> 'created' and a.occurred_at > f.first_run_at
    union all
    select f.item_id, m.created_at as at, 'Commented' as kind
    from f
    join task_board_comments m on m.task_board_item_id = f.item_id
    where m.thread_id is null and m.created_at > f.first_run_at
  ) h
`;

/** USD a `finish` part (`p`) recorded, from the OpenRouter price. */
const RUN_COST = sql`coalesce((p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric, 0)`;

const RETURN_SOURCES = ["QA Agent", "Team", "Customer"] as const;

/** Every send-back of a card in `f` after its first run, and who sent it. */
const returnsOf = () => sql`
  select f.item_id, a.occurred_at as at, ${RETURN_SOURCE} as source
  from f
  join task_board_activity a on a.task_board_item_id = f.item_id
  where a.occurred_at > f.first_run_at and ${RETURNED}
`;

/** The rates every rework cut reports, over a group of `f` rows. */
const REWORK_RATES = sql`
  count(*) as n,
  round(100.0 * count(*) filter (where failed_qa)
        / nullif(count(*) filter (where reached_qa), 0), 1) as failed_qa,
  round(100.0 * count(*) filter (where returned) / nullif(count(*), 0), 1) as returned,
  round(100.0 * count(*) filter (where shipped and not returned)
        / nullif(count(*) filter (where shipped), 0), 1) as untouched`;

const REWORK_METRICS: Metric[] = [
  { key: "failed_qa", label: "Failed QA", unit: "%", better: "down" },
  {
    key: "returned",
    label: "Sent back by a person",
    unit: "%",
    better: "down",
  },
  {
    key: "untouched",
    label: "Shipped on its own",
    unit: "%",
    better: "up",
  },
];

const PRIORITY_RANK = sql`case priority when 'urgent' then 0 when 'high' then 1
  when 'medium' then 2 when 'low' then 3 else 4 end`;

/** Each way to cut the cards: its joins onto `f`, the group's name and drill. */
const REWORK_CUTS = [
  {
    label: "Type",
    join: sql``,
    name: sql`initcap(f.type)`,
    drill: sql`'type:' || f.type`,
    order: sql`n desc`,
  },
  {
    label: "Priority",
    join: sql``,
    name: sql`initcap(f.priority)`,
    drill: sql`'priority:' || f.priority`,
    order: sql`min(${PRIORITY_RANK})`,
  },
  {
    label: "Tag",
    join: sql`left join task_board_item_tags g on g.task_board_item_id = f.item_id
              left join organization_tags o on o.id = g.id`,
    name: sql`coalesce(o.name, 'No tag')`,
    drill: sql`'tag:' || coalesce(o.id, 'none')`,
    order: sql`n desc`,
  },
  {
    label: "Sprint",
    join: sql`left join task_board_sprints s on s.id = f.sprint_id`,
    name: sql`coalesce(s.name, 'Backlog')`,
    drill: sql`'sprint:' || coalesce(s.id, 'none')`,
    order: sql`min(s.start_date) desc nulls last`,
  },
  {
    label: "Brief by",
    join: sql`left join "user" u on u.id = f.created_by`,
    name: sql`coalesce(u.name, 'Unknown')`,
    drill: sql`'author:' || f.created_by`,
    order: sql`n desc`,
  },
];

const rates = (r: Row) =>
  Object.fromEntries(REWORK_METRICS.map((m) => [m.key, num(r[m.key])]));

/** pg hands back numeric and bigint as strings. */
export const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

export const iso = (v: unknown): string =>
  v instanceof Date ? v.toISOString() : String(v ?? "");

const cell = (v: unknown): string | number | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const n = Number(v);
    return v.trim() !== "" && Number.isFinite(n) ? n : v;
  }
  return String(v);
};

export type Row = Record<string, unknown>;

export const table = (
  title: string,
  columns: string[],
  rows: Row[],
  units?: Record<string, string>,
): TableSection => ({
  kind: "table",
  title,
  columns,
  rows: rows.map((r) => columns.map((c) => cell(r[c]))),
  ...(units ? { units } : {}),
});

/** Where a report reads `operationFacts` from, and how it runs queries. */
interface Facts {
  rows: (query: ReturnType<typeof sql>) => Promise<Row[]>;
  f: ReturnType<typeof sql>;
}

export class TaskBoardAnalyticsStorage {
  constructor(private readonly db: Kysely<Database>) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    const result = await query.execute(this.db);
    return result.rows as Row[];
  }

  /** Runs a report against `operationFacts(q)` computed once: a report reads
   *  it up to ten times, and each read scans the org's cards. */
  private withFacts<T>(
    q: AnalyticsQuery,
    run: (x: Facts) => Promise<T>,
  ): Promise<T> {
    return this.db.transaction().execute(async (trx) => {
      await sql`create temp table operation_facts on commit drop as ${operationFacts(q)}`.execute(
        trx,
      );
      return run({
        rows: async (query) => (await query.execute(trx)).rows as Row[],
        f: sql`select * from operation_facts`,
      });
    });
  }

  /** Panels 1–7: did the work ship, and where did the time go? */
  async delivery(q: AnalyticsQuery): Promise<Section[]> {
    const moves = movesCte(q);

    const [headline] = await this.rows(sql`
      with moves as (${moves}), shipped as (${firstShippedCte})
      select count(distinct item_id) as completed,
             count(distinct item_id) filter (
               where exists (select 1 from task_board_item_prs p where p.task_board_item_id = m.item_id)
             ) as with_pr,
             round(100.0 * count(distinct item_id) filter (
               where exists (select 1 from task_board_item_prs p where p.task_board_item_id = m.item_id)
             ) / nullif(count(distinct item_id), 0), 1) as pr_rate
      from shipped m where ${inRange("entered_at", q)}
    `);

    const [times] = await this.rows(sql`
      with fd as (
        select a.task_board_item_id as item_id, min(a.occurred_at) as done_at
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES}
          and ${scoped(q)}
        group by 1
      )
      select round((percentile_cont(0.5) within group (order by lead_h))::numeric, 0)  as lead_p50,
             round((percentile_cont(0.9) within group (order by lead_h))::numeric, 0)  as lead_p90,
             round((percentile_cont(0.5) within group (order by cycle_h))::numeric, 0) as cycle_p50
      from (
        select extract(epoch from (fd.done_at - i.created_at::timestamptz)) as lead_h,
               extract(epoch from (fd.done_at - st.started_at)) as cycle_h
        from fd
        join task_board_items i on i.id = fd.item_id
        left join lateral (
          select min(a2.occurred_at) as started_at from task_board_activity a2
          where a2.task_board_item_id = fd.item_id and a2.action = 'status_changed'
            and a2.data->>'to' = 'in_progress'
        ) st on true
        where ${inRange("fd.done_at", q)}
      ) x
    `);

    const completionsPerDay = await this.rows(sql`
      with moves as (${moves}), shipped as (${firstShippedCte})
      select date_trunc('day', entered_at) as t,
             count(distinct item_id) filter (where board = 'studio')      as "Kanban",
             count(distinct item_id) filter (where board = 'jira')        as "Jira",
             count(distinct item_id) filter (where board = 'jira-anchor') as "Jira (trigger anchor)"
      from shipped where ${inRange("entered_at", q)}
      group by 1 order by 1
    `);

    const reviewTime = await this.rows(sql`
      with moves as (${moves})
      select date_trunc('day', entered_at) as t,
             round((percentile_cont(0.5) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p50",
             round((percentile_cont(0.9) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p90"
      from moves
      where lane = 'in_review' and left_at is not null and ${inRange("entered_at", q)}
      group by 1 order by 1
    `);

    const dwell = await this.rows(sql`
      with moves as (${moves})
      select lane as "Lane",
             count(*) as "Visits",
             round((percentile_cont(0.5) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p50",
             round((percentile_cont(0.9) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p90",
             round(max(extract(epoch from (left_at - entered_at)))::numeric, 0) as "Max"
      from moves
      where lane not in ('done','merged','archived') and left_at is not null and ${inRange("entered_at", q)}
      group by 1 order by 3 desc
    `);

    // The SLA view: where a card's time goes, by how urgent it was.
    const laneByPriority = await this.rows(sql`
      with moves as (${moves})
      select initcap(priority) as priority, min(${PRIORITY_RANK}) as rank, lane,
             round((percentile_cont(0.5) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as p50
      from moves
      where lane not in ('done','merged','archived') and left_at is not null and ${inRange("entered_at", q)}
      group by 1, 3
    `);
    const lanes = CANONICAL_COLUMN_KEYS.filter((k) =>
      laneByPriority.some((r) => r.lane === k),
    );
    const extraLanes = [
      ...new Set(
        laneByPriority
          .map((r) => String(r.lane))
          .filter((l) => !lanes.some((k) => k === l)),
      ),
    ];
    const priorities = [
      ...new Map(
        laneByPriority
          .sort((a, b) => (num(a.rank) ?? 0) - (num(b.rank) ?? 0))
          .map((r) => [String(r.priority), r] as const),
      ).keys(),
    ];

    const byPriority = await this.rows(sql`
      with fd as (
        select a.task_board_item_id as item_id, min(a.occurred_at) as done_at
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES}
          and ${scoped(q)}
        group by 1
      )
      select initcap(i.priority) as "Priority", count(*) as "Done",
             round((percentile_cont(0.5) within group (order by extract(epoch from (fd.done_at - i.created_at::timestamptz))))::numeric, 0) as "p50",
             round((percentile_cont(0.9) within group (order by extract(epoch from (fd.done_at - i.created_at::timestamptz))))::numeric, 0) as "p90",
             round(max(extract(epoch from (fd.done_at - i.created_at::timestamptz)))::numeric, 0) as "Slowest"
      from fd join task_board_items i on i.id = fd.item_id
      where ${inRange("fd.done_at", q)}
      group by i.priority
      order by min(${PRIORITY_RANK})
    `);

    // Who handed the card to the agent; the agent itself as assignee says nothing.
    const bySender = await this.rows(sql`
      with fd as (
        select a.task_board_item_id as item_id, min(a.occurred_at) as done_at
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES}
          and ${scoped(q)}
        group by 1
      )
      select coalesce(u.name, 'Unknown') as "Sent by",
             count(*) as "Done",
             round((percentile_cont(0.5) within group (order by extract(epoch from (fd.done_at - i.created_at::timestamptz))))::numeric, 0) as "Lead p50",
             round((percentile_cont(0.5) within group (order by extract(epoch from (fd.done_at - st.started_at))))::numeric, 0) as "Cycle p50"
      from fd
      join task_board_items i on i.id = fd.item_id
      left join "user" u on u.id = coalesce(i.assigned_by, i.created_by)
      left join lateral (
        select min(a2.occurred_at) as started_at from task_board_activity a2
        where a2.task_board_item_id = fd.item_id and a2.action = 'status_changed'
          and a2.data->>'to' = 'in_progress'
      ) st on true
      where ${inRange("fd.done_at", q)}
      group by 1 order by 2 desc
      limit 20
    `);

    return [
      {
        kind: "stat",
        title: "Throughput",
        values: [
          { label: "Tasks completed", value: num(headline?.completed) },
          { label: "Completed with a PR", value: num(headline?.with_pr) },
          { label: "PR rate", value: num(headline?.pr_rate), unit: "%" },
          { label: "Lead p50", value: num(times?.lead_p50), unit: "s" },
          { label: "Lead p90", value: num(times?.lead_p90), unit: "s" },
          { label: "Cycle p50", value: num(times?.cycle_p50), unit: "s" },
        ],
      },
      {
        kind: "categories",
        title: "Time in each lane, by priority",
        unit: "s",
        layout: "stacked",
        keys: [...lanes, ...extraLanes],
        categories: priorities.map((priority) => ({
          label: priority,
          values: Object.fromEntries(
            laneByPriority
              .filter((r) => r.priority === priority)
              .map((r) => [String(r.lane), num(r.p50)]),
          ),
        })),
      },
      table(
        "Time to done, by priority",
        ["Priority", "Done", "p50", "p90", "Slowest"],
        byPriority,
        { p50: "s", p90: "s", Slowest: "s" },
      ),
      {
        kind: "series",
        title: "Completions per day",
        points: completionsPerDay.map((r) => ({
          t: iso(r.t),
          Kanban: num(r.Kanban),
          Jira: num(r.Jira),
          "Jira (trigger anchor)": num(r["Jira (trigger anchor)"]),
        })),
      },
      {
        kind: "series",
        title: "Time in review (completed visits)",
        unit: "s",
        points: reviewTime.map((r) => ({
          t: iso(r.t),
          p50: num(r.p50),
          p90: num(r.p90),
        })),
      },
      table(
        "By who sent it",
        ["Sent by", "Done", "Lead p50", "Cycle p50"],
        bySender,
        { "Lead p50": "s", "Cycle p50": "s" },
      ),
      table("Dwell by lane", ["Lane", "Visits", "p50", "p90", "Max"], dwell, {
        p50: "s",
        p90: "s",
        Max: "s",
      }),
    ];
  }

  /**
   * Panels 8 + 34: what is stuck, right now. Deliberately NOT time-filtered — a
   * card stuck since before the range is exactly what you want to see.
   */
  async stuck(q: AnalyticsQuery): Promise<Section[]> {
    const moves = movesCte(q);

    const stuckNow = await this.rows(sql`
      with moves as (${moves})
      select org_slug as "Org", lane as "Lane", left(title, 80) as "Task", item_id as "Task ID",
             round(extract(epoch from (now() - entered_at))::numeric, 0) as "Age",
             case when m.actor_id is null then 'Agent' else coalesce(mu.name, 'Someone') end as "Moved in by",
             su.name as "Sent by"
      from moves m
      left join "user" mu on mu.id = m.actor_id
      left join "user" su on su.id = m.sent_by
      where left_at is null and lane not in ('done','merged','post_deploy_validation','archived')
      order by entered_at asc limit 50
    `);

    const wip = await this.rows(sql`
      with moves as (${moves})
      select lane as "Lane",
             count(*) as "Cards",
             count(*) filter (where now() - entered_at < interval '1 day')  as "< 1d",
             count(*) filter (where now() - entered_at >= interval '1 day'
                                and now() - entered_at < interval '7 days') as "1-7d",
             count(*) filter (where now() - entered_at >= interval '7 days') as "> 7d",
             round(extract(epoch from (now() - min(entered_at)))::numeric / 86400, 1) as "Oldest (days)"
      from moves where left_at is null and lane not in ('done','merged','post_deploy_validation','archived')
      group by 1 order by 2 desc
    `);

    return [
      table(
        "Stuck right now",
        ["Org", "Lane", "Task", "Age", "Moved in by", "Sent by", "Task ID"],
        stuckNow,
        { Age: "s" },
      ),
      table(
        "Work in progress, by age",
        ["Lane", "Cards", "< 1d", "1-7d", "> 7d", "Oldest (days)"],
        wip,
      ),
    ];
  }

  /**
   * Panels 21–26 + 35: spend. Only OpenRouter-routed runs record a price, so
   * every USD figure ships next to the coverage % — without it the number is
   * quietly wrong.
   */
  async cost(q: AnalyticsQuery): Promise<Section[]> {
    const taskCost = taskCostCte(q);
    const spend = await this.reworkSpend({
      rows: (query) => this.rows(query),
      f: operationFacts(q),
    });

    const [total] = await this.rows(sql`
      with task_cost as (${taskCost})
      select round(sum(usd), 2) as usd from task_cost where ${inRange("first_run_at", q)}
    `);

    const [perTask] = await this.rows(sql`
      with task_cost as (${taskCost}),
      completed as (
        select a.task_board_item_id as item_id
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES}
          and ${scoped(q)}
        group by 1
        having ${inRange("min(a.occurred_at)", q)}
      )
      select round(sum(c.usd) / nullif(count(*), 0), 2) as usd
      from completed d join task_cost c on c.item_id = d.item_id
    `);

    const [perPr] = await this.rows(sql`
      with task_cost as (${taskCost}),
      completed as (
        select a.task_board_item_id as item_id
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ${SHIPPED_LANES}
          and ${scoped(q)}
          and exists (select 1 from task_board_item_prs pr where pr.task_board_item_id = a.task_board_item_id)
        group by 1
        having ${inRange("min(a.occurred_at)", q)}
      )
      select round(sum(c.usd) / nullif(count(*), 0), 2) as usd
      from completed d join task_cost c on c.item_id = d.item_id
    `);

    const [abandoned] = await this.rows(sql`
      with task_cost as (${taskCost}),
      dropped as (
        select distinct a.task_board_item_id as item_id
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' = 'archived'
          and ${inRange("a.occurred_at", q)} and ${scoped(q)}
          and not exists (select 1 from task_board_item_prs pr where pr.task_board_item_id = a.task_board_item_id)
      )
      select count(*) as dropped,
             count(*) filter (where c.item_id is not null) as ever_ran,
             round(coalesce(sum(c.usd), 0), 2) as usd_burned
      from dropped d left join task_cost c on c.item_id = d.item_id
    `);

    const [coverage] = await this.rows(sql`
      select round(100.0 * count(*) filter (
               where p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost' is not null)
             / nullif(count(*), 0), 1) as pct
      from thread_message_parts p
      join task_board_item_threads l on l.thread_id = p.thread_id
      join task_board_items i on i.id = l.task_board_item_id
      where p.kind = 'finish' and ${inRange("l.created_at", q)}
        and ${scoped(q)}
    `);

    const perDay = await this.rows(sql`
      select date_trunc('day', l.created_at) as t,
             round(sum(coalesce((p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric, 0)), 2) as "USD"
      from task_board_item_threads l
      join thread_message_parts p on p.thread_id = l.thread_id and p.kind = 'finish'
      join task_board_items i     on i.id = l.task_board_item_id
      where ${inRange("l.created_at", q)} and ${scoped(q)}
      group by 1 order by 1
    `);

    const byTenant = await this.rows(sql`
      with task_cost as (${taskCost})
      select org_slug as "Org", org_id as "Org ID",
             count(*) as "Tasks with runs",
             round(sum(usd), 2) as "Total USD",
             round((percentile_cont(0.5) within group (order by usd))::numeric, 2) as "Median USD / task",
             round(max(usd), 2) as "Priciest task USD"
      from task_cost where ${inRange("first_run_at", q)}
      group by 1, 2 order by 4 desc nulls last limit 50
    `);

    return [
      {
        kind: "stat",
        title: "Cost",
        values: [
          { label: "Total spend", value: num(total?.usd), unit: "USD" },
          {
            label: "Cost per completed task",
            value: num(perTask?.usd),
            unit: "USD",
          },
          {
            label: "Cost per shipped PR",
            value: num(perPr?.usd),
            unit: "USD",
          },
          { label: "Tasks dropped", value: num(abandoned?.dropped) },
          { label: "...that ever ran", value: num(abandoned?.ever_ran) },
          {
            label: "Spend on abandoned work",
            value: num(abandoned?.usd_burned),
            unit: "USD",
          },
          {
            label: "Spent on rework",
            value: spend.rework,
            unit: "USD",
            detail: "runs after a task was sent back",
            drill: "sent_back",
          },
          { label: "Cost coverage", value: num(coverage?.pct), unit: "%" },
        ],
      },
      {
        kind: "series",
        title: "Spend per day",
        unit: "USD",
        points: perDay.map((r) => ({ t: iso(r.t), USD: num(r.USD) })),
      },
      table(
        "Cost by tenant",
        [
          "Org",
          "Org ID",
          "Tasks with runs",
          "Total USD",
          "Median USD / task",
          "Priciest task USD",
        ],
        byTenant,
        {
          "Total USD": "USD",
          "Median USD / task": "USD",
          "Priciest task USD": "USD",
        },
      ),
    ];
  }

  /** Panels 27–32: is the agent shipping work that holds? */
  async quality(q: AnalyticsQuery): Promise<Section[]> {
    const completed = reviewedCompletedCte(q);
    const moves = movesCte(q);

    const [yieldRow] = await this.rows(sql`
      with completed as (${completed}), rework as (${reworkCte(q)})
      select round(100.0 * count(*) filter (where coalesce(r.changes_requested, 0) = 0)
                   / nullif(count(*), 0), 1) as clean_first_pass,
             round(avg(coalesce(r.changes_requested, 0))::numeric, 2) as changes_per_task
      from completed c left join rework r on r.item_id = c.item_id
      where ${inRange("c.done_at", q)}
    `);

    const [autonomy] = await this.rows(sql`
      with moves as (${moves}), shipped as (${firstShippedCte})
      select round(100.0 * count(*) filter (where actor_id is null)
                   / nullif(count(*), 0), 1) as pct
      from shipped where ${inRange("entered_at", q)}
    `);

    const [abandonment] = await this.rows(sql`
      with moves as (${moves})
      select round(100.0 * count(distinct item_id) filter (
               where not exists (select 1 from task_board_item_prs pr where pr.task_board_item_id = m.item_id))
             / nullif(count(distinct item_id), 0), 1) as pct
      from moves m where lane = 'archived' and ${inRange("entered_at", q)}
    `);

    const reworkOverTime = await this.rows(sql`
      with completed as (${completed}), rework as (${reworkCte(q)})
      select date_trunc('day', c.done_at) as t,
             round(avg(coalesce(r.changes_requested, 0))::numeric, 2) as "Changes requested / task",
             round(100.0 * count(*) filter (where coalesce(r.changes_requested, 0) = 0)
                   / nullif(count(*), 0), 1) as "First-pass yield %"
      from completed c left join rework r on r.item_id = c.item_id
      where ${inRange("c.done_at", q)}
      group by 1 order by 1
    `);

    const retryBurn = await this.rows(sql`
      select o.slug as "Org", i.organization_id as "Org ID",
             count(*) filter (where i.retry_attempts > 0) as "Tasks retried",
             sum(i.retry_attempts) as "Total retries",
             max(i.retry_attempts) as "Worst task"
      from task_board_items i
      join organization o on o.id = i.organization_id
      where ${inRange("i.created_at::timestamptz", q)} and ${scoped(q)}
      group by 1, 2
      having sum(i.retry_attempts) > 0
      order by 4 desc limit 50
    `);

    return [
      {
        kind: "stat",
        title: "Quality",
        values: [
          {
            label: "First-pass yield",
            value: num(yieldRow?.clean_first_pass),
            unit: "%",
          },
          {
            label: "Changes requested / task",
            value: num(yieldRow?.changes_per_task),
          },
          {
            label: "Autonomy (finished without a human)",
            value: num(autonomy?.pct),
            unit: "%",
          },
          {
            label: "Archived with no PR",
            value: num(abandonment?.pct),
            unit: "%",
          },
        ],
      },
      {
        kind: "series",
        title: "First-pass yield over time",
        unit: "%",
        points: reworkOverTime.map((r) => ({
          t: iso(r.t),
          "First-pass yield": num(r["First-pass yield %"]),
        })),
      },
      {
        kind: "series",
        title: "Changes requested per task over time",
        points: reworkOverTime.map((r) => ({
          t: iso(r.t),
          "Changes requested / task": num(r["Changes requested / task"]),
        })),
      },
      table(
        "Retry burn",
        ["Org", "Org ID", "Tasks retried", "Total retries", "Worst task"],
        retryBurn,
      ),
    ];
  }

  /**
   * Panels 10–16: what actually broke. `superseded`, `ended_after_delivery`,
   * `cancelled` and `abandoned` are not errors; `credits` is a quota wall with
   * its own number; a NULL `failure_kind` on a failed thread IS an error.
   */
  async errors(q: AnalyticsQuery): Promise<Section[]> {
    const [counts] = await this.rows(sql`
      select count(*) filter (
               where coalesce(t.failure_kind, 'error') not in
                     ('superseded','ended_after_delivery','cancelled','abandoned','credits')
             ) as failed,
             count(*) filter (where t.failure_kind = 'credits') as quota_blocked
      from task_board_item_threads l
      join threads t on t.id = l.thread_id
      join task_board_items i on i.id = l.task_board_item_id
      where t.status = 'failed' and ${inRange("l.created_at", q)}
        and ${scoped(q)}
    `);

    const perDay = await this.rows(sql`
      select date_trunc('day', l.created_at) as t,
             count(*) filter (where coalesce(t.failure_kind, 'error') not in ('superseded','ended_after_delivery','cancelled','abandoned','credits')) as "Errors",
             count(*) filter (where t.failure_kind = 'credits') as "Out of credits",
             count(*) filter (where t.failure_kind = 'superseded') as "Superseded"
      from task_board_item_threads l
      join threads t on t.id = l.thread_id
      join task_board_items i on i.id = l.task_board_item_id
      where t.status = 'failed' and ${inRange("l.created_at", q)}
        and ${scoped(q)}
      group by 1 order by 1
    `);

    const kinds = await this.rows(sql`
      select coalesce(t.failure_kind, '(uncategorized)') as "Failure kind",
             count(*) as "Runs",
             count(distinct l.task_board_item_id) as "Tasks",
             count(distinct i.organization_id) as "Orgs"
      from task_board_item_threads l
      join threads t on t.id = l.thread_id
      join task_board_items i on i.id = l.task_board_item_id
      where t.status = 'failed' and ${inRange("l.created_at", q)}
        and ${scoped(q)}
      group by 1 order by 2 desc
    `);

    const feed = await this.rows(sql`
      select p.persisted_at as "When",
             o.slug as "Org",
             left(i.title, 70) as "Task",
             i.status as "Lane",
             coalesce(t.failure_kind, '(uncategorized)') as "Run outcome",
             left(p.payload->>'text', 500) as "Error",
             l.task_board_item_id as "Task ID",
             p.thread_id as "Thread"
      from thread_message_parts p
      join task_board_item_threads l on l.thread_id = p.thread_id
      join task_board_items i on i.id = l.task_board_item_id
      join organization o     on o.id = i.organization_id
      left join threads t     on t.id = p.thread_id
      where p.kind = 'error' and ${inRange("p.persisted_at", q)}
        and ${scoped(q)}
      order by p.persisted_at desc
      limit 300
    `);

    const signatures = await this.rows(sql`
      select regexp_replace(regexp_replace(left(p.payload->>'text', 160), '[0-9]+', 'N', 'g'),
                            '\\s+', ' ', 'g') as "Signature",
             count(*) as "Hits",
             count(distinct i.organization_id) as "Orgs",
             count(distinct l.task_board_item_id) as "Tasks",
             max(p.persisted_at) as "Last seen"
      from thread_message_parts p
      join task_board_item_threads l on l.thread_id = p.thread_id
      join task_board_items i on i.id = l.task_board_item_id
      join organization o     on o.id = i.organization_id
      left join threads t     on t.id = p.thread_id
      where p.kind = 'error' and ${inRange("p.persisted_at", q)}
        and ${scoped(q)}
      group by 1 order by 2 desc limit 40
    `);

    const superseded = await this.rows(sql`
      select t.updated_at::timestamptz as "Superseded at",
             l.created_at as "Run started",
             round(extract(epoch from (t.updated_at::timestamptz - l.created_at))::numeric, 0) as "Ran for",
             o.slug as "Org",
             left(i.title, 55) as "Task",
             case when e.n > 0 then 'errored, then replaced' else 'replaced cleanly' end as "What happened",
             e.last_error_at as "Last error at",
             coalesce(e.n, 0) as "Error parts",
             left(e.sample, 220) as "Last error",
             t.id as "Thread"
      from threads t
      join task_board_item_threads l on l.thread_id = t.id
      join task_board_items i on i.id = l.task_board_item_id
      join organization o     on o.id = i.organization_id
      left join lateral (
        select count(*) as n,
               max(pe.payload->>'text') as sample,
               max(pe.persisted_at) as last_error_at
        from thread_message_parts pe
        where pe.thread_id = t.id and pe.kind = 'error'
      ) e on true
      where t.failure_kind = 'superseded' and ${inRange("l.created_at", q)}
        and ${scoped(q)}
      order by t.updated_at::timestamptz desc limit 150
    `);

    return [
      {
        kind: "stat",
        title: "Errors",
        values: [
          { label: "Failed runs", value: num(counts?.failed) },
          { label: "Quota-blocked runs", value: num(counts?.quota_blocked) },
        ],
      },
      {
        kind: "series",
        title: "Failed runs per day",
        points: perDay.map((r) => ({
          t: iso(r.t),
          Errors: num(r.Errors),
          "Out of credits": num(r["Out of credits"]),
          Superseded: num(r.Superseded),
        })),
      },
      table("Failure kinds", ["Failure kind", "Runs", "Tasks", "Orgs"], kinds),
      table(
        "Live error feed",
        [
          "When",
          "Org",
          "Task",
          "Lane",
          "Run outcome",
          "Error",
          "Task ID",
          "Thread",
        ],
        feed,
      ),
      table(
        "Error signatures",
        ["Signature", "Hits", "Orgs", "Tasks", "Last seen"],
        signatures,
      ),
      table(
        "Superseded runs",
        [
          "Superseded at",
          "Run started",
          "Ran for",
          "Org",
          "Task",
          "What happened",
          "Last error at",
          "Error parts",
          "Last error",
          "Thread",
        ],
        superseded,
        { "Ran for": "s" },
      ),
    ];
  }

  /** Panels 9 + 33: per-tenant scorecard and queue wait. */
  async tenants(q: AnalyticsQuery): Promise<Section[]> {
    const moves = movesCte(q);

    const scorecard = await this.rows(sql`
      with moves as (${moves}),
      shipped as (${firstShippedCte}),
      completed as (
        select org_id, org_slug, item_id, entered_at as done_at
        from shipped where ${inRange("entered_at", q)}
      ),
      review as (
        select org_id,
               percentile_cont(0.5) within group (order by hours) as p50,
               percentile_cont(0.9) within group (order by hours) as p90
        from (select org_id, extract(epoch from (left_at - entered_at)) as hours from moves
              where lane = 'in_review' and left_at is not null and ${inRange("entered_at", q)}) r
        group by 1
      ),
      errs as (
        select i.organization_id as org_id, count(*) as n
        from task_board_item_threads l
        join threads t on t.id = l.thread_id
        join task_board_items i on i.id = l.task_board_item_id
        where t.status = 'failed'
          and coalesce(t.failure_kind, 'error') not in ('superseded','ended_after_delivery','cancelled','abandoned','credits')
          and ${inRange("l.created_at", q)} and ${scoped(q)}
        group by 1
      ),
      cost as (
        select i.organization_id as org_id,
               sum(coalesce((p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric, 0)) as usd,
               count(distinct l.thread_id) as threads
        from task_board_item_threads l
        join thread_message_parts p on p.thread_id = l.thread_id and p.kind = 'finish'
        join task_board_items i on i.id = l.task_board_item_id
        where ${inRange("l.created_at", q)} and ${scoped(q)}
        group by 1
      )
      select c.org_slug as "Org",
             c.org_id   as "Org ID",
             count(*)   as "Completed",
             count(*) filter (where exists (select 1 from task_board_item_prs p where p.task_board_item_id = c.item_id)) as "With PR",
             round(100.0 * count(*) filter (where exists (select 1 from task_board_item_prs p where p.task_board_item_id = c.item_id))
                   / nullif(count(*), 0), 0) as "PR %",
             round(max(r.p50)::numeric, 0) as "Review p50",
             round(max(r.p90)::numeric, 0) as "Review p90",
             round(max(co.usd) / nullif(max(co.threads), 0), 4) as "$ / thread",
             coalesce(max(e.n), 0) as "Errors"
      from completed c
      left join review r on r.org_id = c.org_id
      left join errs   e on e.org_id = c.org_id
      left join cost   co on co.org_id = c.org_id
      group by 1, 2 order by 3 desc limit 50
    `);

    const queueWait = await this.rows(sql`
      with moves as (${moves})
      select org_slug as "Org", org_id as "Org ID",
             count(*) as "Queued",
             round((percentile_cont(0.5) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p50",
             round((percentile_cont(0.9) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p90"
      from moves
      where lane = 'todo' and left_at is not null and ${inRange("entered_at", q)}
      group by 1, 2 order by 5 desc nulls last limit 50
    `);

    return [
      table(
        "Org scorecard",
        [
          "Org",
          "Org ID",
          "Completed",
          "With PR",
          "PR %",
          "Review p50",
          "Review p90",
          "$ / thread",
          "Errors",
        ],
        scorecard,
        {
          "PR %": "%",
          "Review p50": "s",
          "Review p90": "s",
          "$ / thread": "USD",
        },
      ),
      table(
        "Queue wait by tenant",
        ["Org", "Org ID", "Queued", "p50", "p90"],
        queueWait,
        { p50: "s", p90: "s" },
      ),
    ];
  }

  /**
   * The operation, end to end: of the cards the agent picked up, how many ran
   * clean, passed QA (and the customer) first try, shipped, and shipped on its own.
   *
   * The cohort is cards whose FIRST run started in range, so a card counts once
   * and its whole journey is judged; human steps count only after that first run.
   */
  async operation(q: AnalyticsQuery): Promise<Section[]> {
    return this.withFacts(q, (x) => this.operationOf(x, q));
  }

  private async operationOf(x: Facts, q: AnalyticsQuery): Promise<Section[]> {
    const span = Date.parse(q.to) - Date.parse(q.from);
    // Exclusive of `from`, which the current window already counts.
    const previous = {
      ...q,
      from: new Date(Date.parse(q.from) - span).toISOString(),
      to: new Date(Date.parse(q.from) - 1).toISOString(),
    };
    // Its cards get as long to ship as this window's had.
    const previousAsOf = new Date(
      Date.parse(q.from) + Math.max(0, Date.now() - Date.parse(q.to)),
    ).toISOString();
    const bucket = span <= 14 * 86_400_000 ? "day" : "week";

    const summary = async (facts: Facts["f"]) => {
      const [row] = await x.rows(sql`
        with f as (${facts})
        select ${sql.join(
          Object.entries(OPERATION_COHORTS).map(
            ([key, filter]) =>
              sql`count(*) filter (where ${sql.raw(filter)}) as ${sql.ref(key)}`,
          ),
        )},
               round(100.0 * ${cohortCount("shipped_untouched")}
                     / nullif(${cohortCount("shipped")}, 0), 1) as untouched_pct,
               round(100.0 * ${cohortCount("failed_qa")}
                     / nullif(${cohortCount("reached_qa")}, 0), 1) as failed_qa_pct
        from f
      `);
      return row ?? {};
    };
    const [now, before] = await Promise.all([
      summary(x.f),
      summary(operationFacts(previous, "ran", previousAsOf)),
    ]);

    const trend = await x.rows(sql`
      with f as (${x.f})
      select date_trunc(${bucket}, first_run_at) as t,
             round(100.0 * ${cohortCount("shipped_untouched")}
                   / nullif(${cohortCount("shipped")}, 0), 1) as "Shipped on its own %",
             round(100.0 * ${cohortCount("failed_qa")}
                   / nullif(${cohortCount("reached_qa")}, 0), 1) as "Failed QA %"
      from f group by 1 order by 1
    `);

    const touches = await x.rows(sql`
      with f as (${x.f}),
      t as (${humanTouches()})
      select class, count(distinct item_id) as tasks, count(*) as actions,
             string_agg(distinct kind, ', ') as kinds
      from t group by 1
    `);
    const byClass = TOUCH_CLASSES.flatMap((c) => {
      const r = touches.find((row) => row.class === c.key);
      return r ? [{ ...c, row: r }] : [];
    });

    const needed = await x.rows(sql`
      with f as (${x.f}),
      t as (${humanTouches()})
      select left(f.title, 80) as "Task",
             f.status as "Lane",
             count(*) as "Actions",
             string_agg(distinct t.kind, ', ') as "What people did",
             max(t.at) as "Last touch",
             f.item_id as "Task ID"
      from t join f on f.item_id = t.item_id
      group by f.item_id, f.title, f.status
      order by 3 desc, 5 desc
      limit 50
    `);

    const count = (key: string) => num(now[key]) ?? 0;
    const stat = (
      label: string,
      key: string,
      drill: OperationCohort,
      better: "up" | "down",
      detail: string,
      unit?: string,
    ) => ({
      label,
      value: num(now[key]),
      previous: num(before[key]),
      better,
      detail,
      drill,
      ...(unit ? { unit } : {}),
    });
    const stage = (label: string, drill: OperationCohort) => ({
      label,
      value: count(drill),
      drill,
    });

    return [
      {
        kind: "stat",
        title: "Operation",
        values: [
          // Outcomes first, then what it took to get there.
          stat(
            "Shipped",
            "shipped",
            "shipped",
            "up",
            `of ${count("ran")} picked up`,
          ),
          stat(
            "Shipped on its own",
            "untouched_pct",
            "shipped_untouched",
            "up",
            `${count("shipped_untouched")} of ${count("shipped")} shipped`,
            "%",
          ),
          stat(
            "Failed QA",
            "failed_qa_pct",
            "failed_qa",
            "down",
            `${count("failed_qa")} of ${count("reached_qa")} that reached QA`,
            "%",
          ),
          stat(
            "Sent back by a person",
            "returned",
            "returned",
            "down",
            `of ${count("ran")} picked up`,
          ),
        ],
      },
      {
        kind: "funnel",
        title: "From first run to production",
        stages: [
          stage("Picked up by the agent", "ran"),
          stage("Reached QA", "reached_qa"),
          stage("Passed QA first try", "first_pass"),
          stage("No failed runs", "clean"),
          // Only on boards that route work through the customer.
          ...(count("reached_customer") > 0
            ? [stage("Not sent back by the customer", "customer_first_pass")]
            : []),
          stage("Shipped", "shipped_first_pass"),
          stage("Not sent back by a person", "zero_touch"),
        ],
      },
      {
        kind: "bars",
        title: "Where people stepped in",
        unit: "tasks",
        total: {
          value: touches.reduce((sum, r) => sum + (num(r.actions) ?? 0), 0),
          label: "actions by people after the agent started",
        },
        // By intent: only "Sent back" counts against autonomy.
        bars: byClass.map(({ key, label, row }) => ({
          label,
          value: num(row.tasks) ?? 0,
          note: String(row.kinds),
          detail:
            num(row.actions) === 1
              ? "1 action"
              : `${num(row.actions) ?? 0} actions`,
          drill: `class:${key}`,
        })),
      },
      {
        kind: "series",
        title: "Autonomy over time",
        unit: "%",
        points: trend.map((r) => ({
          t: iso(r.t),
          "Shipped on its own %": num(r["Shipped on its own %"]),
          "Failed QA %": num(r["Failed QA %"]),
        })),
      },
      table(
        "Tasks that needed a person",
        ["Task", "Lane", "Actions", "What people did", "Last touch", "Task ID"],
        needed,
      ),
    ];
  }

  /**
   * Why tasks come back: of the cards first run in range, which failed QA or
   * needed a person, cut by what the card was (type, priority, tag, sprint,
   * who wrote it) — the indicators of where rework concentrates.
   */
  async rework(q: AnalyticsQuery): Promise<Section[]> {
    return this.withFacts(q, (x) => this.reworkOf(x));
  }

  private async reworkOf(x: Facts): Promise<Section[]> {
    const [summary] = await x.rows(sql`
      with f as (${x.f}),
      t as (${humanTouches()})
      select count(*) as ran,
             ${cohortCount("reached_qa")} as reached_qa,
             ${cohortCount("failed_qa")} as failed_qa,
             ${cohortCount("failed_qa_repeat")} as failed_qa_repeat,
             ${cohortCount("returned")} as returned,
             ${cohortCount("shipped")} as shipped,
             ${cohortCount("shipped_round_1")} as shipped_round_1,
             ${cohortCount("shipped_round_2")} as shipped_round_2,
             ${cohortCount("shipped_round_3")} as shipped_round_3,
             ${cohortCount("reached_customer")} as reached_customer,
             ${cohortCount("customer_returned")} as customer_returned,
             round(100.0 * ${cohortCount("failed_qa")}
                   / nullif(${cohortCount("reached_qa")}, 0), 1) as failed_qa_pct,
             round(100.0 * ${cohortCount("returned")} / nullif(count(*), 0), 1) as returned_pct,
             round(100.0 * ${cohortCount("customer_returned")}
                   / nullif(${cohortCount("reached_customer")}, 0), 1) as escaped_pct
      from f
    `);
    const count = (key: string) => num(summary?.[key]) ?? 0;
    const spend = await this.reworkSpend(x);

    const sources = await x.rows(sql`
      with f as (${x.f}),
      rt as (${returnsOf()})
      select source, count(distinct item_id) as tasks, count(*) as times
      from rt group by 1
    `);

    const cuts = await Promise.all(
      REWORK_CUTS.map(async (cut) => ({
        label: cut.label,
        rows: (
          await x.rows(sql`
            with f as (${x.f})
            select ${cut.name} as name, ${cut.drill} as drill, ${REWORK_RATES}
            from f ${cut.join}
            group by 1, 2
            order by ${cut.order}
            limit 12
          `)
        ).map((r) => ({
          label: String(r.name),
          count: num(r.n) ?? 0,
          drill: String(r.drill),
          values: rates(r),
        })),
      })),
    );

    const cells = await x.rows(sql`
      with f as (${x.f})
      select coalesce(o.name, 'No tag') as row, coalesce(o.id, 'none') as row_id,
             initcap(f.type) as col, f.type as col_id, ${REWORK_RATES}
      from f
      left join task_board_item_tags g on g.task_board_item_id = f.item_id
      left join organization_tags o on o.id = g.id
      group by 1, 2, 3, 4
    `);
    const total = (key: "row" | "col") => {
      const sums = new Map<string, number>();
      for (const c of cells) {
        const k = String(c[key]);
        sums.set(k, (sums.get(k) ?? 0) + (num(c.n) ?? 0));
      }
      return [...sums].sort((a, b) => b[1] - a[1]).map(([k]) => k);
    };
    const matrixRows = total("row").slice(0, 8);

    // Tags crossed with tags: where size is tagged, "UI and Large" is a cell.
    const pairs = await x.rows(sql`
      with f as (${x.f}),
      ft as (
        select f.*, o.id as tag_id, o.name as tag
        from f
        join task_board_item_tags g on g.task_board_item_id = f.item_id
        join organization_tags o on o.id = g.id
      )
      select a.tag as row, a.tag_id as row_id, b.tag as col, b.tag_id as col_id,
             ${REWORK_RATES}
      from ft a
      join (select item_id, tag_id, tag from ft) b on b.item_id = a.item_id
      group by 1, 2, 3, 4
    `);
    const tagOrder = [
      ...new Map(
        pairs
          .filter((p) => p.row_id === p.col_id)
          .sort((a, b) => (num(b.n) ?? 0) - (num(a.n) ?? 0))
          .map((p) => [String(p.row), p] as const),
      ).keys(),
    ].slice(0, 8);

    return [
      {
        kind: "stat",
        title: "Rework",
        values: [
          {
            label: "Failed QA",
            value: num(summary?.failed_qa_pct),
            unit: "%",
            detail: `${count("failed_qa")} of ${count("reached_qa")} that reached QA`,
            drill: "failed_qa",
          },
          {
            label: "Failed QA twice or more",
            value: count("failed_qa_repeat"),
            detail: `of ${count("failed_qa")} that failed QA`,
            drill: "failed_qa_repeat",
          },
          {
            label: "Sent back by a person",
            value: num(summary?.returned_pct),
            unit: "%",
            detail: `${count("returned")} of ${count("ran")} picked up`,
            drill: "returned",
          },
          {
            label: "Spent on rework",
            value: spend.rework,
            unit: "USD",
            detail: spend.total
              ? `${Math.round((100 * (spend.rework ?? 0)) / spend.total)}% of $${spend.total.toFixed(2)} on these tasks`
              : "runs after a task was sent back",
            drill: "sent_back",
          },
          // QA escape: what the QA Agent passed and the customer still sent back.
          ...(count("reached_customer") > 0
            ? [
                {
                  label: "Escaped QA",
                  value: num(summary?.escaped_pct),
                  unit: "%",
                  detail: `customer sent back ${count("customer_returned")} of ${count("reached_customer")} it saw`,
                  drill: "customer_returned",
                },
              ]
            : []),
        ],
      },
      {
        kind: "bars",
        title: "Rounds to ship",
        unit: "tasks",
        total: { value: count("shipped"), label: "shipped" },
        bars: (
          [
            ["First try", "shipped_round_1"],
            ["2 rounds", "shipped_round_2"],
            ["3 or more", "shipped_round_3"],
          ] as const
        ).map(([label, drill]) => ({
          label,
          value: count(drill),
          detail: count("shipped")
            ? `${Math.round((100 * count(drill)) / count("shipped"))}%`
            : "",
          drill,
        })),
      },
      {
        kind: "bars",
        title: "Who sent it back",
        unit: "tasks",
        total: {
          value: sources.reduce((sum, r) => sum + (num(r.times) ?? 0), 0),
          label: "send-backs after the agent started",
        },
        bars: RETURN_SOURCES.flatMap((source) => {
          const r = sources.find((row) => row.source === source);
          return r
            ? [
                {
                  label: source,
                  value: num(r.tasks) ?? 0,
                  detail:
                    num(r.times) === 1
                      ? "1 time"
                      : `${num(r.times) ?? 0} times`,
                  drill: `source:${source}`,
                },
              ]
            : [];
        }),
      },
      {
        kind: "breakdown",
        title: "Where tasks come back",
        metrics: REWORK_METRICS,
        dimensions: cuts.filter((c) => c.rows.length > 0),
      },
      {
        kind: "matrix",
        title: "Tag by type",
        rowLabel: "Tag",
        colLabel: "Type",
        metrics: REWORK_METRICS,
        rows: matrixRows,
        cols: total("col"),
        cells: cells
          .filter((c) => matrixRows.includes(String(c.row)))
          .map((c) => ({
            row: String(c.row),
            col: String(c.col),
            count: num(c.n) ?? 0,
            drill: `tag:${String(c.row_id)}&type:${String(c.col_id)}`,
            values: rates(c),
          })),
      },
      {
        kind: "matrix",
        title: "Tags together",
        rowLabel: "Tag",
        colLabel: "Tag",
        metrics: REWORK_METRICS,
        rows: tagOrder,
        cols: tagOrder,
        cells: pairs
          .filter(
            (p) =>
              tagOrder.includes(String(p.row)) &&
              tagOrder.includes(String(p.col)),
          )
          .map((p) => ({
            row: String(p.row),
            col: String(p.col),
            count: num(p.n) ?? 0,
            drill:
              p.row_id === p.col_id
                ? `tag:${String(p.row_id)}`
                : `tag:${String(p.row_id)}&tag:${String(p.col_id)}`,
            values: rates(p),
          })),
      },
    ];
  }

  /**
   * The newest sprints that overlap the range: what each committed to (every
   * card planned into it, run or not), what shipped, and how much of that
   * needed nobody.
   */
  async sprints(q: AnalyticsQuery): Promise<Section[]> {
    const rows = await this.rows(sql`
      with f as (${operationFacts(q, "sprints")})
      select s.id, s.name, s.state,
             s.start_date::text as start_date, s.end_date::text as end_date,
             count(*) as committed,
             count(*) filter (where f.shipped) as completed,
             count(*) filter (where f.shipped and not f.returned and f.first_run_at is not null) as untouched,
             count(*) filter (where not f.shipped and f.status <> 'archived') as open,
             round(100.0 * count(*) filter (where f.shipped) / nullif(count(*), 0), 0) as completion,
             round(100.0 * count(*) filter (where f.shipped and not f.returned and f.first_run_at is not null)
                   / nullif(count(*) filter (where f.shipped), 0), 0) as untouched_pct,
             round(100.0 * count(*) filter (where f.failed_qa)
                   / nullif(count(*) filter (where f.reached_qa), 0), 0) as failed_qa_pct
      from f
      join task_board_sprints s on s.id = f.sprint_id
      where s.state = 'active'
         or (coalesce(s.start_date, '9999-12-31') <= ${new Date(q.to).toISOString().slice(0, 10)}
             and coalesce(s.end_date, s.start_date, '0001-01-01') >= ${new Date(q.from).toISOString().slice(0, 10)})
      group by 1, 2, 3, 4, 5
      order by 4 desc nulls first, 2
      limit 26
    `);
    const active = rows.find((r) => r.state === "active");
    const drill = (r: Row, extra = "") =>
      `planned&sprint:${String(r.id)}${extra}`;
    const daysLeft = active?.end_date
      ? Math.max(
          0,
          Math.ceil(
            (Date.parse(`${String(active.end_date)}T23:59:59Z`) - Date.now()) /
              86_400_000,
          ),
        )
      : null;

    return [
      ...(active
        ? [
            {
              kind: "stat" as const,
              title: `Active sprint: ${String(active.name)}`,
              values: [
                {
                  label: `Completed in ${String(active.name)}`,
                  value: num(active.completed),
                  detail: `of ${num(active.committed) ?? 0} committed`,
                  drill: drill(active, "&shipped"),
                },
                {
                  label: "Still open",
                  value: num(active.open),
                  detail: "committed, not shipped yet",
                  drill: drill(active, "&still_open"),
                },
                {
                  label: "Shipped on its own",
                  value: num(active.untouched_pct),
                  unit: "%",
                  detail: `${num(active.untouched) ?? 0} of ${num(active.completed) ?? 0} completed`,
                  drill: drill(active, "&shipped_untouched"),
                },
                {
                  label: "Days left",
                  value: daysLeft,
                  ...(active.end_date
                    ? {
                        detail: `ends ${new Date(`${String(active.end_date)}T12:00:00Z`).toLocaleDateString("en", { month: "short", day: "numeric", timeZone: "UTC" })}`,
                      }
                    : {}),
                },
              ],
            },
          ]
        : []),
      {
        kind: "categories",
        title: "Velocity",
        layout: "grouped",
        keys: ["Committed", "Completed", "Completed on its own"],
        baseline: "Committed",
        // Newest first from the query; a velocity chart reads left to right.
        categories: [...rows].reverse().map((r) => ({
          label: String(r.name),
          drill: drill(r),
          values: {
            Committed: num(r.committed),
            Completed: num(r.completed),
            "Completed on its own": num(r.untouched),
          },
        })),
      },
      {
        ...table(
          "Sprints",
          [
            "Sprint",
            "State",
            "Starts",
            "Ends",
            "Committed",
            "Completed",
            "Completion",
            "Shipped on its own",
            "Failed QA",
          ],
          rows.map((r) => ({
            Sprint: r.name,
            State: r.state,
            Starts: r.start_date,
            Ends: r.end_date,
            Committed: r.committed,
            Completed: r.completed,
            Completion: r.completion,
            "Shipped on its own": r.untouched_pct,
            "Failed QA": r.failed_qa_pct,
          })),
          {
            Completion: "%",
            "Shipped on its own": "%",
            "Failed QA": "%",
          },
        ),
        drills: rows.map((r) => drill(r)),
      },
    ];
  }

  /** USD spent on runs of the cards first run in range, and how much of it came after a send-back. */
  private async reworkSpend(
    x: Facts,
  ): Promise<{ rework: number | null; total: number | null }> {
    const [row] = await x.rows(sql`
      with f as (${x.f}),
      rt as (${returnsOf()}),
      fr as (select item_id, min(at) as first_return from rt group by 1)
      select round(coalesce(sum(${RUN_COST}) filter (where l.created_at > fr.first_return), 0), 2) as rework,
             round(sum(${RUN_COST}), 2) as total
      from f
      join task_board_item_threads l on l.task_board_item_id = f.item_id
      join thread_message_parts p on p.thread_id = l.thread_id and p.kind = 'finish'
      left join fr on fr.item_id = f.item_id
    `);
    return { rework: num(row?.rework), total: num(row?.total) };
  }

  /** The cards behind one figure, newest first run first. */
  async operationTasks(
    q: AnalyticsQuery,
    drill: DrillPart[],
  ): Promise<Section[]> {
    const cohort = drill.some((p) => "scope" in p) ? "sprints" : "ran";
    const rows = await this.rows(sql`
      with f as (${operationFacts(q, cohort)}),
      t as (${humanTouches()})
      select left(f.title, 80) as "Task",
             f.status as "Lane",
             f.first_run_at as "Picked up",
             (select count(*) from t where t.item_id = f.item_id) as "Actions by people",
             f.qa_failures as "Failed QA",
             f.item_id as "Task ID"
      from f
      where ${sql.join([sql`true`, ...drill.map(drillWhere)], sql` and `)}
      order by f.first_run_at desc nulls last
      limit 200
    `);
    return [
      table(
        "Tasks",
        [
          "Task",
          "Lane",
          "Picked up",
          "Actions by people",
          "Failed QA",
          "Task ID",
        ],
        rows,
      ),
    ];
  }

  /** Resolve an org reference (slug or id) as typed into the `org` parameter. */
  async resolveOrgRef(
    ref: string,
  ): Promise<{ id: string; slug: string } | null> {
    const rows = await this.rows(sql`
      select id, slug from organization where id = ${ref} or slug = ${ref} limit 1
    `);
    const row = rows[0];
    return row ? { id: String(row.id), slug: String(row.slug) } : null;
  }

  /** Orgs that have any task board item — the dashboard's `org` variable query. */
  async orgsWithBoardItems(): Promise<
    { id: string; slug: string; name: string }[]
  > {
    const rows = await this.rows(sql`
      select o.id, o.slug, o.name
      from organization o
      where exists (select 1 from task_board_items i where i.organization_id = o.id)
      order by o.slug asc
    `);
    return rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug),
      name: String(r.name ?? r.slug),
    }));
  }
}
