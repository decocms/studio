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
if (BIOME_EXTENSIONS.includes(extname(filePath))) {
  try {
    spawnSync("./node_modules/.bin/biome", ["format", "--write", filePath], {
      cwd: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
      encoding: "utf-8",
    });
  } catch {}
}

process.exit(0);
