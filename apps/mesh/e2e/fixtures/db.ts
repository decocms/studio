/**
 * Direct DB access for Playwright e2e tests.
 *
 * The dev server (apps/mesh/src/services/ensure-services.ts) boots an
 * embedded-postgres instance on a **dynamic** port and writes its pid +
 * port to `<home>/services/postgres/state.json`. The home directory
 * depends on how the server was started:
 *   - `DATA_DIR` / `DECOCMS_HOME` env vars override everything
 *   - `deco dev`         → `<cwd>/.deco/` (CLI default)
 *   - `deco services up` → `~/deco/`     (services command default)
 *
 * We check all three (env, cwd-relative, home-relative) so the fixture
 * works whichever way a dev brought the server up.
 *
 * Tests read state.json to discover the live port and connect with the
 * `pg` driver. This is deliberately a real DB connection — no mocks —
 * so seeding state for a scenario (orgs claiming a domain, a user with
 * verified email) hits the same Postgres the dev server is talking to.
 *
 * One client per test; close it in `afterAll` / `test.afterAll`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";

const PG_USER = "postgres";
const PG_PASSWORD = "postgres";

/** Candidate data-dir paths, ordered by preference. */
function candidateHomes(): string[] {
  const explicit = process.env.DATA_DIR ?? process.env.DECOCMS_HOME;
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  // `deco dev` puts data in <cwd>/.deco/. Playwright runs from apps/mesh,
  // but tests may also be invoked from the repo root — check both.
  candidates.push(join(process.cwd(), ".deco"));
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
      `Start the dev server first (\`bun run --cwd=apps/mesh dev\` or \`deco services up\`).`,
  );
}

/** Open a pg.Client connected to the dev server's postgres. */
export async function connectDevDb(): Promise<Client> {
  const port = readDevDbPort();
  const client = new Client({
    host: "127.0.0.1",
    port,
    user: PG_USER,
    password: PG_PASSWORD,
    database: "postgres",
  });
  await client.connect();
  return client;
}
