/**
 * The opening USER message of every agent run dispatched from a task board
 * card — org-configurable, as a `{{var}}` template.
 *
 * The default IS what the prompt has always been; an org that never opens the
 * settings page gets byte-identical behaviour. The dynamic parts the builder
 * used to interpolate inline are the variables below, so an org can shrink the
 * prompt to `{{taskTitle}}` (its own harness rules live in the system prompt)
 * or reorder it, without a deploy.
 *
 * Shared because both ends need it: the API renders it, the settings page
 * shows the default and offers "reset to default".
 */

/**
 * Every variable the renderer substitutes.
 *
 * Names only: what each one MEANS is user-facing copy, so it lives in the web
 * app's dictionaries (`settings.boardColumns.var.*`) where it can be
 * translated, not in a string here that would render English in every locale.
 */
export const TASK_INITIAL_PROMPT_VAR_NAMES = [
  "instruction",
  "taskTitle",
  "taskDescription",
  "taskId",
  "jiraId",
  "jiraUrl",
  "repoContext",
  "prBullet",
  "prContext",
] as const;

export type TaskInitialPromptVar =
  (typeof TASK_INITIAL_PROMPT_VAR_NAMES)[number];
export type TaskInitialPromptVars = Record<TaskInitialPromptVar, string>;

/**
 * The prompt as it stood before it was configurable. Guidance tuned from
 * observed runs — the comments explaining each line live at the call site in
 * `claude-code-task-run.ts`, since that is where they were earned.
 */
// prompt-region:start super-agent-sandbox
export const DEFAULT_TASK_INITIAL_PROMPT = `{{instruction}}

You are running AUTONOMOUSLY — no human is watching, so drive this to completion yourself. Make reasonable decisions and move on; do not stop to ask for confirmation.

Title: {{taskTitle}}

{{taskDescription}}

{{repoContext}}

{{prContext}}

How to finish:
{{prBullet}}
- Change only what the task needs. Don't refactor around it.
- The change must be REACHABLE from the surface the task names: edit the component that route actually renders, not one that merely looks like the right place. A change nothing imports is dead code, and it is the most common reason a task comes back rejected.
- Before handing over, VERIFY the task's outcome LOCALLY, in the sandbox: exercise the affected code path and confirm the behaviour actually happens. A green test suite is not the bar. Do NOT wait for, or verify against, the PR's deploy preview — a reviewer checks that after you hand over.
- Nothing is installed and NO dev server is running — this sandbox is a checkout. Usually you don't need one: read the code path end to end, run the repo's tests, and \`curl\` the LIVE site for how it behaves today. Only start a dev server if you must see YOUR change rendered — it is a cold start, so expect several minutes: launch it ONCE in the background and poll until it answers rather than guessing a sleep.
- For a VISUAL change that means LOOKING at it: \`qa-screenshot <url> <path>.png [--mobile] [--full] [--selector=<css>]\` renders the page in headless Chromium — it reaches a dev server you started on localhost as well as any public URL, and unlike \`curl\` it runs the page's JS, so lazily-rendered sections are actually there. Then \`Read\` the file: a screenshot you never opened is not verification. It is already installed; do NOT look for playwright in the repo's \`node_modules\`. To INTERACT with a page — click, hit-test with \`document.elementFromPoint\`, fill a form — write a throwaway node script that requires the global playwright-core: \`const { chromium } = require("/usr/local/lib/node_modules/playwright-core"); chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] })\`. Screenshots alone are not the limit of what you can check.
- As soon as \`gh pr create\` prints the URL, call \`mcp__studio__TASK_BOARD_ITEM_PR_LINK\` with that url. Do this even if you also mention the PR in a comment — the reviewers are dispatched from the linked PR, not from your message.
- If the task turns out to need no code change, do NOT open a PR: explain why in a comment on the task (\`mcp__studio__TASK_BOARD_COMMENT_CREATE\`) and move it to "done". There is nothing for a reviewer to review, so leaving it for one would strand it.
- Anything a reviewer should know (a decision you made, something you found and deliberately left alone, a question) goes on the task as a comment: \`mcp__studio__TASK_BOARD_COMMENT_CREATE\` with taskBoardItemId "{{taskId}}". Read what's already there first with \`mcp__studio__TASK_BOARD_COMMENT_LIST\` — a comment may be addressed to you.

(task id: {{taskId}})`;
// prompt-region:end super-agent-sandbox

/** The opening line a run gets when its column's rule names no other. */
export const DEFAULT_TASK_INSTRUCTION =
  "You've been assigned this task. Complete it and finish with a pull request " +
  "if it makes sense (like a coding task) or is explicitly requested.";

/**
 * Render `template` with `vars`.
 *
 * An UNKNOWN `{{name}}` is left verbatim rather than blanked: a typo the org
 * can see in a run's first message is fixable, one that silently vanished is
 * not. A variable that renders EMPTY (no description, a first attempt) takes
 * its own separating blank line with it, so it leaves no hole — but only its
 * own: a substituted value keeps whatever blank lines the card actually wrote,
 * which a global collapse would rewrite.
 */
export function renderTaskInitialPrompt(
  template: string,
  vars: TaskInitialPromptVars,
): string {
  const out: string[] = [];
  const pattern = /\{\{\s*(\w+)\s*\}\}/g;
  let last = 0;
  for (let match; (match = pattern.exec(template)) !== null; ) {
    const name = match[1]!;
    if (!Object.hasOwn(vars, name)) continue;
    const value = vars[name as TaskInitialPromptVar];
    out.push(template.slice(last, match.index), value);
    last = match.index + match[0].length;
    if (value) continue;
    const gap = /^\n[ \t]*\n|^\n/.exec(template.slice(last));
    if (gap) last += gap[0].length;
  }
  out.push(template.slice(last));
  return out.join("").trim();
}

/** The Jira issue key in a `{site}/browse/{KEY}` issue URL, or "". */
export function jiraKeyFromUrl(externalUrl: string | null): string {
  return externalUrl?.match(/\/browse\/([A-Z][A-Z0-9_]*-\d+)/i)?.[1] ?? "";
}
