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

import { sql, type Kysely } from "kysely";
import type { Database } from "./types";

export interface StatSection {
  kind: "stat";
  title: string;
  values: { label: string; value: number | null; unit?: string }[];
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
}

export type Section = StatSection | SeriesSection | TableSection;

export interface AnalyticsQuery {
  /** Org ids to scope to, or `null` for the cross-tenant aggregate. */
  orgIds: string[] | null;
  from: string;
  to: string;
}

/** Grafana's `${org:sqlstring}`. `null` is the "All" selection. */
const orgIn = (orgIds: string[] | null, col: string) =>
  orgIds === null ? sql`true` : sql`${sql.raw(col)} = any(${orgIds}::text[])`;

/** Grafana's `$__timeFilter(col)`. */
const inRange = (col: string, q: AnalyticsQuery) =>
  sql`${sql.raw(col)} between ${q.from}::timestamptz and ${q.to}::timestamptz`;

/**
 * One lane visit per row: when a card entered a lane, when it left, and who
 * moved it. Copy-pasted into ~8 dashboard panels; extracted once here, logic
 * untouched.
 */
const movesCte = (orgIds: string[] | null) => sql`
  select i.organization_id            as org_id,
         o.slug                       as org_slug,
         i.id                         as item_id,
         case
           when exists (select 1 from task_board_item_jira_links j where j.item_id = i.id)
             then case when i.source = 'jira' then 'jira-anchor' else 'jira' end
           else 'studio'
         end                          as board,
         i.type                       as task_type,
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
  where a.action = 'status_changed' and ${orgIn(orgIds, "i.organization_id")}
  window w as (partition by a.task_board_item_id order by a.occurred_at, a.id)
`;

/** USD per card, from the OpenRouter price recorded on `finish` parts. */
const taskCostCte = (orgIds: string[] | null) => sql`
  select l.task_board_item_id as item_id,
         i.organization_id    as org_id,
         o.slug               as org_slug,
         sum(coalesce((p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric, 0)) as usd,
         min(l.created_at)    as first_run_at
  from task_board_item_threads l
  join thread_message_parts p on p.thread_id = l.thread_id and p.kind = 'finish'
  join task_board_items i     on i.id = l.task_board_item_id
  join organization o         on o.id = i.organization_id
  where ${orgIn(orgIds, "i.organization_id")}
  group by 1, 2, 3
`;

/** Cards that reached done/merged AND actually went through review. */
const reviewedCompletedCte = (orgIds: string[] | null) => sql`
  select i.organization_id as org_id, o.slug as org_slug, a.task_board_item_id as item_id,
         min(a.occurred_at) as done_at
  from task_board_activity a
  join task_board_items i on i.id = a.task_board_item_id
  join organization o     on o.id = i.organization_id
  where a.action = 'status_changed' and a.data->>'to' in ('done','merged')
    and ${orgIn(orgIds, "i.organization_id")}
    and exists (select 1 from task_board_activity a2
                where a2.task_board_item_id = a.task_board_item_id
                  and a2.action = 'status_changed' and a2.data->>'to' = 'in_review')
  group by 1, 2, 3
`;

const reworkCte = sql`
  select a.task_board_item_id as item_id, count(*) as changes_requested
  from task_board_activity a
  where a.action = 'review_changes_requested'
  group by 1
`;

/** pg hands back numeric and bigint as strings. */
const num = (v: unknown): number | null =>
  v === null || v === undefined ? null : Number(v);

const iso = (v: unknown): string =>
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

type Row = Record<string, unknown>;

const table = (
  title: string,
  columns: string[],
  rows: Row[],
): TableSection => ({
  kind: "table",
  title,
  columns,
  rows: rows.map((r) => columns.map((c) => cell(r[c]))),
});

export class TaskBoardAnalyticsStorage {
  constructor(private readonly db: Kysely<Database>) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    const result = await query.execute(this.db);
    return result.rows as Row[];
  }

  /** Panels 1–7: did the work ship, and where did the time go? */
  async delivery(q: AnalyticsQuery): Promise<Section[]> {
    const moves = movesCte(q.orgIds);

    const [headline] = await this.rows(sql`
      with moves as (${moves})
      select count(distinct item_id) as completed,
             count(distinct item_id) filter (
               where exists (select 1 from task_board_item_prs p where p.task_board_item_id = m.item_id)
             ) as with_pr,
             round(100.0 * count(distinct item_id) filter (
               where exists (select 1 from task_board_item_prs p where p.task_board_item_id = m.item_id)
             ) / nullif(count(distinct item_id), 0), 1) as pr_rate
      from moves m where lane in ('done','merged') and ${inRange("entered_at", q)}
    `);

    const [times] = await this.rows(sql`
      with fd as (
        select a.task_board_item_id as item_id, min(a.occurred_at) as done_at
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ('done','merged')
          and ${orgIn(q.orgIds, "i.organization_id")}
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
      with moves as (${moves})
      select date_trunc('day', entered_at) as t,
             count(distinct item_id) filter (where board = 'studio')      as "Kanban",
             count(distinct item_id) filter (where board = 'jira')        as "Jira",
             count(distinct item_id) filter (where board = 'jira-anchor') as "Jira (trigger anchor)"
      from moves where lane in ('done','merged') and ${inRange("entered_at", q)}
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
      table("Dwell by lane", ["Lane", "Visits", "p50", "p90", "Max"], dwell),
    ];
  }

  /**
   * Panels 8 + 34: what is stuck, right now. Deliberately NOT time-filtered — a
   * card stuck since before the range is exactly what you want to see.
   */
  async stuck(q: AnalyticsQuery): Promise<Section[]> {
    const moves = movesCte(q.orgIds);

    const stuckNow = await this.rows(sql`
      with moves as (${moves})
      select org_slug as "Org", lane as "Lane", item_id as "Task",
             round(extract(epoch from (now() - entered_at))::numeric, 0) as "Age",
             case when actor_id is null then 'agent/system' else 'human' end as "Moved in by"
      from moves
      where left_at is null and lane not in ('done','merged','archived')
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
      from moves where left_at is null and lane not in ('done','merged','archived')
      group by 1 order by 2 desc
    `);

    return [
      table(
        "Stuck right now",
        ["Org", "Lane", "Task", "Age", "Moved in by"],
        stuckNow,
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
    const taskCost = taskCostCte(q.orgIds);

    const [total] = await this.rows(sql`
      with task_cost as (${taskCost})
      select round(sum(usd), 2) as usd from task_cost where ${inRange("first_run_at", q)}
    `);

    const [perTask] = await this.rows(sql`
      with task_cost as (${taskCost}),
      completed as (
        select distinct a.task_board_item_id as item_id
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ('done','merged')
          and ${inRange("a.occurred_at", q)} and ${orgIn(q.orgIds, "i.organization_id")}
      )
      select round(sum(c.usd) / nullif(count(*), 0), 2) as usd
      from completed d join task_cost c on c.item_id = d.item_id
    `);

    const [perPr] = await this.rows(sql`
      with task_cost as (${taskCost}),
      completed as (
        select distinct a.task_board_item_id as item_id
        from task_board_activity a
        join task_board_items i on i.id = a.task_board_item_id
        where a.action = 'status_changed' and a.data->>'to' in ('done','merged')
          and ${inRange("a.occurred_at", q)} and ${orgIn(q.orgIds, "i.organization_id")}
          and exists (select 1 from task_board_item_prs pr where pr.task_board_item_id = a.task_board_item_id)
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
          and ${inRange("a.occurred_at", q)} and ${orgIn(q.orgIds, "i.organization_id")}
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
        and ${orgIn(q.orgIds, "i.organization_id")}
    `);

    const perDay = await this.rows(sql`
      select date_trunc('day', l.created_at) as t,
             round(sum(coalesce((p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric, 0)), 2) as "USD"
      from task_board_item_threads l
      join thread_message_parts p on p.thread_id = l.thread_id and p.kind = 'finish'
      join task_board_items i     on i.id = l.task_board_item_id
      where ${inRange("l.created_at", q)} and ${orgIn(q.orgIds, "i.organization_id")}
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
      group by 1, 2 order by 4 desc nulls last
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
      ),
    ];
  }

  /** Panels 27–32: is the agent shipping work that holds? */
  async quality(q: AnalyticsQuery): Promise<Section[]> {
    const completed = reviewedCompletedCte(q.orgIds);
    const moves = movesCte(q.orgIds);

    const [yieldRow] = await this.rows(sql`
      with completed as (${completed}), rework as (${reworkCte})
      select round(100.0 * count(*) filter (where coalesce(r.changes_requested, 0) = 0)
                   / nullif(count(*), 0), 1) as clean_first_pass,
             round(avg(coalesce(r.changes_requested, 0))::numeric, 2) as changes_per_task
      from completed c left join rework r on r.item_id = c.item_id
      where ${inRange("c.done_at", q)}
    `);

    const [autonomy] = await this.rows(sql`
      with moves as (${moves})
      select round(100.0 * count(*) filter (where actor_id is null)
                   / nullif(count(*), 0), 1) as pct
      from moves where lane in ('done','merged') and ${inRange("entered_at", q)}
    `);

    const [abandonment] = await this.rows(sql`
      with moves as (${moves})
      select round(100.0 * count(distinct item_id) filter (
               where not exists (select 1 from task_board_item_prs pr where pr.task_board_item_id = m.item_id))
             / nullif(count(distinct item_id), 0), 1) as pct
      from moves m where lane = 'archived' and ${inRange("entered_at", q)}
    `);

    const reworkOverTime = await this.rows(sql`
      with completed as (${completed}), rework as (${reworkCte})
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
      where ${inRange("i.created_at::timestamptz", q)} and ${orgIn(q.orgIds, "i.organization_id")}
      group by 1, 2
      having sum(i.retry_attempts) > 0
      order by 4 desc
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
        title: "Rework over time",
        points: reworkOverTime.map((r) => ({
          t: iso(r.t),
          "Changes requested / task": num(r["Changes requested / task"]),
          "First-pass yield %": num(r["First-pass yield %"]),
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
        and ${orgIn(q.orgIds, "i.organization_id")}
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
        and ${orgIn(q.orgIds, "i.organization_id")}
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
        and ${orgIn(q.orgIds, "i.organization_id")}
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
        and ${orgIn(q.orgIds, "i.organization_id")}
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
        and ${orgIn(q.orgIds, "i.organization_id")}
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
        and ${orgIn(q.orgIds, "i.organization_id")}
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
      ),
    ];
  }

  /** Panels 9 + 33: per-tenant scorecard and queue wait. */
  async tenants(q: AnalyticsQuery): Promise<Section[]> {
    const moves = movesCte(q.orgIds);

    const scorecard = await this.rows(sql`
      with moves as (${moves}),
      completed as (
        select org_id, org_slug, item_id, min(entered_at) as done_at
        from moves where lane in ('done','merged') and ${inRange("entered_at", q)}
        group by 1, 2, 3
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
          and ${inRange("l.created_at", q)} and ${orgIn(q.orgIds, "i.organization_id")}
        group by 1
      ),
      cost as (
        select i.organization_id as org_id,
               sum(coalesce((p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric, 0)) as usd,
               count(distinct l.thread_id) as threads
        from task_board_item_threads l
        join thread_message_parts p on p.thread_id = l.thread_id and p.kind = 'finish'
        join task_board_items i on i.id = l.task_board_item_id
        where ${inRange("l.created_at", q)} and ${orgIn(q.orgIds, "i.organization_id")}
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
      group by 1, 2 order by 3 desc
    `);

    const queueWait = await this.rows(sql`
      with moves as (${moves})
      select org_slug as "Org", org_id as "Org ID",
             count(*) as "Queued",
             round((percentile_cont(0.5) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p50",
             round((percentile_cont(0.9) within group (order by extract(epoch from (left_at - entered_at))))::numeric, 0) as "p90"
      from moves
      where lane = 'todo' and left_at is not null and ${inRange("entered_at", q)}
      group by 1, 2 order by 5 desc nulls last
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
      ),
      table(
        "Queue wait by tenant",
        ["Org", "Org ID", "Queued", "p50", "p90"],
        queueWait,
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
