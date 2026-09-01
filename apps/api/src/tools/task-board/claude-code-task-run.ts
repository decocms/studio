/**
 * Running a delegated task with the sandbox-hosted `claude-code` harness.
 *
 * Two ways in, depending on whether "which repo" has one answer:
 *
 * - Exactly ONE importable REPOSITORY in the org (not the same as one
 *   connection — see `pickSoleTaskRepo`): the repo is decided here, bound to the
 *   thread before dispatch, and the pod boots with the checkout already in it.
 *   Nothing to ask, nothing to wait for.
 * - SEVERAL repos: the run is dispatched with no repo, on the bare `thread:<id>`
 *   sandbox key, and picks one with `TASK_ADD_REPO` — which clones into the pod
 *   the agent loop is already running in. This is NOT `load_repo`'s trick (that
 *   one provisions a different sandbox, which is useless to a harness whose bash
 *   runs inside this one).
 *
 * Either way the harness must never be handed a prompt that says "open a PR"
 * with no repo and no way to get one: with no repos imported at all, the task
 * falls back to Decopilot.
 */

import type { StudioContext } from "@/core/studio-context";
import { selectLoadableRepos } from "@/harnesses/decopilot/built-in-tools/load-repo";
import { isOrgSharedConnection } from "@decocms/shared/github-repo-scope";
import { SHALLOW_CHECKOUT_NOTE } from "@decocms/shared/task-board";
import { agentSandboxEnabled } from "@/settings";
import type { SuperAgentPromptOpts } from "./enqueue-super-agent";
import {
  sandboxUploadHint,
  uploadsAsSandboxPaths,
} from "./description-uploads";

/** The repo a claude-code task run works in. */
export interface TaskRepo {
  connectionId: string;
  owner: string;
  name: string;
  installationId: number;
  url: string;
}

/** The connection shape the repo pick needs (mirrors `selectLoadableRepos`). */
type RepoConnection = {
  id: string;
  status: string;
  metadata: Record<string, unknown> | null;
};

/** GitHub treats owner/repo case-insensitively; the identity key must too. */
const repoKey = (owner: string, repo: string) =>
  `${owner}/${repo}`.toLowerCase();

/**
 * The org's single importable repo, or null when the answer is ambiguous.
 *
 * "Single" counts REPOSITORIES, not connections. Importing one repo routinely
 * leaves TWO loadable `mcp-github` children behind — the org-shared one and a
 * per-agent import — both pointing at the same repository. Counting connections
 * made a genuinely one-repo org look ambiguous and silently dropped every task
 * to Decopilot.
 *
 * When one repository is backed by several connections, the org-shared one
 * wins: the per-agent child is disposable (torn down with its agent), and the
 * clone only needs one of the two equivalent tokens.
 *
 * Pure, so the counting rule is unit-tested without a StudioContext.
 */
export function pickSoleTaskRepo(
  connections: RepoConnection[],
): TaskRepo | null {
  const byId = new Map(connections.map((c) => [c.id, c]));
  const byRepo = new Map<
    string,
    ReturnType<typeof selectLoadableRepos>[number][]
  >();
  for (const repo of selectLoadableRepos(connections)) {
    const key = repoKey(repo.owner, repo.repo);
    byRepo.set(key, [...(byRepo.get(key) ?? []), repo]);
  }
  if (byRepo.size !== 1) return null;

  const candidates = [...byRepo.values()][0]!;
  const chosen =
    candidates.find((c) => {
      const conn = byId.get(c.connectionId);
      return conn ? isOrgSharedConnection(conn) : false;
    }) ?? candidates[0]!;

  return {
    connectionId: chosen.connectionId,
    owner: chosen.owner,
    name: chosen.repo,
    installationId: chosen.installationId,
    url: `https://github.com/${chosen.owner}/${chosen.repo}`,
  };
}

/**
 * How a claude-code task run gets its repo, from the org's `mcp-github`
 * connections:
 * - `{ repo }` — one importable repository, bound before dispatch.
 * - `{ choices }` — several, so the run picks one with `TASK_ADD_REPO` mid-run.
 *   The list travels with the choice so the PROMPT can name the candidates: the
 *   model would otherwise open with a `TASK_ADD_REPO` call just to find out what
 *   exists, and a tool description can't carry them (it is built once at module
 *   load, with no org in scope).
 * - `null` — none imported (or the hosted sandbox this harness runs in is
 *   unavailable on this deployment), so this harness can't run the task at all.
 *
 * Never throws: a lookup failure degrades to the Decopilot path rather than
 * failing the delegation that already persisted. Both non-bound outcomes are
 * logged — "why did this task run Decopilot?" (or "why did it have to pick?")
 * is otherwise invisible. The availability check comes FIRST, before any
 * storage access: selecting claude-code while the sandbox capability is off
 * enqueues a run that fails only when dispatch starts — after quota was
 * claimed, the thread persisted, and reviewer bookkeeping began (#6502).
 */
export type TaskRepoChoice =
  | { repo: TaskRepo }
  | { choices: TaskRepoChoiceOption[] }
  | null;

/** One repository the run may clone, as the prompt names it. */
export interface TaskRepoChoiceOption {
  connectionId: string;
  /** `owner/name`. */
  repo: string;
}

export async function resolveTaskRepoChoice(
  ctx: StudioContext,
  organizationId: string,
): Promise<TaskRepoChoice> {
  if (!agentSandboxEnabled()) {
    console.warn(
      `[task-board] claude-code skipped for org ${organizationId}: ` +
        `hosted sandbox unavailable — running Decopilot`,
    );
    return null;
  }
  try {
    const { items } = await ctx.storage.connections.list(organizationId, {
      slug: "mcp-github",
    });
    const repo = pickSoleTaskRepo(items);
    if (repo) return { repo };
    // One entry per REPOSITORY: importing a repo routinely leaves two loadable
    // connections behind (org-shared + per-agent), and offering the same repo
    // twice reads as two different choices.
    const byRepo = new Map<string, TaskRepoChoiceOption>();
    for (const r of selectLoadableRepos(items)) {
      const key = repoKey(r.owner, r.repo);
      if (!byRepo.has(key)) {
        byRepo.set(key, {
          connectionId: r.connectionId,
          repo: `${r.owner}/${r.repo}`,
        });
      }
    }
    const distinct = byRepo;
    if (distinct.size === 0) {
      console.warn(
        `[task-board] claude-code skipped for org ${organizationId}: ` +
          `no importable repos — running Decopilot`,
      );
      return null;
    }
    console.warn(
      `[task-board] claude-code for org ${organizationId}: ` +
        `${distinct.size} importable repos — the run picks one with TASK_ADD_REPO`,
    );
    return { choices: [...distinct.values()] };
  } catch (err) {
    console.warn("[task-board] repo lookup for claude-code failed", err);
    return null;
  }
}

/**
 * The autonomous prompt for a claude-code task run. Pure, so the branch
 * selection is unit-tested.
 *
 * Deliberately shorter than the Decopilot prompt: most of that one exists to
 * steer tool choice ("prefer the GitHub tool", "don't hunt for the dev-server
 * port"). The harness has real `git` and `gh`, so the prompt only has to say
 * what "done" means — including the part Decopilot gets from its own tools and
 * this harness only has over MCP: moving the task on the board.
 *
 * `repo: null` is the several-repos case: the working directory is EMPTY and the
 * first instruction is to clone one. That has to be stated up front and
 * unambiguously — a model that starts by looking for files it was told exist
 * spends its first steps concluding the sandbox is broken.
 */
export function buildClaudeCodeTaskPrompt(
  task: { id: string; title: string; description: string | null },
  repo: TaskRepo | null,
  opts?: SuperAgentPromptOpts & { repoChoices?: TaskRepoChoiceOption[] },
): string {
  // prompt-region:start super-agent-sandbox
  const lines: string[] = [
    "You've been assigned this task. Complete it and finish with a pull request if it makes sense (like a coding task) or is explicitly requested.",
    "",
    "You are running AUTONOMOUSLY — no human is watching, so drive this to " +
      "completion yourself. Make reasonable decisions and move on; do not stop " +
      "to ask for confirmation.",
    "",
    `Title: ${task.title}`,
  ];
  if (task.description) {
    const description = uploadsAsSandboxPaths(task.description);
    lines.push("", "Description:", description);
    const hint = sandboxUploadHint(task.description, description);
    if (hint) {
      lines.push("", hint);
    }
  }
  lines.push(
    "",
    repo
      ? `The repository ${repo.owner}/${repo.name} is already cloned at your working directory, on its own branch. \`git\` and \`gh\` are authenticated. ${SHALLOW_CHECKOUT_NOTE}`
      : [
          "Your working directory is EMPTY: this organization has several repositories, so " +
            "nothing has been cloned yet. FIRST call `mcp__studio__TASK_ADD_REPO` with the " +
            "connectionId of the repository this task is about. It clones that repository " +
            "into your working directory and waits for the checkout, so once it returns the " +
            "repository is there on its own branch and `git` and `gh` are authenticated. " +
            "Do not read files, run `git`, or run `gh` before it returns; there is nothing " +
            "there yet.",
          "",
          "Repositories in this organization:",
          ...(opts?.repoChoices ?? []).map(
            (c) => `- ${c.repo} (connectionId: ${c.connectionId})`,
          ),
          opts?.repoChoices?.length
            ? "Start with the one the task is about. If it turns out to need a change in " +
              "another of them too, call `mcp__studio__TASK_ADD_REPO` again — repositories " +
              "accumulate, so a second call adds a checkout beside the first rather than " +
              "replacing it. Each lands in its own directory and keeps its own git remote, " +
              "so open one pull request per repository you changed."
            : "Call `mcp__studio__TASK_ADD_REPO` with no arguments to list them.",
        ].join("\n"),
    "",
  );

  // A re-run's whole point is to update the EXISTING pull request, not to redo
  // the task or open a second one. Conflict resolution wins over feedback.
  if (opts?.resolveConflict && opts.pr) {
    lines.push(
      `Pull request #${opts.pr.number} (${opts.pr.url}) is approved but has a MERGE CONFLICT with its base branch.`,
      `Check that branch out (\`gh pr checkout ${opts.pr.number}\`), merge or rebase the base branch into it, resolve the conflicts, and push to update the SAME pull request — do NOT open a new one. Resolve by preserving BOTH sides' intent; never blindly discard either side, and change only what the conflict requires.`,
      "",
    );
  } else if (opts?.feedback) {
    // Review is SINGLE-PASS (`review-decision.ts`): a `request_changes` verdict
    // hands the card to a human and is never bounced back here. This lead only
    // reaches a run a HUMAN re-ran on such a card, carrying the verdict's notes
    // so the re-run continues from them (`outstandingReviewFeedback`).
    lines.push(
      opts.pr
        ? `A reviewer requested changes on pull request #${opts.pr.number} (${opts.pr.url}):`
        : "A reviewer requested changes on your previous work:",
      opts.feedback,
      opts.pr
        ? `Check that branch out (\`gh pr checkout ${opts.pr.number}\`) before editing, address the feedback, then push to update the SAME pull request — do NOT open a new one.`
        : "Address this feedback.",
      "",
    );
  } else if (opts?.pr) {
    // A person re-delegated a task that already has an open PR. No feedback to
    // lead with, but the sandbox booted on that PR's branch, so "open a pull
    // request" below would contradict where the run actually is.
    lines.push(
      `This task already has an open pull request #${opts.pr.number} (${opts.pr.url}), and you are already on its branch.`,
      `Continue that work: commit and push to update the SAME pull request — do NOT open a new one. If it already does everything the task asks, say so and stop rather than changing it.`,
      "",
    );
  }

  lines.push(
    "How to finish:",
    "- Make the change, commit it, push the branch, and open a pull request" +
      (opts?.pr
        ? " — or push to the existing one, per the instruction above."
        : "."),
    "- Change only what the task needs. Don't refactor around it.",
    // The two defects behind every card that burned its bounce budget.
    "- The change must be REACHABLE from the surface the task names: edit the component that route actually renders, not one that merely looks like the right place. A change nothing imports is dead code, and it is the most common reason a task comes back rejected.",
    // Deliberately LOCAL-only. Verifying on the deploy preview means waiting
    // for a deploy that may not exist yet, and that is the reviewer's job
    // (`enqueue-reviewer.ts`) — this run implements and hands over.
    `- Before handing over, VERIFY the task's outcome LOCALLY, in the sandbox: exercise the affected code path and confirm the behaviour actually happens. A green test suite is not the bar. Do NOT wait for, or verify against, the PR's deploy preview — a reviewer checks that after you hand over.`,
    // A task run's pod is provisioned `harness-run`, which is `cloneOnly`: no
    // install, no dev server (see `provisionSandbox` in tools/sandbox/start.ts).
    // The line above used to assert "the dev server hot-reloads, so hit the
    // route it renders" — an assurance that was simply false here, and runs
    // acted on it: polling a port nothing listened on for minutes, guessing
    // `sleep 90`, starting a second server because they assumed the first was
    // someone else's, and in one case abandoning verification altogether.
    // State the actual sandbox, and name the cost, so booting one is a
    // deliberate choice rather than a surprise.
    "- Nothing is installed and NO dev server is running — this sandbox is a checkout. Usually you don't need one: read the code path end to end, run the repo's tests, and `curl` the LIVE site for how it behaves today. Only start a dev server if you must see YOUR change rendered — it is a cold start, so expect several minutes: launch it ONCE in the background and poll until it answers rather than guessing a sleep.",
    // The sandbox image bakes in chromium + a global playwright-core and wraps
    // them as `qa-screenshot` (packages/sandbox/image/Dockerfile). Nothing told
    // this run about it, so a UI task would `ls node_modules/.bin | grep
    // playwright`, find nothing in the USER's repo, conclude no browser exists,
    // and either hand-roll a CDP client or give up on looking at the change.
    '- For a VISUAL change that means LOOKING at it: `qa-screenshot <url> <path>.png [--mobile] [--full] [--selector=<css>]` renders the page in headless Chromium — it reaches a dev server you started on localhost as well as any public URL, and unlike `curl` it runs the page\'s JS, so lazily-rendered sections are actually there. Then `Read` the file: a screenshot you never opened is not verification. It is already installed; do NOT look for playwright in the repo\'s `node_modules`. To INTERACT with a page — click, hit-test with `document.elementFromPoint`, fill a form — write a throwaway node script that requires the global playwright-core: `const { chromium } = require("/usr/local/lib/node_modules/playwright-core"); chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] })`. Screenshots alone are not the limit of what you can check.',
    // The ONLY reliable way the board learns the PR: Claude Code opens it inside
    // the pod, so no Studio-side hook sees it (see pr-link.ts). Reviewers are
    // dispatched from the linked PR, so skipping this strands the card.
    `- As soon as \`gh pr create\` prints the URL, call \`mcp__studio__TASK_BOARD_ITEM_PR_LINK\` with that url. Do this even if you also mention the PR in a comment — the reviewers are dispatched from the linked PR, not from your message.`,
    // Deliberately NOT "then move it to In Review". Linking the PR is what
    // starts the review (`openReviewCycleIfInProgress`), and the card stays In
    // Progress until the reviewer decides — an agent is still working on it.
    // `parkReviewedCardForHuman` makes that move, on a verdict, not the model.
    // NOT "leave it for a reviewer anyway": reviewers are only enqueued for a
    // task that has a PR (`enqueueReviewersOnThreadFinish`). A no-PR task left
    // waiting had no reviewer to pick it up and no signal that a human should —
    // every such card sat untouched. Done is the terminal lane, and the comment
    // is what a human reads to disagree and reopen it.
    `- If the task turns out to need no code change, do NOT open a PR: explain why in a comment on the task (\`mcp__studio__TASK_BOARD_COMMENT_CREATE\`) and move it to "done". There is nothing for a reviewer to review, so leaving it for one would strand it.`,
    // The board is where a human reads this task, so anything a reviewer needs
    // to know belongs there too — a final message they never open is not a
    // report. Optional: a comment per run, not per step.
    `- Anything a reviewer should know (a decision you made, something you found and deliberately left alone, a question) goes on the task as a comment: \`mcp__studio__TASK_BOARD_COMMENT_CREATE\` with taskBoardItemId "${task.id}". Read what's already there first with \`mcp__studio__TASK_BOARD_COMMENT_LIST\` — a comment may be addressed to you.`,
    "",
    `(task id: ${task.id})`,
  );
  return lines.join("\n");
  // prompt-region:end super-agent-sandbox
}
