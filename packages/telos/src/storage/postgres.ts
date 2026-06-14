// @decocms/telos/postgres — a Postgres GoalLedger adapter (Kysely). The core
// stays infra-free; this subpath is opt-in, with `kysely` as an optional peer.
//
// Like DBOS, telos owns its own DB SCHEMA (`telos`) so its tables never mingle
// with the host's `public` schema. Hosts hand in a connection and register the
// migration; they map their own tenant id (e.g. org) to `tenant`.

import { type ColumnType, type Kysely, sql } from "kysely";
import { type GoalLedger, type GoalSource, UnmovedMover } from "../core";

const SCHEMA = "telos";

export interface TelosGoalRow {
  id: string;
  tenant: string;
  version: number;
  source: string;
  target: unknown; // jsonb — opaque to the ledger, parsed as T by the host
  created_at: ColumnType<Date, string | undefined, string>;
}

// Table key is unqualified; the adapter scopes queries with `.withSchema(SCHEMA)`.
export interface TelosLedgerTables {
  goals: TelosGoalRow;
}

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema.createSchema(SCHEMA).ifNotExists().execute();
  const schema = db.withSchema(SCHEMA).schema;

  await schema
    .createTable("goals")
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
    .on("goals")
    .columns(["tenant", "version"])
    .unique()
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropSchema(SCHEMA).ifExists().cascade().execute();
}

// Append-only GoalLedger over telos.goals. One lineage per tenant; `target` is
// stored as jsonb and round-tripped as T.
export function createPostgresGoalLedger<T>(
  db: Kysely<TelosLedgerTables>,
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
  };
}

function asTarget<T>(value: unknown): T {
  return (typeof value === "string" ? JSON.parse(value) : value) as T;
}
