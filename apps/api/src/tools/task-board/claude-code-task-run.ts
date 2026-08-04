/**
 * Running a delegated task with the sandbox-hosted `claude-code` harness.
 *
 * Decopilot picks its repo mid-run with `load_repo`. claude-code cannot: the
 * sandbox branch and the clone are both resolved BEFORE dispatch, and the fs
 * layer binds the branch at run start — so a repo chosen later never reaches
 * the run. The repo therefore has to be decided here, up front, and bound to
 * the thread so `resolveSandboxBranch` puts the run in a sandbox that actually
 * has a checkout.
 *
 * That constraint drives the eligibility rule below: this harness runs a task
 * only when the org has exactly ONE importable REPOSITORY (which is not the
 * same as one connection — see `pickSoleTaskRepo`), so "which repo" has a
 * single correct answer. Every other case (no repos, several repos) falls back
 * to Decopilot, which can ask/choose at runtime. A task must never end up in a
 * sandbox with no checkout and a prompt telling it to open a PR.
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
 * `pickSoleTaskRepo` over the org's `mcp-github` connections.
 *
 * Null means "not eligible for claude-code" — see the module doc. Never throws:
 * a lookup failure degrades to the Decopilot path rather than failing the
 * delegation that already persisted. The null cases are logged: the fallback is
 * otherwise invisible, and "why did this task run Decopilot?" is exactly the
 * question an operator has.
 */
export async function resolveSoleTaskRepo(
  ctx: StudioContext,
  organizationId: string,
): Promise<TaskRepo | null> {
  try {
    const { items } = await ctx.storage.connections.list(organizationId, {
      slug: "mcp-github",
    });
    const repo = pickSoleTaskRepo(items);
    if (!repo) {
      const repos = selectLoadableRepos(items);
      const distinct = new Set(repos.map((r) => repoKey(r.owner, r.repo)));
      console.warn(
        `[task-board] claude-code skipped for org ${organizationId}: ` +
          `${distinct.size} importable repos (needs exactly 1) — running Decopilot`,
      );
    }
    return repo;
  } catch (err) {
    console.warn("[task-board] repo lookup for claude-code failed", err);
    return null;
  }
}

/** Is the sandbox-hosted harness allowed for this org? Default off. */
export async function claudeCodeEnabledForOrg(
  ctx: StudioContext,
  organizationId: string,
): Promise<boolean> {
  try {
    const settings = await ctx.storage.organizationSettings.get(organizationId);
    return settings?.flags?.claude_code_sandbox_enabled === true;
  } catch (err) {
    console.warn("[task-board] org flag lookup failed", err);
    return false;
  }
}

/**
 * The autonomous prompt for a claude-code task run. Pure, so the branch
 * selection is unit-tested.
 *
 * Deliberately shorter than the Decopilot prompt: most of that one exists to
 * steer tool choice (`load_repo`, "prefer the GitHub tool", "don't hunt for the
 * dev-server port"). Here the repo is already checked out at the working
 * directory and the harness has real `git` and `gh`, so the prompt only has to
 * say what "done" means — including the part Decopilot gets from its own tools
 * and this harness only has over MCP: moving the task on the board.
 */
export function buildClaudeCodeTaskPrompt(
  task: { id: string; title: string; description: string | null },
  repo: TaskRepo,
  opts?: SuperAgentPromptOpts,
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
    `The repository ${repo.owner}/${repo.name} is already cloned at your working directory, on its own branch. \`git\` and \`gh\` are authenticated.`,
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
    "",
    `(task id: ${task.id})`,
  );
  return lines.join("\n");
}
