/**
 * Direct DB access for Playwright e2e tests.
 *
 * Two ways the dev server's Postgres gets exposed to us:
 *
 *   1. CI / explicit env: `DATABASE_URL` points at an external Postgres
 *      (the e2e workflow boots a postgres:16 service on :5432 and sets
 *      it). When present, we use it verbatim — no state.json lookup.
 *
 *   2. Local dev: `bun run --cwd=apps/mesh dev` boots embedded-postgres
 *      on a **dynamic** port and writes pid+port to
 *      `<home>/services/postgres/state.json`. Home defaults to
 *      `<cwd>/.deco/` (CLI default) or `~/deco/` (`deco services up`),
 *      with `DATA_DIR` / `DECOCMS_HOME` overriding. We walk a few
 *      candidate locations because the dev server's CWD differs from
 *      Playwright's (apps/mesh).
 *
 * Tests connect with the `pg` driver — no mocks. Seeding state for a
 * scenario hits the same Postgres the dev server is talking to.
 *
 * One client per test; close it in `afterAll` / `test.afterAll`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client, type ClientConfig } from "pg";

const PG_USER = "postgres";
const PG_PASSWORD = "postgres";

/** Candidate data-dir paths, ordered by preference. */
function candidateHomes(): string[] {
  const explicit = process.env.DATA_DIR ?? process.env.DECOCMS_HOME;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  // `deco dev` puts data in <cwd>/.deco/, but CWD depends on how the
  // server was started (repo root vs. `apps/mesh`). Walk up the tree
  // from process.cwd() — Playwright runs from `apps/mesh` but the dev
  // server may have been started from the repo root.
  let dir = process.cwd();
  for (let i = 0; i < 4; i++) {
    candidates.push(join(dir, ".deco"));
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
  }
  // `deco services up` puts data in ~/deco/.
  candidates.push(join(homedir(), "deco"));
  return candidates;
}

/** Resolve the embedded-postgres port the dev server wrote on boot. */
function readDevDbPort(): number {
  const tried: string[] = [];
  for (const home of candidateHomes()) {
    const stateFile = join(home, "services", "postgres", "state.json");
    tried.push(stateFile);
    if (!existsSync(stateFile)) continue;
    const raw = readFileSync(stateFile, "utf8");
    const parsed = JSON.parse(raw) as { port?: unknown };
    if (typeof parsed.port !== "number") {
      throw new Error(
        `Expected numeric "port" in ${stateFile}, got ${JSON.stringify(parsed.port)}`,
      );
    }
    return parsed.port;
  }
  throw new Error(
    `Dev postgres state.json not found. Looked in:\n  ${tried.join("\n  ")}\n` +
      `Start the dev server first (\`bun run --cwd=apps/mesh dev\` or \`deco services up\`), or set DATABASE_URL.`,
  );
}

/** Resolve a pg.Client config from DATABASE_URL or embedded state.json. */
function resolveClientConfig(): ClientConfig {
  // CI sets DATABASE_URL to a docker-services Postgres; local dev relies
  // on the embedded-postgres state.json. Honor the env var first so CI
  // doesn't have to fabricate a state.json.
  const url = process.env.DATABASE_URL;
  if (url && url.length > 0) {
    return { connectionString: url };
  }
  return {
    host: "127.0.0.1",
    port: readDevDbPort(),
    user: PG_USER,
    password: PG_PASSWORD,
    database: "postgres",
  };
}

/** Open a pg.Client connected to the dev server's postgres. */
export async function connectDevDb(): Promise<Client> {
  const client = new Client(resolveClientConfig());
  await client.connect();
  return client;
}
