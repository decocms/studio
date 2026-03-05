#!/usr/bin/env bun
/**
 * Development environment setup script.
 *
 * Mirrors the CLI (src/cli.ts) behaviour so that `bun dev` and
 * `bunx decocms` / `deco` share the same ~/deco data directory, secrets,
 * and local-mode defaults.
 *
 * After setting up the environment it spawns the regular dev pipeline:
 *   bun run migrate && concurrently "bun run dev:client" "bun run dev:server"
 */

import { join } from "path";
import { spawn } from "child_process";

import {
  ansi,
  loadOrCreateSecrets,
  resolveMeshHome,
  printBanner,
  printStatus,
} from "./bootstrap";

// ============================================================================
// Resolve MESH_HOME
// ============================================================================

const meshAppDir = join(import.meta.dir, "..");
const userHome = join((await import("os")).homedir(), "deco");
// In CI / non-TTY without explicit MESH_HOME, use a repo-local directory
// so tests never touch the developer's real ~/deco data.
const ciHome = join(meshAppDir, ".mesh-dev");

const meshHome = await resolveMeshHome({
  explicit: process.env.MESH_HOME,
  defaultPath: userHome,
  ciFallback: ciHome,
  banner: `${ansi.bold}${ansi.cyan}Deco Studio${ansi.reset} ${ansi.dim}(dev)${ansi.reset}`,
});

// ============================================================================
// Secrets management
// ============================================================================

await loadOrCreateSecrets(meshHome);

// ============================================================================
// Set environment variables
// ============================================================================

process.env.MESH_HOME = meshHome;
process.env.DATABASE_URL =
  process.env.DATABASE_URL ?? `file:${join(meshHome, "mesh.db")}`;
process.env.MESH_LOCAL_MODE = process.env.MESH_LOCAL_MODE ?? "true";

// ============================================================================
// Banner
// ============================================================================

printBanner({
  meshHome,
  localMode: true,
  label: `Deco Studio ${ansi.dim}(dev)${ansi.reset}`,
});

printStatus({
  meshHome,
  localMode: true,
  baseUrl: process.env.BASE_URL,
});

// ============================================================================
// Spawn the dev pipeline
// ============================================================================

const child = spawn(
  "bun",
  [
    "run",
    "migrate",
    "&&",
    "concurrently",
    '"bun run dev:client"',
    '"bun run dev:server"',
  ],
  {
    stdio: "inherit",
    shell: true,
    env: process.env,
    cwd: meshAppDir,
  },
);

child.on("exit", (code) => {
  process.exit(code ?? 0);
});
