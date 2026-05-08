#!/usr/bin/env bun
/**
 * Dev entry point — thin wrapper that delegates to the CLI `dev` subcommand.
 *
 * Called by `bun run dev` from the monorepo root.
 */
import { join } from "path";

const repoRoot = join(import.meta.dir, "..");

// Hot-reload the sandbox daemon: Docker runner bind-mounts this dir over
// `/opt/sandbox-daemon` and runs it under `node --watch`. No rebuild needed.
const sandboxDaemonDir = join(repoRoot, "packages/@decocms/sandbox/image");

const child = Bun.spawn(
  [
    "bun",
    "run",
    join(repoRoot, "apps/mesh/src/cli.ts"),
    "dev",
    ...process.argv.slice(2),
  ],
  {
    stdio: ["inherit", "inherit", "inherit"],
    env: {
      ...process.env,
      STUDIO_SANDBOX_DEV_DAEMON_DIR:
        process.env.STUDIO_SANDBOX_DEV_DAEMON_DIR ?? sandboxDaemonDir,
    },
  },
);

process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));

const code = await child.exited;
process.exit(code);
