/**
 * Read-only SQL behind the admin thread analytics surface: every thread, not
 * only task board runs — chats, automations and task runs alike.
 *
 * Same measurement rules as `task-board-analytics.ts`: USD is the OpenRouter
 * price recorded on `finish` parts, so it is a floor (a claude-subscription run
 * reports nothing) and ships next to its coverage %. Error text comes from
 * `kind = 'error'` parts, not `threads.failure_reason`.
 */

import { sql, type Kysely } from "kysely";
import {
  inRange,
  iso,
  num,
  orgIn,
  table,
  type AnalyticsQuery,
  type Row,
  type Section,
} from "./task-board-analytics";
import type { Database } from "./types";

export const THREAD_KINDS = ["chat", "automation", "task"] as const;
export type ThreadKind = (typeof THREAD_KINDS)[number];

/** A task board run first (it may also carry a trigger), then automation. */
const kindOf = (t: string) => sql`
  case when exists (select 1 from task_board_item_threads l where l.thread_id = ${sql.ref(`${t}.id`)}) then 'task'
       when ${sql.ref(`${t}.trigger_id`)} is not null then 'automation'
       else 'chat' end`;

const USD = sql`(p.metadata->'usage'->'providerMetadata'->'openrouter'->'usage'->>'cost')::numeric`;
const TOKENS = (field: string) =>
  sql`coalesce((p.metadata->'usage'->>${field})::numeric, 0)`;

/** Failure kinds that are settled history, not an error; `credits` is a quota wall. */
const IS_ERROR = sql`coalesce(t.failure_kind, 'error') not in ('superseded','ended_after_delivery','cancelled','abandoned','credits')`;

/** One row per assistant turn with its price and tokens, attributed to the thread's creator. */
const spendCte = (q: AnalyticsQuery) => sql`
  select p.org_id, o.slug as org_slug, t.id as thread_id, t.title, t.created_by as user_id,
         t.virtual_mcp_id, ${kindOf("t")} as kind, p.persisted_at as at,
         ${USD} as usd,
         ${TOKENS("inputTokens")} as input_tokens,
         ${TOKENS("outputTokens")} as output_tokens,
         ${TOKENS("totalTokens")} as total_tokens
  from thread_message_parts p
  join threads t      on t.id = p.thread_id
  join organization o on o.id = p.org_id
  where p.kind = 'finish' and p.role = 'assistant'
    and ${inRange("p.persisted_at", q)} and ${orgIn(q.orgIds, "p.org_id")}
`;

/** `threads.updated_at` is ISO text; compare as text so its index applies. */
const isoBound = (v: string) => new Date(v).toISOString();

export interface LiveThread {
  id: string;
  orgId: string;
  orgSlug: string;
  title: string;
  status: string;
  kind: ThreadKind;
  failureKind: string | null;
  failureReason: string | null;
  /** Latest `error` part text — the real message; `failureReason` is canned. */
  lastError: string | null;
  harnessId: string | null;
  agent: string;
  userName: string | null;
  userEmail: string | null;
  createdAt: string;
  updatedAt: string;
  usd: number | null;
  tokens: number | null;
}

export interface LiveQuery {
  orgIds: string[] | null;
  status?: string;
  kind?: ThreadKind;
  limit: number;
}

export class ThreadAnalyticsStorage {
  constructor(private readonly db: Kysely<Database>) {}

  private async rows(query: ReturnType<typeof sql>): Promise<Row[]> {
    const result = await query.execute(this.db);
    return result.rows as Row[];
  }

  /** The most recently touched threads across the scope, newest first. */
  async live(q: LiveQuery): Promise<{
    threads: LiveThread[];
    counts: { running: number; waiting: number; failedLastHour: number };
  }> {
    const rows = await this.rows(sql`
      select * from (
        select t.id, t.organization_id, o.slug as org_slug, t.title, t.status,
               t.failure_kind, t.failure_reason, t.harness_id,
               t.created_at, t.updated_at,
               coalesce(c.title, t.virtual_mcp_id) as agent,
               u.name as user_name, u.email as user_email,
               ${kindOf("t")} as kind
        from threads t
        join organization o on o.id = t.organization_id
        left join "user" u      on u.id = t.created_by
        left join connections c on c.id = t.virtual_mcp_id
        where ${orgIn(q.orgIds, "t.organization_id")}
          and ${q.status ? sql`t.status = ${q.status}` : sql`true`}
          and ${q.kind ? sql`${kindOf("t")} = ${q.kind}` : sql`true`}
        order by t.updated_at desc
        limit ${q.limit}
      ) r
      left join lateral (
        select round(sum(${USD}), 4) as usd, sum(${TOKENS("totalTokens")}) as tokens
        from thread_message_parts p
        where p.thread_id = r.id and p.kind = 'finish'
      ) s on true
      left join lateral (
        select left(pe.payload->>'text', 300) as last_error
        from thread_message_parts pe
        where r.status = 'failed' and pe.thread_id = r.id and pe.kind = 'error'
        order by pe.created_at desc limit 1
      ) e on true
      order by r.updated_at desc
      limit ${q.limit}
    `);

    const hourAgo = new Date(Date.now() - 3600_000).toISOString();
    const [counts] = await this.rows(sql`
      select count(*) filter (where status = 'in_progress') as running,
             count(*) filter (where status = 'requires_action') as waiting,
             count(*) filter (where status = 'failed' and updated_at >= ${hourAgo}) as failed_last_hour
      from threads t
      where ${orgIn(q.orgIds, "t.organization_id")}
        and (status in ('in_progress','requires_action') or updated_at >= ${hourAgo})
    `);

    return {
      threads: rows.map((r) => ({
        id: String(r.id),
        orgId: String(r.organization_id),
        orgSlug: String(r.org_slug || r.organization_id),
        title: String(r.title ?? ""),
        status: String(r.status),
        kind: r.kind as ThreadKind,
        failureKind: (r.failure_kind as string | null) ?? null,
        failureReason: (r.failure_reason as string | null) ?? null,
        lastError: (r.last_error as string | null) ?? null,
        harnessId: (r.harness_id as string | null) ?? null,
        agent: String(r.agent ?? ""),
        userName: (r.user_name as string | null) ?? null,
        userEmail: (r.user_email as string | null) ?? null,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
        usd: num(r.usd),
        tokens: num(r.tokens),
      })),
      counts: {
        running: num(counts?.running) ?? 0,
        waiting: num(counts?.waiting) ?? 0,
        failedLastHour: num(counts?.failed_last_hour) ?? 0,
      },
    };
  }

  /** Who spends what: per org, per user, per agent, per kind, over time. */
  async usage(q: AnalyticsQuery): Promise<Section[]> {
    const spend = spendCte(q);

    const [totals] = await this.rows(sql`
      with spend as (${spend})
      select round(sum(usd), 2) as usd,
             sum(total_tokens) as tokens,
             sum(input_tokens) as input_tokens,
             sum(output_tokens) as output_tokens,
             count(*) as turns,
             count(distinct thread_id) as threads,
             count(distinct user_id) as users,
             count(distinct org_id) as orgs,
             round(100.0 * count(usd) / nullif(count(*), 0), 1) as coverage
      from spend
    `);

    const perDay = await this.rows(sql`
      with spend as (${spend})
      select date_trunc('day', at) as t,
             round(coalesce(sum(usd) filter (where kind = 'chat'), 0), 2) as "Chats",
             round(coalesce(sum(usd) filter (where kind = 'automation'), 0), 2) as "Automations",
             round(coalesce(sum(usd) filter (where kind = 'task'), 0), 2) as "Task board",
             sum(input_tokens) as input_tokens,
             sum(output_tokens) as output_tokens
      from spend group by 1 order by 1
    `);

    // Fixed windows, independent of the range: "who is burning money right now".
    const topQuery: AnalyticsQuery = {
      orgIds: q.orgIds,
      from: new Date(Date.now() - 30 * 86400_000).toISOString(),
      to: new Date().toISOString(),
    };
    const windows = sql`
      round(coalesce(sum(usd) filter (where at >= now() - interval '1 day'), 0), 2)  as "Last 24h USD",
      round(coalesce(sum(usd) filter (where at >= now() - interval '7 days'), 0), 2) as "Last 7d USD",
      round(coalesce(sum(usd), 0), 2) as "Last 30d USD"`;

    const topOrgs = await this.rows(sql`
      with spend as (${spendCte(topQuery)})
      select org_slug as "Org", ${windows}
      from spend group by 1 order by 2 desc, 3 desc, 4 desc limit 25
    `);

    const topUsers = await this.rows(sql`
      with spend as (${spendCte(topQuery)})
      select coalesce(u.email, s.user_id) as "User", s.org_slug as "Org", ${windows}
      from spend s left join "user" u on u.id = s.user_id
      group by 1, 2 order by 3 desc, 4 desc, 5 desc limit 25
    `);

    const byKindCols = sql`
      round(coalesce(sum(usd) filter (where kind = 'chat'), 0), 2)       as "Chats USD",
      round(coalesce(sum(usd) filter (where kind = 'automation'), 0), 2) as "Automations USD",
      round(coalesce(sum(usd) filter (where kind = 'task'), 0), 2)       as "Task board USD",
      round(coalesce(sum(usd), 0), 2) as "Total USD",
      sum(total_tokens) as "Tokens",
      count(distinct thread_id) as "Threads"`;

    const byOrg = await this.rows(sql`
      with spend as (${spend})
      select org_slug as "Org", ${byKindCols}, count(distinct user_id) as "Users"
      from spend group by 1 order by "Total USD" desc, "Tokens" desc limit 200
    `);

    const byUser = await this.rows(sql`
      with spend as (${spend})
      select coalesce(u.name, s.user_id) as "User", u.email as "Email", s.org_slug as "Org", ${byKindCols}
      from spend s left join "user" u on u.id = s.user_id
      group by 1, 2, 3 order by "Total USD" desc, "Tokens" desc limit 200
    `);

    const byAgent = await this.rows(sql`
      with spend as (${spend})
      select coalesce(c.title, s.virtual_mcp_id) as "Agent", s.org_slug as "Org",
             round(coalesce(sum(usd), 0), 2) as "Total USD",
             sum(total_tokens) as "Tokens",
             count(distinct thread_id) as "Threads"
      from spend s left join connections c on c.id = s.virtual_mcp_id
      group by 1, 2 order by 3 desc, 4 desc limit 100
    `);

    const priciest = await this.rows(sql`
      with spend as (${spend})
      select max(at) as "Last turn", s.org_slug as "Org", coalesce(u.email, s.user_id) as "User",
             s.kind as "Kind", left(s.title, 70) as "Title",
             round(coalesce(sum(usd), 0), 2) as "USD", sum(total_tokens) as "Tokens",
             count(*) as "Turns", s.thread_id as "Thread"
      from spend s left join "user" u on u.id = s.user_id
      group by s.thread_id, s.org_slug, 3, s.kind, s.title
      order by "USD" desc, "Tokens" desc limit 50
    `);

    return [
      {
        kind: "stat",
        title: "Usage",
        values: [
          { label: "Total spend", value: num(totals?.usd), unit: "USD" },
          { label: "Tokens", value: num(totals?.tokens) },
          { label: "Input tokens", value: num(totals?.input_tokens) },
          { label: "Output tokens", value: num(totals?.output_tokens) },
          { label: "Assistant turns", value: num(totals?.turns) },
          { label: "Threads", value: num(totals?.threads) },
          { label: "Users", value: num(totals?.users) },
          { label: "Orgs", value: num(totals?.orgs) },
          { label: "Cost coverage", value: num(totals?.coverage), unit: "%" },
        ],
      },
      {
        kind: "series",
        title: "Spend per day by kind",
        unit: "USD",
        points: perDay.map((r) => ({
          t: iso(r.t),
          Chats: num(r.Chats),
          Automations: num(r.Automations),
          "Task board": num(r["Task board"]),
        })),
      },
      {
        kind: "series",
        title: "Tokens per day",
        points: perDay.map((r) => ({
          t: iso(r.t),
          Input: num(r.input_tokens),
          Output: num(r.output_tokens),
        })),
      },
      table(
        "Top orgs by spend (fixed windows)",
        ["Org", "Last 24h USD", "Last 7d USD", "Last 30d USD"],
        topOrgs,
      ),
      table(
        "Top users by spend (fixed windows)",
        ["User", "Org", "Last 24h USD", "Last 7d USD", "Last 30d USD"],
        topUsers,
      ),
      table(
        "Spend by org",
        [
          "Org",
          "Chats USD",
          "Automations USD",
          "Task board USD",
          "Total USD",
          "Tokens",
          "Threads",
          "Users",
        ],
        byOrg,
      ),
      table(
        "Spend by user",
        [
          "User",
          "Email",
          "Org",
          "Chats USD",
          "Automations USD",
          "Task board USD",
          "Total USD",
          "Tokens",
          "Threads",
        ],
        byUser,
      ),
      table(
        "Spend by agent",
        ["Agent", "Org", "Total USD", "Tokens", "Threads"],
        byAgent,
      ),
      table(
        "Priciest threads",
        [
          "Last turn",
          "Org",
          "User",
          "Kind",
          "Title",
          "USD",
          "Tokens",
          "Turns",
          "Thread",
        ],
        priciest,
      ),
    ];
  }

  /** What is failing, where, and with which message. */
  async errors(q: AnalyticsQuery): Promise<Section[]> {
    const from = isoBound(q.from);
    const to = isoBound(q.to);
    const failedInRange = sql`
      from threads t
      join organization o on o.id = t.organization_id
      where t.status = 'failed' and t.updated_at between ${from} and ${to}
        and ${orgIn(q.orgIds, "t.organization_id")}`;

    const [counts] = await this.rows(sql`
      select count(*) filter (where ${IS_ERROR}) as failed,
             count(*) filter (where t.failure_kind = 'credits') as quota_blocked,
             count(distinct t.organization_id) filter (where ${IS_ERROR}) as orgs,
             count(distinct t.created_by) filter (where ${IS_ERROR}) as users
      ${failedInRange}
    `);

    const perDay = await this.rows(sql`
      select date_trunc('day', t.updated_at::timestamptz) as t,
             count(*) filter (where ${IS_ERROR} and ${kindOf("t")} = 'chat') as "Chats",
             count(*) filter (where ${IS_ERROR} and ${kindOf("t")} = 'automation') as "Automations",
             count(*) filter (where ${IS_ERROR} and ${kindOf("t")} = 'task') as "Task board",
             count(*) filter (where t.failure_kind = 'credits') as "Out of credits"
      ${failedInRange}
      group by 1 order by 1
    `);

    const kinds = await this.rows(sql`
      select coalesce(t.failure_kind, '(uncategorized)') as "Failure kind",
             count(*) as "Threads",
             count(distinct t.organization_id) as "Orgs"
      ${failedInRange}
      group by 1 order by 2 desc
    `);

    const byOrg = await this.rows(sql`
      select o.slug as "Org",
             count(*) filter (where ${IS_ERROR}) as "Errors",
             count(*) filter (where t.failure_kind = 'credits') as "Out of credits",
             count(distinct t.created_by) as "Users",
             max(t.updated_at) as "Last failure"
      ${failedInRange}
      group by 1 order by 2 desc limit 100
    `);

    const errorParts = sql`
      from thread_message_parts p
      join threads t      on t.id = p.thread_id
      join organization o on o.id = p.org_id
      left join "user" u  on u.id = t.created_by
      where p.kind = 'error' and ${inRange("p.persisted_at", q)}
        and ${orgIn(q.orgIds, "p.org_id")}`;

    const feed = await this.rows(sql`
      select p.persisted_at as "When", o.slug as "Org",
             coalesce(u.email, t.created_by) as "User",
             ${kindOf("t")} as "Kind",
             left(t.title, 70) as "Title",
             left(p.payload->>'text', 500) as "Error",
             p.thread_id as "Thread"
      ${errorParts}
      order by p.persisted_at desc limit 300
    `);

    const signatures = await this.rows(sql`
      select regexp_replace(regexp_replace(left(p.payload->>'text', 160), '[0-9]+', 'N', 'g'),
                            '\\s+', ' ', 'g') as "Signature",
             count(*) as "Hits",
             count(distinct p.org_id) as "Orgs",
             count(distinct p.thread_id) as "Threads",
             max(p.persisted_at) as "Last seen"
      ${errorParts}
      group by 1 order by 2 desc limit 40
    `);

    return [
      {
        kind: "stat",
        title: "Errors",
        values: [
          { label: "Failed threads", value: num(counts?.failed) },
          { label: "Out of credits", value: num(counts?.quota_blocked) },
          { label: "Orgs affected", value: num(counts?.orgs) },
          { label: "Users affected", value: num(counts?.users) },
        ],
      },
      {
        kind: "series",
        title: "Failed threads per day",
        points: perDay.map((r) => ({
          t: iso(r.t),
          Chats: num(r.Chats),
          Automations: num(r.Automations),
          "Task board": num(r["Task board"]),
          "Out of credits": num(r["Out of credits"]),
        })),
      },
      table("Failure kinds", ["Failure kind", "Threads", "Orgs"], kinds),
      table(
        "Errors by org",
        ["Org", "Errors", "Out of credits", "Users", "Last failure"],
        byOrg,
      ),
      table(
        "Live error feed",
        ["When", "Org", "User", "Kind", "Title", "Error", "Thread"],
        feed,
      ),
      table(
        "Error signatures",
        ["Signature", "Hits", "Orgs", "Threads", "Last seen"],
        signatures,
      ),
    ];
  }

  /** Orgs with any thread — the admin page's org picker. */
  async orgsWithThreads(): Promise<
    { id: string; slug: string; name: string }[]
  > {
    const rows = await this.rows(sql`
      select o.id, o.slug, o.name
      from organization o
      where exists (select 1 from threads t where t.organization_id = o.id)
      order by o.slug asc
    `);
    return rows.map((r) => ({
      id: String(r.id),
      slug: String(r.slug || r.id),
      name: String(r.name ?? r.slug),
    }));
  }
}
