#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const testRoots = [
  "apps/api/src",
  "apps/api/migrations",
  "apps/native/scripts",
  "apps/web/src",
  "packages",
  "plugins",
  "scripts",
];
const skippedDirectories = new Set([".git", "dist", "node_modules"]);

export function buildUnitTestCommand(
  testFiles: readonly string[],
  timingsFile?: string,
): string[] {
  const command = ["bun", "test", "--parallel"];

  if (timingsFile) {
    command.push(`--timings=${timingsFile}`, "--update-timings");
  }

  command.push(...testFiles);
  return command;
}

async function collectUnitTests(directory: string): Promise<string[]> {
  const entries = await readdir(join(repoRoot, directory), {
    withFileTypes: true,
  });
  const files: string[] = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (!skippedDirectories.has(entry.name)) {
        files.push(...(await collectUnitTests(path)));
      }
      continue;
    }
    if (
      entry.isFile() &&
      /\.test\.tsx?$/.test(entry.name) &&
      !/\.(?:integration|e2e)\.test\.tsx?$/.test(entry.name)
    ) {
      files.push(relative(repoRoot, join(repoRoot, path)));
    }
  }

  return files;
}

async function main(): Promise<number> {
  const testFiles = (
    await Promise.all(testRoots.map((root) => collectUnitTests(root)))
  )
    .flat()
    .sort();

  console.log(`Running ${testFiles.length} isolated unit test files...`);

  // --parallel implies --isolate: each file gets a fresh global object and
  // module registry across a pool of reused worker processes (one per core), so
  // the per-file isolation this tier requires holds without spawning a process
  // per file. Positional args are filters; exact relative paths match only
  // themselves, which is how the tier's filename-based exclusions stay applied.
  const command = buildUnitTestCommand(
    testFiles,
    process.env.BUN_TEST_TIMINGS_FILE,
  );
  const child = Bun.spawn(command, {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  return child.exited;
}

if (import.meta.main) {
  process.exit(await main());
}
