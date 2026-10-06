import type { TaskBoardPrompt } from "./task-board-prompts";

/**
 * What a lane carries until the org edits it. To Do is what the Super Agent
 * follows when it picks a card up; In Progress is what the reviewer follows,
 * since it runs while the card is still In Progress. Only policy lives here —
 * the facts and tool contracts a run needs to finish stay in the prompt
 * builders, where a person's edit can't break them.
 */
export const DEFAULT_BOARD_PROMPTS: TaskBoardPrompt[] = [
  {
    columnKey: "todo",
    prompt: [
      "- Change only what the task needs. Don't refactor around it.",
      "- The change must be REACHABLE from the surface the task names: edit the component that route actually renders, not one that merely looks like the right place. A change nothing imports is the most common reason a task comes back rejected.",
      "- Before handing over, VERIFY the task's outcome LOCALLY, in the sandbox: exercise the affected code path and confirm the behaviour actually happens. A green test suite is not the bar. Do NOT wait for, or verify against, the PR's deploy preview — a reviewer checks that after you hand over.",
      "- For a visual change, screenshot it and embed the shots in your task comment.",
    ].join("\n"),
    skills: ["core/qa-screenshot"],
  },
  {
    columnKey: "in_progress",
    prompt: [
      "Confirm the task ACTUALLY SOLVED THE PROBLEM, fix what is wrong with how it was solved, then ship or hand over. Nothing picks up findings you only describe, so an issue you write down and leave is an issue that ships. Work in THIS ORDER:",
      "1. REVIEW the code. First look for a review skill or command that fits this repository's stack (a `code-review` or `security-review` skill, or the repo's CONTRIBUTING/review guidelines) and use it. Read the diff for correctness, security and quality, and note concrete issues with file/line references.",
      "2. FIX what you found on the PR's own branch and push to that same pull request. Keep fixes scoped to what your review found; don't redesign the change. Before you push, run the repository's own checks (type-check, lint, test, format) and make them pass. If a fix doesn't hold, revert it and describe it instead.",
      "3. EXERCISE the change AFTER your push, on the code you pushed. If the PR has a deploy preview, use it: wait for it if it's still building and deep-link to the page the task affects. If the repository deploys no preview (a mobile app, a library, a CLI), build and serve it in the sandbox and drive it there — no preview is not grounds to request changes. Check the acceptance criteria implied by the title and description and look for regressions in the affected flow. Judge outcomes, not the diff: never approve on inspection alone. For a visual change capture BEFORE (production / base branch) and AFTER (yours); for a responsive one, desktop and mobile. If you can't exercise the change at all, don't approve: request changes saying which paths you tried and what blocked them.",
      "4. RECORD the pass in your task comment: the issues found (file/line), which you fixed (with commits), each scenario you exercised with pass/fail, the exact URL(s) and viewport, and anything you couldn't verify and why.",
      "5. DECIDE. Approve once the pull request is in the state you would approve. Request changes only for what you genuinely can't settle here (a product decision, a missing credential, an approach that needs rethinking).",
    ].join("\n"),
    skills: ["core/qa-screenshot"],
  },
];
