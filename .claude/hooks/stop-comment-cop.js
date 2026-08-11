#!/usr/bin/env bun
// Stop hook: scans the working-tree diff (any write mechanism — Edit, bash,
// python) for added multi-line comments and blocks the stop once so the model
// cleans them up (CLAUDE.md: fix the code, don't explain it away).

const input = await Bun.stdin.json();
if (input.stop_hook_active) process.exit(0);

const cwd = input.cwd || process.cwd();
const SRC_EXT = /\.(ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;

function isCommentLine(line) {
  const t = line.trimStart();
  return (
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t === "*" ||
    t === "*/" ||
    t.startsWith("* ")
  );
}

// Groups consecutive comment lines (2+, skipping /** doc blocks) from a list
// of { line, text } entries; a gap in line numbers breaks the group.
function flushInto(groups, cur) {
  if (cur.length >= 2 && !cur[0].text.trimStart().startsWith("/**")) {
    groups.push(cur);
  }
}

function groupAdded(entries) {
  const groups = [];
  let cur = [];
  for (const e of entries) {
    const prev = cur[cur.length - 1];
    if (isCommentLine(e.text) && (!prev || e.line === prev.line + 1)) {
      cur.push(e);
    } else {
      flushInto(groups, cur);
      cur = isCommentLine(e.text) ? [e] : [];
    }
  }
  flushInto(groups, cur);
  return groups;
}

function git(args) {
  const p = Bun.spawnSync(["git", ...args], { cwd });
  return p.exitCode === 0 ? p.stdout.toString() : "";
}

const offenders = [];

// Tracked changes: parse added lines out of the unified diff.
{
  const diff = git([
    "diff",
    "HEAD",
    "--unified=0",
    "--",
    "apps",
    "packages",
    "plugins",
  ]);
  let file = null;
  let newLine = 0;
  let entries = [];
  const flushFile = () => {
    if (file && SRC_EXT.test(file)) {
      for (const g of groupAdded(entries)) offenders.push({ file, group: g });
    }
    entries = [];
  };
  for (const raw of diff.split("\n")) {
    if (raw.startsWith("+++ b/")) {
      flushFile();
      file = raw.slice(6);
    } else if (raw.startsWith("@@")) {
      const m = /\+(\d+)/.exec(raw);
      newLine = m ? parseInt(m[1], 10) : 1;
    } else if (raw.startsWith("+")) {
      entries.push({ line: newLine, text: raw.slice(1) });
      newLine++;
    }
  }
  flushFile();
}

// Untracked files: git diff HEAD doesn't see them; scan full content.
{
  const untracked = git([
    "ls-files",
    "--others",
    "--exclude-standard",
    "--",
    "apps",
    "packages",
    "plugins",
  ])
    .split("\n")
    .filter((f) => f && SRC_EXT.test(f));
  for (const file of untracked) {
    const text = await Bun.file(`${cwd}/${file}`)
      .text()
      .catch(() => "");
    const entries = text
      .split("\n")
      .map((t, i) => ({ line: i + 1, text: t }));
    for (const g of groupAdded(entries)) offenders.push({ file, group: g });
  }
}

if (offenders.length === 0) process.exit(0);

const shown = offenders
  .slice(0, 3)
  .map(
    (o) =>
      `${o.file}:${o.group[0].line}-${o.group[o.group.length - 1].line}\n${o.group.map((e) => e.text).join("\n")}`,
  )
  .join("\n\n");
const more =
  offenders.length > 3 ? `\n\n(+${offenders.length - 3} more)` : "";

console.log(
  JSON.stringify({
    decision: "block",
    reason: `The working-tree diff adds multi-line comment(s):\n\n${shown}${more}\n\nA comment that takes a paragraph to justify a workaround is a signal the code is wrong, not the comment — fix the code so it doesn't need the explanation, or compress each to a single line stating only what the code can't show. Doc comments (/** ... */) are exempt. If a flagged comment was written by the user and must stay, leave it — this check will not re-fire on the next stop.`,
  }),
);
