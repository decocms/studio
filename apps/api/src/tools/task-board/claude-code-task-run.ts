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
import {
  listOrgRepoChoices,
  type RepoChoice,
} from "@/git-providers/repo-choices";
import {
  type GitProviderKind,
  providerCli,
} from "@decocms/shared/git-providers";
import { SHALLOW_CHECKOUT_NOTE } from "@decocms/shared/task-board";
import { agentSandboxEnabled } from "@/settings";
import type { SuperAgentPromptOpts } from "./enqueue-super-agent";
import {
  sandboxUploadHint,
  uploadsAsSandboxPaths,
} from "./description-uploads";

/**
 * The repo a claude-code task run works in.
 *
 * `id` is the opaque handle from `RepoChoice` — a repository id, or a legacy
 * connection id — and it is what keys the run's sandbox, so two repos never
 * share a pod. The credential fields are whichever the backing model has:
 * `repositoryId` for a first-class repository, `connectionId` +
 * `installationId` for a legacy `mcp-github` one.
 */
export interface TaskRepo {
  id: string;
  owner: string;
  name: string;
  url: string;
  provider: GitProviderKind;
  connectionId?: string;
  repositoryId?: string;
  installationId?: number;
}

/**
 * The org's single clonable repo, or null when the answer is ambiguous.
 *
 * "Single" counts REPOSITORIES, not connections — see `mergeRepoChoices`, which
 * is what collapses the two loadable `mcp-github` children one import routinely
 * leaves behind (the org-shared one and a per-agent one) into the one repo they
 * both point at. Counting connections made a genuinely one-repo org look
 * ambiguous and silently dropped every task to Decopilot.
 *
 * Pure, so the counting rule is unit-tested without a StudioContext.
 */
export function pickSoleTaskRepo(choices: RepoChoice[]): TaskRepo | null {
  if (choices.length !== 1) return null;
  const chosen = choices[0]!;
  return {
    id: chosen.id,
    owner: chosen.owner,
    name: chosen.name,
    url: chosen.webUrl,
    provider: chosen.provider,
    ...(chosen.connectionId ? { connectionId: chosen.connectionId } : {}),
    ...(chosen.repository ? { repositoryId: chosen.repository.id } : {}),
    ...(chosen.installationId !== undefined
      ? { installationId: chosen.installationId }
      : {}),
  };
}

/**
 * How a claude-code task run gets its repo, from the org's linked repositories
 * and legacy `mcp-github` connections:
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
  /** The opaque id `TASK_ADD_REPO` takes. */
  id: string;
  /** `owner/name` — what a card's `repo` field is matched against. */
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
    const choices = await listOrgRepoChoices(ctx, organizationId);
    const repo = pickSoleTaskRepo(choices);
    if (repo) return { repo };
    if (choices.length === 0) {
      console.warn(
        `[task-board] claude-code skipped for org ${organizationId}: ` +
          `no importable repos — running Decopilot`,
      );
      return null;
    }
    console.warn(
      `[task-board] claude-code for org ${organizationId}: ` +
        `${choices.length} importable repos — the run picks one with TASK_ADD_REPO`,
    );
    return {
      choices: choices.map((c) => ({ id: c.id, repo: `${c.owner}/${c.name}` })),
    };
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
/**
 * Repositories in one run can come from different providers, so the CLI is a
 * property of the checkout, not of the run. Stated as a rule rather than a
 * command because the agent is the one who knows which directory it is in.
 */
const MIXED_PROVIDER_NOTE =
  "Each checkout is authenticated for ITS OWN host: use `gh` inside a GitHub " +
  "repository and `glab` inside a GitLab one (`glab mr create` is the " +
  "counterpart of `gh pr create`). A run can hold both at once, so pick the " +
  "one that matches the repository you are standing in — check its remote " +
  "with `git remote get-url origin` if you are unsure.";

export function buildClaudeCodeTaskPrompt(
  task: { id: string; title: string; description: string | null },
  repo: TaskRepo | null,
  opts?: SuperAgentPromptOpts & { repoChoices?: TaskRepoChoiceOption[] },
): string {
  // prompt-region:start super-agent-sandbox
  /**
   * The primary checkout's vocabulary, used for the instructions that name a
   * concrete command. A run can hold checkouts from BOTH providers at once
   * (`TASK_ADD_REPO` accumulates them), so the rule tying a CLI to its own
   * checkout is stated separately — see MIXED_PROVIDER_NOTE.
   */
  const cli = providerCli(repo?.provider ?? "github");
  const lines: string[] = [
    `You've been assigned this task. Complete it and finish with a ${cli.changeRequest} if it makes sense (like a coding task) or is explicitly requested.`,
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
      ? `The repository ${repo.owner}/${repo.name} is already cloned at your working directory, on its own branch. It is hosted on ${repo.provider === "gitlab" ? "GitLab" : "GitHub"}, so \`git\` and \`${cli.cli}\` are authenticated there. ${SHALLOW_CHECKOUT_NOTE}`
      : [
          "Your working directory is EMPTY: this organization has several repositories, so " +
            "nothing has been cloned yet. FIRST call `mcp__studio__TASK_ADD_REPO` with the " +
            "id of the repository this task is about. It clones that repository " +
            "into your working directory and waits for the checkout, so once it returns the " +
            "repository is there on its own branch, with `git` and that " +
            "repository's own CLI authenticated. " +
            "Do not read files or run `git` before it returns; there is nothing " +
            "there yet.",
          "",
          "Repositories in this organization:",
          ...(opts?.repoChoices ?? []).map((c) => `- ${c.repo} (id: ${c.id})`),
          opts?.repoChoices?.length
            ? "Start with the one the task is about. If it turns out to need a change in " +
              "another of them too, call `mcp__studio__TASK_ADD_REPO` again — repositories " +
              "accumulate, so a second call adds a checkout beside the first rather than " +
              "replacing it. Each lands in its own directory and keeps its own git remote, " +
              "so open one change request per repository you changed."
            : "Call `mcp__studio__TASK_ADD_REPO` with no arguments to list them.",
        ].join("\n"),
    "",
    MIXED_PROVIDER_NOTE,
    "",
  );

  // A re-run's whole point is to update the EXISTING pull request, not to redo
  // the task or open a second one. Conflict resolution wins over feedback.
  if (opts?.resolveConflict && opts.pr) {
    lines.push(
      `Pull request #${opts.pr.number} (${opts.pr.url}) is approved but has a MERGE CONFLICT with its base branch.`,
      `Check that branch out (\`${cli.checkoutCommand} ${opts.pr.number}\`), merge or rebase the base branch into it, resolve the conflicts, and push to update the SAME ${cli.changeRequest} — do NOT open a new one. Resolve by preserving BOTH sides' intent; never blindly discard either side, and change only what the conflict requires.`,
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
        ? `Check that branch out (\`${cli.checkoutCommand} ${opts.pr.number}\`) before editing, address the feedback, then push to update the SAME ${cli.changeRequest} — do NOT open a new one.`
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
    "- The change must be REACHABLE from the surface the task names: edit the component that route actually renders, not one that merely looks like the right place. A change nothing imports is the most common reason a task comes back rejected.",
    // Deliberately LOCAL-only. Verifying on the deploy preview means waiting
    // for a deploy that may not exist yet, and that is the reviewer's job
    // (`enqueue-reviewer.ts`) — this run implements and hands over.
    `- Before handing over, VERIFY the task's outcome LOCALLY, in the sandbox: exercise the affected code path and confirm the behaviour actually happens. A green test suite is not the bar. Do NOT wait for, or verify against, the PR's deploy preview — a reviewer checks that after you hand over.`,
    // The sandbox's state — installed or not, dev server or not — is NOT
    // stated here. It is decided by the claim, minutes after this string is
    // built, and `sandboxStateInstruction` (sandbox-dispatch-client.ts) appends
    // the true answer at dispatch.
    '- A browser is installed globally, NOT in the repo\'s `node_modules` — don\'t go looking for playwright there. `qa-screenshot <url> <path>.png [--mobile] [--full] [--selector=<css>]` renders any URL (localhost included) in headless Chromium, runs the page\'s JS, and writes a file you must then `Read` — a screenshot you never opened is not verification. To INTERACT (click, fill, `document.elementFromPoint`), write a throwaway node script: `const { chromium } = require("/usr/local/lib/node_modules/playwright-core"); chromium.launch({ executablePath: "/usr/bin/chromium", args: ["--no-sandbox"] })`.',
    // How the board finds the PR now: it looks GitHub up by the branch this
    // checkout is on (`pr-by-branch.ts`), so the one thing the run must not do
    // is open the PR from some other branch. Replaces asking the run to report
    // it, which a run that died right after `gh pr create` could never do.
    `- Open the ${cli.changeRequest} from the branch you were given — the board finds it by that branch. Don't move the work to a differently-named one.`,
    // A tool call, NOT a line in the PR body: the first version of this read
    // the body back, and one hand-edited body lost the routes silently.
    `- If your change adds or edits pages a person can open, report their paths with \`mcp__studio__TASK_BOARD_ITEM_UPDATE\` (id "${task.id}", \`previewRoutes: ["/some-page"]\`) — paths only, no host. The card joins them onto the deploy preview so a reviewer opens the page directly. Skip it when the change has no visible route.`,
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
