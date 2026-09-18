#!/usr/bin/env bun
import { parseArgs } from "node:util";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { Kysely, PostgresDialect } from "kysely";
import { Pool } from "pg";
import type { Database } from "../src/storage/types";
import { DemoStorage } from "../src/storage/demo";
import { DEMO_SCENARIO } from "@decocms/shared/demo";

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  allowPositionals: true,
  options: {
    org: { type: "string", default: "demo-local" },
    owner: { type: "string" },
    bundle: { type: "string" },
    home: { type: "string" },
    url: { type: "string", default: "http://localhost:4000" },
    scenario: { type: "string", default: DEMO_SCENARIO },
  },
});
if (
  !["setup", "reset"].includes(positionals[0] ?? "") ||
  !/^[a-z0-9][a-z0-9-]{1,62}$/.test(values.org) ||
  values.scenario !== DEMO_SCENARIO
)
  throw new Error(
    "Usage: bun run demo:setup --org demo-local --scenario storefront-v1 [--owner EMAIL] [--home DEV_DATA_DIR] [--url FRONTEND_URL]",
  );
const home =
  values.home ??
  process.env.DECOCMS_HOME ??
  process.env.DATA_DIR ??
  join(process.cwd(), ".deco");
const connection =
  !values.home && process.env.DATABASE_URL
    ? { connectionString: process.env.DATABASE_URL }
    : {
        host: "127.0.0.1",
        user: "postgres",
        password: "postgres",
        database: "postgres",
        port: (
          JSON.parse(
            await readFile(join(home, "services/postgres/state.json"), "utf8"),
          ) as { port: number }
        ).port,
      };
const db = new Kysely<Database>({
  dialect: new PostgresDialect({ pool: new Pool({ ...connection, max: 2 }) }),
});
try {
  let query = db.selectFrom("user").select(["id", "email"]).limit(2);
  if (values.owner) query = query.where("email", "=", values.owner);
  const users = await query.execute();
  if (users.length !== 1)
    throw new Error(
      "Sign in to Studio first. If this deployment has multiple users, supply --owner EMAIL for the demonstration owner.",
    );
  const actor = users[0]!;
  let org = await db
    .selectFrom("organization")
    .select(["id", "slug"])
    .where("slug", "=", values.org)
    .executeTakeFirst();
  if (!org && positionals[0] === "reset")
    throw new Error("Demonstration organization not found");
  if (!org) {
    org = await db.transaction().execute(async (trx) => {
      const id = crypto.randomUUID();
      const created = await trx
        .insertInto("organization")
        .values({
          id,
          name: "Demo Storefront",
          slug: values.org,
          createdAt: new Date(),
        })
        .returning(["id", "slug"])
        .executeTakeFirstOrThrow();
      await trx
        .insertInto("member")
        .values({
          id: crypto.randomUUID(),
          organizationId: id,
          userId: actor.id,
          role: "owner",
          createdAt: new Date(),
        })
        .execute();
      return created;
    });
  }
  const membership = await db
    .selectFrom("member")
    .select("id")
    .where("organizationId", "=", org.id)
    .where("userId", "=", actor.id)
    .executeTakeFirst();
  if (!membership)
    throw new Error("The selected owner is not a member of this organization");
  const demo = new DemoStorage(db);
  if (positionals[0] === "setup") await demo.register(org.id);
  const registered = await demo.get(org.id);
  if (!registered)
    throw new Error("This organization is not registered as a demonstration");
  if (values.bundle) {
    const file = Bun.file(values.bundle);
    if (file.size > 100_000_000) throw new Error("Demo bundle exceeds 100 MB");
    await demo.installBundle(org.id, actor.id, await file.json());
  }
  await demo.bundle(org.id);
  await demo.ensureReportsAgent(org.id, actor.id);
  await demo.ensureSelfConnection(org.id, actor.id, values.url);
  if (
    positionals[0] === "reset" ||
    registered.generation === 0 ||
    values.bundle
  )
    await demo.reset(
      org.id,
      actor.id,
      crypto.randomUUID(),
      registered.generation,
    );
  console.log(
    `Demonstration ready: ${values.url.replace(/\/$/, "")}/${org.slug}/tasks`,
  );
  console.log(
    "Restore through /_admin or bun run demo:reset. Refresh preserves your changes.",
  );
} finally {
  await db.destroy();
}
