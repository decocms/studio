#!/usr/bin/env bun
/**
 * Dev entry point: ensures services are running, then runs migrations
 * and starts the mesh dev servers.
 *
 * Called by `bun run dev` from the monorepo root.
 */
import { join } from "path";
import { ensureServices } from "./dev-services.ts";

const repoRoot = join(import.meta.dir, "..");

// 1. Ensure PostgreSQL + NATS are running (sets DATABASE_URL, NATS_URL)
await ensureServices();

// 2. Run migrations
console.log("\nRunning migrations...");
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
console.log("\nStarting dev servers...");
const servers = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

process.on("SIGINT", () => servers.kill("SIGINT"));
process.on("SIGTERM", () => servers.kill("SIGTERM"));

const code = await servers.exited;
process.exit(code);
