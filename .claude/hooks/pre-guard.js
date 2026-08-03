#!/usr/bin/env bun
// PreToolUse guard: denies known-bad agent commands with a corrective message,
// and escalates knip config edits to the human (Gotcha #6 in CLAUDE.md).

const input = await Bun.stdin.json();

const toolName = input.tool_name;
const toolInput = input.tool_input || {};
const cwd = input.cwd || "";
const projectDir = process.env.CLAUDE_PROJECT_DIR || "";

function decide(permissionDecision, permissionDecisionReason) {
  console.log(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision,
        permissionDecisionReason,
      },
    }),
  );
  process.exit(0);
}

// --- knip config edits: ask the human (Gotcha #6) ---
if (["Write", "Edit", "MultiEdit"].includes(toolName)) {
  const filePath = toolInput.file_path || "";
  if (/(^|\/)knip\.(jsonc?|config\.[jt]s)$/.test(filePath)) {
    decide(
      "ask",
      "Gotcha #6: never edit the knip config to silence warnings — delete the dead code/export/dependency instead. If this is a legitimate change (e.g. a new workspace entry point), ask the user to approve.",
    );
  }
  process.exit(0);
}

if (toolName !== "Bash" || !toolInput.command) {
  process.exit(0);
}

// Simple shell parsing: split on spaces respecting quotes, strip inline env prefixes.
let tokens = (
  toolInput.command.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
).map((t) => t.replace(/^['"]|['"]$/g, ""));
while (
  tokens.length &&
  /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[0]) &&
  !tokens[0].includes("/")
) {
  tokens = tokens.slice(1);
}
if (tokens.length === 0) {
  process.exit(0);
}
const argv0 = tokens[0].split("/").pop();
const args = tokens.slice(1);

// --- `git push` to main/master ---
if (argv0 === "git" && args.includes("push")) {
  const pushesMain = args.some(
    (a) => a === "main" || a === "master" || /^[^-].*:(main|master)$/.test(a),
  );
  if (pushesMain) {
    decide(
      "deny",
      "error: Don't push to main directly. Create a branch and open a PR (see CLAUDE.md commit guidelines).",
    );
  }
}

// --- bare `bun test` from the repo root runs the entire monorepo suite ---
if (argv0 === "bun") {
  const positional = args.filter((a) => !a.startsWith("-"));
  if (positional[0] === "test") {
    const hasPath = positional
      .slice(1)
      .some((a) => a.includes("/") || a.includes(".test."));
    const atRepoRoot = !projectDir || cwd === projectDir || cwd === "";
    if (!hasPath && atRepoRoot) {
      decide(
        "deny",
        "error: Bare `bun test` from the repo root runs every unit test in the monorepo. Run `bun test <path/to/file.test.ts>` for the files you touched instead.",
      );
    }
  }
}

process.exit(0);
