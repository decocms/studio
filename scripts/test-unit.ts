#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const repoRoot = join(import.meta.dir, "..");
const testRoots = [
  "apps/api/src",
  "apps/api/migrations",
  "apps/web/src",
  "packages",
  "plugins",
  "scripts",
];
const skippedDirectories = new Set([".git", "dist", "node_modules"]);

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

const testFiles = (
  await Promise.all(testRoots.map((root) => collectUnitTests(root)))
)
  .flat()
  .sort();

console.log(`Running ${testFiles.length} isolated unit test files...`);

for (const testFile of testFiles) {
  console.log(`\n▶ ${testFile}`);
  const child = Bun.spawn(["bun", "test", testFile], {
    cwd: repoRoot,
    stdio: ["inherit", "inherit", "inherit"],
  });
  const exitCode = await child.exited;
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
}
