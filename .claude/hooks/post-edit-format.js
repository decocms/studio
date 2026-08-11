#!/usr/bin/env bun
// PostToolUse hook: format each edited file with Biome so agent commits never
// need a formatting follow-up. Fail-open — formatting must never block edits.
import { spawnSync } from "node:child_process";
import { extname } from "node:path";

const input = await Bun.stdin.json();

const filePath = (input.tool_input || {}).file_path;
if (!filePath || !["Write", "Edit", "MultiEdit"].includes(input.tool_name)) {
  process.exit(0);
}

const BIOME_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".json",
  ".jsonc",
  ".css",
];
// Fail-open, but never silently: spawnSync returns ENOENT in `result.error`
// rather than throwing, so a missing node_modules used to no-op every edit.
// Surface it instead of falling back to `bunx biome` — that resolves a
// different version than the repo pins, and CI would disagree with it.
function warn(message) {
  console.log(
    JSON.stringify({ systemMessage: `post-edit-format: ${message}` }),
  );
  process.exit(0);
}

if (BIOME_EXTENSIONS.includes(extname(filePath))) {
  const result = spawnSync(
    "./node_modules/.bin/biome",
    ["format", "--write", filePath],
    {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      encoding: "utf-8",
    },
  );
  if (result.error?.code === "ENOENT") {
    warn(
      "biome is not installed — run `bun install`. Files are NOT formatted.",
    );
  }
  if (result.error) {
    warn(`biome failed to run (${result.error.message}).`);
  }
  // A path ignored by biome.json (gitignored, dist/) also prints "provided but
  // ignored", so key off the diagnostic count instead — it only appears on a
  // real failure, such as the parse errors that abort formatting.
  const output = `${result.stdout || ""}${result.stderr || ""}`;
  if (/Found \d+ error/.test(output)) {
    warn(
      `biome could not format ${filePath} — ${output.match(/Found \d+ error\w*/)[0]}, likely a syntax error. The file is NOT formatted.`,
    );
  }
}

process.exit(0);
