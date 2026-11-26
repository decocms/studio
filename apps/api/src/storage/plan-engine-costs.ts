/**
 * The store-analysis engine's spend ledger (migration 272): append-only, one
 * row per billed call, read back as aggregates of one organization.
 */

import { type Kysely, type RawBuilder, sql } from "kysely";
import { chunk, nowIso, rethrow, ts } from "./plan-engine.ts";
import type { Database } from "./types";

export interface CostEventDraft {
  /** Unique within the scope passed to the write; the id is `<scope>:<key>`. */
  key: string;
  /** When the spend happened; absent = now. */
  at?: string;
  provider: string;
  kind: string;
  feature: string;
  model: string | null;
  unitsIn: number | null;
  unitsOut: number | null;
  /** Null: it happened and has no known price. Never 0. */
  costUsd: number | null;
  executionId?: string | null;
  jobId?: string | null;
  productId?: string | null;
}

export interface CostFilters {
  /** Start of the window, inclusive, ISO-8601 in UTC. */
  from: string;
  /** End of the window, EXCLUSIVE, ISO-8601 in UTC. */
  to: string;
  granularity: "day" | "week" | "month";
  features?: string[];
  providers?: string[];
}

export interface CostBucket {
  bucket: string;
  usd: number;
  by_feature: Record<string, number>;
}

export interface CostSummary {
  total_usd: number;
  events: number;
  /** Events that happened with no known price. Never summed as 0. */
  unpriced_events: number;
  unpriced_models: string[];
  series: CostBucket[];
  by_feature: Array<{
    feature: string;
    usd: number;
    events: number;
    unpriced_events: number;
  }>;
  by_provider: Array<{ provider: string; usd: number; events: number }>;
  by_model: Array<{
    provider: string;
    model: string | null;
    usd: number;
    calls: number;
    units_in: number;
    units_out: number;
    unpriced_events: number;
  }>;
  top_executions: Array<{
    execution_id: string;
    name: string | null;
    usd: number;
    products: number;
  }>;
}

/** An ISO wall time read as UTC, whatever the session's time zone. */
const utc = (iso: string) => sql`(${iso}::timestamp AT TIME ZONE 'UTC')`;

const AT_UTC = sql`(at AT TIME ZONE 'UTC')`;

/** `at` grouped into buckets; weeks are SQLite's `%Y-W%W` (Monday-first, week 00 before the first Monday). */
function bucketExpr(
  granularity: CostFilters["granularity"],
): RawBuilder<unknown> {
  if (granularity === "month") return sql`to_char(${AT_UTC}, 'YYYY-MM')`;
  if (granularity === "week") {
    return sql`(to_char(${AT_UTC}, 'YYYY') || '-W' || lpad(
      floor((extract(doy FROM ${AT_UTC}) - 1 + 7
             - ((extract(dow FROM ${AT_UTC})::int + 6) % 7)) / 7)::int::text,
      2, '0'))`;
  }
  return sql`to_char(${AT_UTC}, 'YYYY-MM-DD')`;
}

/** The WHERE every aggregate shares, so the numbers add up. Always one org. */
function whereClause(orgId: string, f: CostFilters): RawBuilder<unknown> {
  const clauses = [
    sql`organization_id = ${orgId}`,
    sql`at >= ${utc(f.from)}`,
    sql`at < ${utc(f.to)}`,
  ];
  if (f.features?.length) {
    clauses.push(sql`feature IN (${sql.join(f.features)})`);
  }
  if (f.providers?.length) {
    clauses.push(sql`provider IN (${sql.join(f.providers)})`);
  }
  return sql.join(clauses, sql` AND `);
}

type Row = Record<string, unknown>;

export class PlanEngineCostStorage {
  constructor(private readonly db: Kysely<Database>) {}

  /**
   * Writes a batch of spend. The id is deterministic (`<scope>:<key>`) and a
   * repeat is ignored, so a retried step does not count the same call twice.
   * Returns how many rows were new.
   */
  async insertCostEvents(
    orgId: string,
    scope: string,
    drafts: readonly CostEventDraft[],
  ): Promise<number> {
    if (drafts.length === 0) return 0;
    try {
      const now = nowIso();
      let written = 0;
      for (const group of chunk(drafts)) {
        const values = group.map(
          (d) => sql`(
            ${`${scope}:${d.key}`}, ${ts(d.at ?? now)}, ${d.provider},
            ${d.kind}, ${d.feature}, ${d.model}, ${d.unitsIn}::bigint,
            ${d.unitsOut}::bigint, ${d.costUsd}::double precision,
            ${d.executionId ?? null}, ${d.jobId ?? null},
            ${d.productId ?? null}, ${ts(now)}, ${orgId})`,
        );
        const result = await sql`
          INSERT INTO plan_cost_events
            (id, at, provider, kind, feature, model, units_in, units_out,
             cost_usd, execution_id, job_id, product_id, created_at,
             organization_id)
          VALUES ${sql.join(values)}
          ON CONFLICT (id) DO NOTHING
        `.execute(this.db);
        written += Number(result.numAffectedRows ?? 0);
      }
      return written;
    } catch (err) {
      rethrow("Failed to insert cost events", err);
    }
  }

  /** Everything the cost view shows, as SQL aggregates of one org. */
  async summarizeCosts(
    orgId: string,
    filters: CostFilters,
  ): Promise<CostSummary> {
    try {
      const where = whereClause(orgId, filters);
      const bucket = bucketExpr(filters.granularity);
      const run = (q: RawBuilder<Row>) =>
        q.execute(this.db).then((r) => r.rows);
      const [totals, series, byFeature, byProvider, byModel, topExecutions] =
        await Promise.all([
          run(sql<Row>`
            SELECT COALESCE(SUM(cost_usd), 0) AS usd,
                   COUNT(*) AS events,
                   COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unpriced
              FROM plan_cost_events WHERE ${where}`),
          run(sql<Row>`
            SELECT ${bucket} AS bucket, feature,
                   COALESCE(SUM(cost_usd), 0) AS usd
              FROM plan_cost_events WHERE ${where}
             GROUP BY 1, feature
             ORDER BY 1 ASC`),
          run(sql<Row>`
            SELECT feature,
                   COALESCE(SUM(cost_usd), 0) AS usd,
                   COUNT(*) AS events,
                   COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unpriced
              FROM plan_cost_events WHERE ${where}
             GROUP BY feature ORDER BY usd DESC`),
          run(sql<Row>`
            SELECT provider,
                   COALESCE(SUM(cost_usd), 0) AS usd,
                   COUNT(*) AS events
              FROM plan_cost_events WHERE ${where}
             GROUP BY provider ORDER BY usd DESC`),
          run(sql<Row>`
            SELECT provider, model,
                   COALESCE(SUM(cost_usd), 0) AS usd,
                   COUNT(*) AS calls,
                   COALESCE(SUM(units_in), 0) AS units_in,
                   COALESCE(SUM(units_out), 0) AS units_out,
                   COUNT(*) FILTER (WHERE cost_usd IS NULL) AS unpriced
              FROM plan_cost_events WHERE ${where}
             GROUP BY provider, model ORDER BY usd DESC`),
          run(sql<Row>`
            SELECT execution_id, NULL AS name,
                   COALESCE(SUM(cost_usd), 0) AS usd,
                   COUNT(DISTINCT product_id) AS products
              FROM plan_cost_events
             WHERE ${where} AND execution_id IS NOT NULL
             GROUP BY execution_id ORDER BY usd DESC LIMIT 10`),
        ]);

      const t = totals[0] ?? {};
      const byBucket = new Map<string, CostBucket>();
      for (const r of series) {
        const key = String(r.bucket);
        const feature = String(r.feature);
        const usd = Number(r.usd);
        const entry = byBucket.get(key) ?? {
          bucket: key,
          usd: 0,
          by_feature: {},
        };
        entry.usd += usd;
        entry.by_feature[feature] = (entry.by_feature[feature] ?? 0) + usd;
        byBucket.set(key, entry);
      }

      const modelRows = byModel.map((r) => ({
        provider: String(r.provider),
        model: (r.model as string | null) ?? null,
        usd: Number(r.usd),
        calls: Number(r.calls),
        units_in: Number(r.units_in),
        units_out: Number(r.units_out),
        unpriced: Number(r.unpriced ?? 0),
      }));

      return {
        total_usd: Number(t.usd ?? 0),
        events: Number(t.events ?? 0),
        unpriced_events: Number(t.unpriced ?? 0),
        unpriced_models: modelRows
          .filter((r) => r.unpriced > 0)
          .map((r) => r.model ?? r.provider)
          .sort(),
        series: [...byBucket.values()],
        by_feature: byFeature.map((r) => ({
          feature: String(r.feature),
          usd: Number(r.usd),
          events: Number(r.events),
          unpriced_events: Number(r.unpriced ?? 0),
        })),
        by_provider: byProvider.map((r) => ({
          provider: String(r.provider),
          usd: Number(r.usd),
          events: Number(r.events),
        })),
        by_model: modelRows.map((r) => ({
          provider: r.provider,
          model: r.model,
          usd: r.usd,
          calls: r.calls,
          units_in: r.units_in,
          units_out: r.units_out,
          unpriced_events: r.unpriced,
        })),
        top_executions: topExecutions.map((r) => ({
          execution_id: String(r.execution_id),
          name: (r.name as string | null) ?? null,
          usd: Number(r.usd),
          products: Number(r.products),
        })),
      };
    } catch (err) {
      rethrow("Failed to summarize costs", err);
    }
  }
}
