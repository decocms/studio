#!/usr/bin/env bun
/**
 * Dev entry point: ensures services are running, then runs migrations
 * and starts the mesh dev servers.
 *
 * Called by `bun run dev` from the monorepo root.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { ASCII_ART, row, section } from "../apps/mesh/src/fmt.ts";
import { ensureServices } from "./dev-services.ts";

const repoRoot = join(import.meta.dir, "..");

// Load apps/mesh/.env early so ensureServices() and migrations see the
// correct DATABASE_URL / NATS_URL before any module evaluates process.env.
function loadDotEnv(path: string): Record<string, string> {
  try {
    const result: Record<string, string> = {};
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const idx = trimmed.indexOf("=");
      if (idx === -1) continue;
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed
        .slice(idx + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
      result[key] = val;
    }
    return result;
  } catch {
    return {};
  }
}

const dotEnv = loadDotEnv(join(repoRoot, "apps/mesh/.env"));
for (const [key, value] of Object.entries(dotEnv)) {
  if (!(key in process.env)) {
    process.env[key] = value;
  }
}

// Banner
console.log("");
for (const line of ASCII_ART) {
  console.log(line);
}
console.log("");

// Services
const services = await ensureServices();

console.log(section("Services"));
for (const s of services) {
  const details: string[] = [s.state];
  if (s.pid) details.push(`pid ${s.pid}`);
  if (s.owner !== "external") details.push(`:${s.port}`);
  details.push(s.owner);
  console.log(row(s.name, details.join(" · ")));
}

// Migrations
try {
  const { migrateToLatest } = await import(
    "../apps/mesh/src/database/migrate.ts"
  );
  const result = await migrateToLatest();

  console.log(section("Migrations"));
  console.log(
    row(
      "Kysely",
      result.kysely > 0 ? `${result.kysely} applied` : "up to date",
    ),
  );
  if (result.plugins > 0) {
    console.log(row("Plugins", `${result.plugins} applied`));
  }
  console.log(row("Better Auth", result.betterAuth));
} catch (error) {
  console.error("Migration failed:", error);
  process.exit(1);
}

// Configuration
const { logConfiguration, env } = await import("../apps/mesh/src/env.ts");
logConfiguration(env);

// Start dev servers (silent — all output handled above)
process.env.DECO_CLI = "1";

const servers = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

process.on("SIGINT", () => servers.kill("SIGINT"));
process.on("SIGTERM", () => servers.kill("SIGTERM"));

const code = await servers.exited;
process.exit(code);
