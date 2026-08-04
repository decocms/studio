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
import type { SuperAgentPromptOpts } from "./enqueue-super-agent";

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
 * - `null` — none imported, so this harness can't run the task at all.
 *
 * Never throws: a lookup failure degrades to the Decopilot path rather than
 * failing the delegation that already persisted. Both non-bound outcomes are
 * logged — "why did this task run Decopilot?" (or "why did it have to pick?")
 * is otherwise invisible.
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
  const lines: string[] = [
    "You've been assigned this task. Complete it and finish with a pull request.",
    "",
    "You are running AUTONOMOUSLY — no human is watching, so drive this to " +
      "completion yourself. Make reasonable decisions and move on; do not stop " +
      "to ask for confirmation.",
    "",
    `Title: ${task.title}`,
  ];
  if (task.description) lines.push("", "Description:", task.description);
  lines.push(
    "",
    repo
      ? `The repository ${repo.owner}/${repo.name} is already cloned at your working directory, on its own branch. \`git\` and \`gh\` are authenticated.`
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
            ? "Pick the one the task is about. If the task doesn't say and the names don't " +
              "settle it, take the first."
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
  }

  lines.push(
    "How to finish:",
    "- Make the change, commit it, push the branch, and open a pull request" +
      (opts?.pr
        ? " — or push to the existing one, per the instruction above."
        : "."),
    "- Change only what the task needs. Don't refactor around it.",
    `- Then move this task to review on the board: call \`mcp__studio__TASK_BOARD_ITEM_UPDATE\` with id "${task.id}" and status "in_review". Pass ONLY the fields you are changing.`,
    "- If the task turns out to need no code change, say why in your final message and move it to review anyway so a human can close it out.",
    // The board is where a human reads this task, so anything a reviewer needs
    // to know belongs there too — a final message they never open is not a
    // report. Optional: a comment per run, not per step.
    `- Anything a reviewer should know (a decision you made, something you found and deliberately left alone, a question) goes on the task as a comment: \`mcp__studio__TASK_BOARD_COMMENT_CREATE\` with taskBoardItemId "${task.id}". Read what's already there first with \`mcp__studio__TASK_BOARD_COMMENT_LIST\` — a comment may be addressed to you.`,
    "",
    `(task id: ${task.id})`,
  );
  return lines.join("\n");
}
