#!/usr/bin/env bun

import { cp, rm } from "node:fs/promises";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..");

async function run(label: string, command: string[]): Promise<void> {
  console.log(`Building ${label}...`);
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    throw new Error(`${label} build exited with code ${exitCode}`);
  }
}

await run("Studio web", ["bun", "run", "--cwd=apps/web", "build"]);
await run("Studio API", ["bun", "run", "--cwd=apps/api", "build:server"]);

const webDist = join(repoRoot, "apps/web/dist");
const bundledClient = join(repoRoot, "apps/api/dist/client");

await rm(bundledClient, { recursive: true, force: true });
await cp(webDist, bundledClient, { recursive: true });

console.log("Studio distribution assembled at apps/api/dist.");
