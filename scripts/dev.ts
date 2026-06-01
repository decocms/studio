#!/usr/bin/env bun
/**
 * Dev entry point — thin wrapper that delegates to the CLI `dev` subcommand.
 *
 * Called by `bun run dev` from the monorepo root.
 */
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

const child = Bun.spawn(
  [
    "bun",
    "run",
    join(repoRoot, "apps/mesh/src/cli.ts"),
    "dev",
    "--local-sandbox-provider",
    ...process.argv.slice(2),
  ],
  {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
    },
  },
);

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

const code = await child.exited;
process.exit(code);
