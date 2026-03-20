#!/usr/bin/env bun
import { homedir } from "os";
import { join } from "path";
import { startWorktree } from "worktree-devservers";
import {
  ASCII_ART,
  cyan,
  dim,
  row,
  section,
  underline,
} from "../apps/mesh/src/fmt.ts";
import { ensureServices } from "./dev-services.ts";
import { loadDotEnv } from "./load-dot-env.ts";

const slug = process.env.WORKTREE_SLUG;
if (!slug) {
  console.error("WORKTREE_SLUG environment variable is required.");
  process.exit(1);
}

// Print banner before startWorktree so it appears above any external output
console.log("");
for (const line of ASCII_ART) {
  console.log(line);
}
console.log("");
console.log(
  `  ${dim("Open in browser:")}  ${cyan(underline(`http://${slug}.localhost`))}`,
);
console.log("");

// Suppress noisy logs from worktree-devservers (e.g. "Cleaned stale route", "is live")
const _originalLog = console.log;
console.log = (...args: unknown[]) => {
  const msg = String(args[0] ?? "");
  if (msg.includes("is live") || msg.includes("Cleaned stale route")) return;
  _originalLog(...args);
};

startWorktree(slug, async (ctx) => {
  const port = await ctx.findFreePort(3000);
  const vitePort = await ctx.findFreePort(4000);

  const repoRoot = join(import.meta.dir, "..");
  const dotEnv = loadDotEnv(join(repoRoot, "apps/mesh/.env"));

  // Apply .env early so ensureServices() sees DATABASE_URL / NATS_URL
  for (const [key, value] of Object.entries(dotEnv)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }

  const decoHome =
    process.env.DATA_DIR || process.env.DECOCMS_HOME || join(homedir(), "deco");

  // Services
  const services = await ensureServices(decoHome);

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

  // Configuration — set env vars then import the config logger
  const childEnv = {
    ...process.env,
    ...dotEnv,
    PORT: String(port),
    VITE_PORT: String(vitePort),
    BASE_URL: `http://${ctx.slug}.localhost`,
    DECO_CLI: "1",
  };
  Object.assign(process.env, childEnv);

  const { logConfiguration, env } = await import("../apps/mesh/src/env.ts");
  logConfiguration(env);

  // Start dev servers (silent — all output handled above)
  const child = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
    cwd: repoRoot,
    env: childEnv,
    stdio: ["inherit", "inherit", "inherit"],
  });

  return { port, process: child };
}).catch((e) => {
  console.error("dev:worktree error:", e);
  process.exit(1);
});
