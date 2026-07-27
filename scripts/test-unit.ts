#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
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

// One bun process per file keeps the isolation guarantee; a worker pool keeps
// the wall clock at max(slowest file, total / cores) instead of the serial sum.
const concurrency = Math.min(availableParallelism(), testFiles.length);
console.log(
  `Running ${testFiles.length} isolated unit test files (concurrency ${concurrency})...`,
);

let nextIndex = 0;
const failures: string[] = [];

async function worker(): Promise<void> {
  while (nextIndex < testFiles.length) {
    const testFile = testFiles[nextIndex++];
    if (!testFile) break;
    const child = Bun.spawn(["bun", "test", testFile], {
      cwd: repoRoot,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (exitCode === 0) {
      console.log(`✓ ${testFile}`);
    } else {
      failures.push(testFile);
      console.error(`\n✗ ${testFile}\n${stdout}${stderr}`);
    }
  }
}

await Promise.all(Array.from({ length: concurrency }, worker));

if (failures.length > 0) {
  console.error(`\n${failures.length} test file(s) failed:`);
  for (const file of failures) {
    console.error(`  ✗ ${file}`);
  }
  process.exit(1);
}
