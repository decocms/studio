// @decocms/telos/postgres — Postgres storage for telos (Kysely). The core stays
// infra-free; this subpath is opt-in, with `kysely` as an optional peer.
//
// Like DBOS, telos OWNS its DB schema (`telos`) and migrates it itself — the
// host calls migrateTelos() at boot and never declares telos tables or carries
// telos migration files. Hosts map their own tenant id (e.g. org) to `tenant`.

import { type ColumnType, type Kysely, sql } from "kysely";
import { type GoalLedger, type GoalSource, UnmovedMover } from "../core";

const SCHEMA = "telos";

interface GoalRow {
  id: string;
  tenant: string;
  version: number;
  source: string;
  target: unknown; // jsonb — opaque to the ledger, parsed as T by the host
  created_at: ColumnType<Date, string | undefined, string>;
}

interface FactRow {
  id: string;
  tenant: string;
  label: string;
  value: string;
  confidence: string;
  status: string;
  source_url: string | null;
  created_at: ColumnType<Date, string | undefined, string>;
  updated_at: ColumnType<Date, string | undefined, string>;
}

// Table keys are unqualified; queries are scoped with `.withSchema(SCHEMA)`.
export interface TelosTables {
  goals: GoalRow;
  facts: FactRow;
}

export type FactStatus = "proposed" | "confirmed" | "rejected";

// A finding the elenchus uncovered about a tenant — tentative until confirmed.
export interface FactInput {
  label: string;
  value: string;
  confidence: string;
  sourceUrl?: string;
}

export interface Fact {
  id: string;
  label: string;
  value: string;
  confidence: string;
  status: FactStatus;
  sourceUrl: string | null;
}

// A wired telos: the Postgres-backed goal ledger + fact store over the `telos`
// schema. The two durable ports a host holds onto. Orchestration (bus, scheduler,
// the pursuit loop) is the host's — the kernel reports, the host reacts.
export interface Telos<T> {
  ledger: GoalLedger<T>;
  facts: ReturnType<typeof createPostgresFactStore>;
}

// The single init: migrate the `telos` schema, then build the stores over the
// host's connection. The host maps its own tenant id (e.g. org) to `tenant` and
// supplies the goal target type T. Safe to call on every boot.
export async function initTelos<T>(config: {
  db: Kysely<TelosTables>;
}): Promise<Telos<T>> {
  await migrateTelos(config.db);
  return {
    ledger: createPostgresGoalLedger<T>(config.db),
    facts: createPostgresFactStore(config.db),
  };
}

// Idempotent self-migration. Safe to call on every boot.
export async function migrateTelos(db: Kysely<TelosTables>): Promise<void> {
  await db.schema.createSchema(SCHEMA).ifNotExists().execute();
  const schema = db.withSchema(SCHEMA).schema;

  await schema
    .createTable("goals")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("tenant", "text", (c) => c.notNull())
    .addColumn("version", "integer", (c) => c.notNull())
    .addColumn("source", "text", (c) => c.notNull())
    .addColumn("target", "jsonb", (c) => c.notNull())
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await schema
    .createIndex("goals_tenant_version_idx")
    .ifNotExists()
    .on("goals")
    .columns(["tenant", "version"])
    .unique()
    .execute();

  await schema
    .createTable("facts")
    .ifNotExists()
    .addColumn("id", "text", (c) => c.primaryKey())
    .addColumn("tenant", "text", (c) => c.notNull())
    .addColumn("label", "text", (c) => c.notNull())
    .addColumn("value", "text", (c) => c.notNull())
    .addColumn("confidence", "text", (c) => c.notNull())
    .addColumn("status", "text", (c) => c.notNull().defaultTo("proposed"))
    .addColumn("source_url", "text")
    .addColumn("created_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .addColumn("updated_at", "timestamptz", (c) =>
      c.notNull().defaultTo(sql`now()`),
    )
    .execute();
  await schema
    .createIndex("facts_tenant_idx")
    .ifNotExists()
    .on("facts")
    .column("tenant")
    .execute();
}

// Append-only GoalLedger over telos.goals. One lineage per tenant; `target` is
// stored as jsonb and round-tripped as T.
export function createPostgresGoalLedger<T>(
  db: Kysely<TelosTables>,
): GoalLedger<T> {
  const scoped = db.withSchema(SCHEMA);

  const movers = async (tenant: string): Promise<UnmovedMover<T>[]> => {
    const rows = await scoped
      .selectFrom("goals")
      .selectAll()
      .where("tenant", "=", tenant)
      .orderBy("version", "asc")
      .execute();
    return rows.map(
      (r) =>
        new UnmovedMover<T>({
          tenant: r.tenant,
          version: r.version,
          target: asTarget<T>(r.target),
          source: r.source as GoalSource,
        }),
    );
  };

  return {
    async install(tenant, target, source: GoalSource = "authority") {
      const version = (await movers(tenant)).length + 1;
      await scoped
        .insertInto("goals")
        .values({
          id: `goal_${crypto.randomUUID()}`,
          tenant,
          version,
          source,
          target: JSON.stringify(target),
        })
        .execute();
      return new UnmovedMover<T>({ tenant, version, target, source });
    },

    async latest(tenant) {
      const last = (await movers(tenant)).at(-1);
      if (!last) throw new Error(`no UnmovedMover for tenant ${tenant}`);
      return last;
    },

    async anchor(tenant) {
      const a = (await movers(tenant))
        .filter((m) => m.source === "authority")
        .at(-1);
      if (!a)
        throw new Error(`no anchor (authority goal) for tenant ${tenant}`);
      return a;
    },

    async history(tenant) {
      return movers(tenant);
    },

    async tenants() {
      const rows = await scoped
        .selectFrom("goals")
        .select("tenant")
        .distinct()
        .execute();
      return rows.map((r) => r.tenant);
    },
  };
}

// Tentative elenchus findings over telos.facts; the tenant confirms/rejects each.
export function createPostgresFactStore(db: Kysely<TelosTables>) {
  const scoped = db.withSchema(SCHEMA);

  return {
    async insertMany(tenant: string, facts: FactInput[]): Promise<void> {
      if (facts.length === 0) return;
      await scoped
        .insertInto("facts")
        .values(
          facts.map((f) => ({
            id: `fact_${crypto.randomUUID()}`,
            tenant,
            label: f.label,
            value: f.value,
            confidence: f.confidence,
            status: "proposed",
            source_url: f.sourceUrl ?? null,
          })),
        )
        .execute();
    },

    async list(tenant: string): Promise<Fact[]> {
      const rows = await scoped
        .selectFrom("facts")
        .selectAll()
        .where("tenant", "=", tenant)
        .where("status", "!=", "rejected")
        .orderBy("created_at", "asc")
        .execute();
      return rows.map((r) => ({
        id: r.id,
        label: r.label,
        value: r.value,
        confidence: r.confidence,
        status: r.status as FactStatus,
        sourceUrl: r.source_url,
      }));
    },

    async setStatus(
      tenant: string,
      factId: string,
      status: FactStatus,
    ): Promise<void> {
      await scoped
        .updateTable("facts")
        .set({ status, updated_at: new Date().toISOString() })
        .where("tenant", "=", tenant)
        .where("id", "=", factId)
        .execute();
    },
  };
}

function asTarget<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
