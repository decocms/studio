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

  // --- multi-line comments: same heuristic as CI's Comment Cop, but at edit time ---
  const rel =
    projectDir && filePath.startsWith(`${projectDir}/`)
      ? filePath.slice(projectDir.length + 1)
      : filePath;
  if (
    /^(apps|packages|plugins)\//.test(rel) &&
    /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/.test(rel)
  ) {
    const isCommentLine = (line) => {
      const t = line.trimStart();
      return (
        t.startsWith("//") ||
        t.startsWith("/*") ||
        t === "*" ||
        t === "*/" ||
        t.startsWith("* ")
      );
    };
    // Consecutive comment runs of 2+ lines, skipping /** doc blocks.
    const commentGroups = (text) => {
      const out = [];
      let cur = [];
      for (const line of `${text ?? ""}\n`.split("\n")) {
        if (isCommentLine(line)) {
          cur.push(line);
        } else {
          if (cur.length >= 2 && !cur[0].trimStart().startsWith("/**")) {
            out.push(cur.join("\n"));
          }
          cur = [];
        }
      }
      return out;
    };
    const edits =
      toolName === "MultiEdit" ? toolInput.edits || [] : [toolInput];
    for (const e of edits) {
      const newText = toolName === "Write" ? e.content : e.new_string;
      const oldText = e.old_string ?? "";
      const added = commentGroups(newText).filter((g) => !oldText.includes(g));
      if (added.length > 0) {
        decide(
          "deny",
          `error: This edit adds a multi-line comment, which CI's Comment Cop will flag:\n\n${added[0]}\n\nA comment that takes a paragraph to justify a workaround is a signal the code is wrong, not the comment — fix the code so it doesn't need the explanation, or compress it to a single line stating only what the code can't show. Doc comments (/** ... */) are exempt.`,
        );
      }
    }
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
