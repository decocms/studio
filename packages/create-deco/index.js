#!/usr/bin/env node

/**
 * create-deco
 *
 * Scaffolds a new MCP app from the decocms/mcp-app template.
 * Usage: npm create deco <project-name>
 */

const { spawn } = require("child_process");

const args = process.argv.slice(2);
const projectName = args[0];

if (!projectName) {
  console.error("Usage: npm create deco <project-name>");
  process.exit(1);
}

const child = spawn("npx", ["decocms", "init", projectName], {
  stdio: "inherit",
  cwd: process.cwd(),
});

child.on("close", (code) => {
  process.exit(code || 0);
});

child.on("error", (error) => {
  console.error("Error:", error.message);
  process.exit(1);
});
