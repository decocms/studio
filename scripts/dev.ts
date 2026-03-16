#!/usr/bin/env bun
/**
 * Dev entry point: ensures services are running, then runs migrations
 * and starts the mesh dev servers.
 *
 * Called by `bun run dev` from the monorepo root.
 */
import { join } from "path";
import { ASCII_ART } from "../apps/mesh/src/fmt.ts";
import { ensureServices } from "./dev-services.ts";

const repoRoot = join(import.meta.dir, "..");

// Print banner before any service/migration output
console.log("");
for (const line of ASCII_ART) {
  console.log(line);
}
console.log("");

// 1. Ensure PostgreSQL + NATS are running (sets DATABASE_URL, NATS_URL)
await ensureServices();
process.env.DECO_CLI = "1";

// 2. Run migrations
const migrate = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "migrate"], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});
const migrateCode = await migrate.exited;
if (migrateCode !== 0) {
  console.error("Migration failed");
  process.exit(migrateCode);
}

// 3. Start dev servers (client + server concurrently)
const servers = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

process.on("SIGINT", () => servers.kill("SIGINT"));
process.on("SIGTERM", () => servers.kill("SIGTERM"));

const code = await servers.exited;
process.exit(code);
