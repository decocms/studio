#!/usr/bin/env bun
/**
 * Dev entry point: ensures services are running, then runs migrations
 * and starts the mesh dev servers.
 *
 * Called by `bun run dev` from the monorepo root.
 */
import { createConnection } from "net";
import { join } from "path";
import {
  ASCII_ART,
  bold,
  cyan,
  dim,
  green,
  row,
  section,
  underline,
} from "../apps/mesh/src/fmt.ts";
import { ensureServices } from "./dev-services.ts";

const repoRoot = join(import.meta.dir, "..");

// Banner
console.log("");
for (const line of ASCII_ART) {
  console.log(line);
}
console.log("");

// Services
const services = await ensureServices({ quiet: true });

console.log(section("Services"));
for (const s of services) {
  const details: string[] = [s.state];
  if (s.pid) details.push(`pid ${s.pid}`);
  details.push(`:${s.port}`);
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
const port = env.PORT;
const url = env.BASE_URL || `http://localhost:${port}`;

const servers = Bun.spawn(["bun", "run", "--cwd=apps/mesh", "dev:servers"], {
  cwd: repoRoot,
  env: process.env,
  stdio: ["inherit", "inherit", "inherit"],
});

// Wait for server to be ready
function waitForPort(p: number, timeoutMs = 30_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const sock = createConnection({ port: p, host: "localhost" });
      sock.once("connect", () => {
        sock.destroy();
        resolve();
      });
      sock.once("error", () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for port ${p}`));
        } else {
          setTimeout(check, 200);
        }
      });
      sock.setTimeout(1000, () => {
        sock.destroy();
        if (Date.now() - start > timeoutMs) {
          reject(new Error(`Timed out waiting for port ${p}`));
        } else {
          setTimeout(check, 200);
        }
      });
    };
    check();
  });
}

waitForPort(port).then(() => {
  console.log("");
  console.log(`${green("✓")} ${bold("Ready")}`);
  console.log("");
  console.log(`  ${dim("Open in browser:")}  ${cyan(underline(url))}`);
  console.log("");
});

process.on("SIGINT", () => servers.kill("SIGINT"));
process.on("SIGTERM", () => servers.kill("SIGTERM"));

const code = await servers.exited;
process.exit(code);
