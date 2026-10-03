#!/usr/bin/env bun
/**
 * Copies the Blocks content protocol (`@decocms/blocks/protocol`) into
 * `packages/shared/src/vendor/blocks-protocol/` until `@decocms/blocks@8` is
 * published. See that folder's SYNC.md.
 *
 *   bun run scripts/sync-blocks-protocol.ts <path-to-blocks-checkout> <commit>
 *
 * Copies the tree at `<commit>` (not the working tree), leaves out the
 * Node-only filesystem storage and the tests, inlines the SDK leaf modules the
 * protocol re-exports from outside its folder, renames files to kebab-case
 * (this repo's file-name rule) with their relative imports, formats, and
 * points SYNC.md at the commit.
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";

const SOURCE_DIR = "packages/blocks/src/protocol";
const repoRoot = join(import.meta.dir, "..");
const targetDir = join(repoRoot, "packages/shared/src/vendor/blocks-protocol");
const syncNote = join(targetDir, "SYNC.md");

function excluded(path: string): boolean {
  return (
    path.startsWith("storage/fs/") ||
    path.startsWith("__tests__/") ||
    /\.test\.ts$/.test(path)
  );
}

const kebab = (segment: string) =>
  segment.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const kebabPath = (path: string) => path.split("/").map(kebab).join("/");

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")}: ${result.stderr.toString()}`);
  }
  return result.stdout.toString();
}

/**
 * A top-level protocol file may re-export a dependency-free SDK module from
 * outside the folder (`export * from "../v8/canonical"`): the module's own
 * source replaces that line, since the folder above isn't vendored.
 */
function inlineOutsideReExports(
  source: string,
  read: (srcPath: string) => string,
): string {
  return source.replace(
    /^export \* from "\.\.\/([^"]+)";$/gm,
    (_match, specifier: string) => read(`packages/blocks/src/${specifier}.ts`),
  );
}

/** Rewrites relative import specifiers to the kebab-case file names. */
function rewriteImports(source: string): string {
  return source.replace(
    /(from\s+|import\s*\(\s*)"(\.{1,2}\/[^"]+)"/g,
    (_match, prefix: string, specifier: string) =>
      `${prefix}"${posix.normalize(kebabPath(specifier)).replace(/^(?!\.)/, "./")}"`,
  );
}

async function main() {
  const [checkout, commit] = process.argv.slice(2);
  if (!checkout || !commit) {
    console.error(
      "usage: bun run scripts/sync-blocks-protocol.ts <blocks-checkout> <commit>",
    );
    process.exit(1);
  }
  const sha = git(checkout, ["rev-parse", commit]).trim();
  const files = git(checkout, [
    "ls-tree",
    "-r",
    "--name-only",
    sha,
    `${SOURCE_DIR}/`,
  ])
    .split("\n")
    .filter(Boolean)
    .map((path) => path.slice(SOURCE_DIR.length + 1))
    .filter((path) => path.endsWith(".ts") && !excluded(path));

  const note = await Bun.file(syncNote).text();
  await rm(targetDir, { recursive: true, force: true });
  for (const path of files) {
    const raw = git(checkout, ["show", `${sha}:${SOURCE_DIR}/${path}`]);
    const source = path.includes("/")
      ? raw
      : inlineOutsideReExports(raw, (srcPath) =>
          git(checkout, ["show", `${sha}:${srcPath}`]),
        );
    const target = join(targetDir, kebabPath(path));
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, rewriteImports(source));
  }
  await writeFile(
    syncNote,
    note.replace(/at commit `[0-9a-f]+`/, `at commit \`${sha}\``),
  );
  const format = Bun.spawnSync(
    ["bunx", "biome", "format", "--write", targetDir],
    {
      cwd: repoRoot,
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  if (format.exitCode !== 0) process.exit(format.exitCode ?? 1);
  console.log(`synced ${files.length} files from ${sha}`);
}

await main();
