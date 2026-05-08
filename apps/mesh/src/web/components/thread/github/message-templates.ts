/**
 * Pure text templates for PR panel action buttons. Kept in a separate module
 * so they're trivially unit-testable and editable without touching the UI.
 *
 * The agent's system prompt (buildRepoEnvironmentPrompt) already carries:
 * - Which repo is active (owner/name)
 * - The git-CLI-vs-GitHub-tools split
 *
 * Templates add the specific PR number / branch name where it saves the
 * agent a discovery round-trip, plus a `BUTTON_CONFIRMED` suffix that tells
 * the agent the user clicked deliberately — execute, don't ask.
 */

export interface TemplateContext {
  branch?: string;
  prNumber?: number;
  failingChecks?: string[];
  checkName?: string;
}

/**
 * Suffix appended to every template. Reminds the agent that the user
 * triggered this by clicking a UI button, so `user_ask` is not needed unless
 * a real blocker shows up.
 */
const BUTTON_CONFIRMED =
  "The user clicked this action deliberately — execute directly. Do not call user_ask unless you hit an actual problem outside the scope of this intent (missing auth, unresolvable conflict, a check with multiple plausible fixes).";

export function commitAndPush(ctx: Pick<TemplateContext, "branch">): string {
  return `Commit every pending change in the working tree with a concise conventional-commit message summarizing the diff, then push to \`origin/${ctx.branch}\`. If local commits are ahead of the remote, push those in the same invocation. ${BUTTON_CONFIRMED}`;
}

export function createPr(ctx: Pick<TemplateContext, "branch">): string {
  return `Open a pull request for \`${ctx.branch}\` against its base. Write a clear title and a summary of the changes so far. ${BUTTON_CONFIRMED}`;
}

export function reopenPr(ctx: Pick<TemplateContext, "prNumber">): string {
  return `Reopen PR #${ctx.prNumber}. ${BUTTON_CONFIRMED}`;
}

export function rebaseOnBase(ctx: Pick<TemplateContext, "branch">): string {
  return `Rebase \`${ctx.branch}\` on the latest base and force-push with --force-with-lease. ${BUTTON_CONFIRMED}`;
}

export function rerunCheck(
  ctx: Pick<TemplateContext, "prNumber" | "checkName">,
): string {
  return `Re-run the \`${ctx.checkName}\` check on PR #${ctx.prNumber}. If an empty commit is needed to retrigger CI, create and push one. ${BUTTON_CONFIRMED}`;
}

export function fixChecks(
  ctx: Pick<TemplateContext, "prNumber" | "failingChecks">,
): string {
  const list = (ctx.failingChecks ?? []).map((n) => `\`${n}\``).join(", ");
  return `PR #${ctx.prNumber} has failing checks: ${list}. For each: read the logs, diagnose the root cause, apply the smallest fix that makes it pass, commit, and push. ${BUTTON_CONFIRMED}`;
}

export function markReadyForReview(
  ctx: Pick<TemplateContext, "prNumber">,
): string {
  return `Mark PR #${ctx.prNumber} ready for review. ${BUTTON_CONFIRMED}`;
}

export function resolveReviewComments(
  ctx: Pick<TemplateContext, "prNumber">,
): string {
  return `Read the unresolved review threads on PR #${ctx.prNumber}. For each thread: understand the reviewer's ask, apply the needed changes, commit, push, reply explaining what changed, and resolve the thread. If a comment is a question that doesn't need a code change, reply with the answer and resolve. ${BUTTON_CONFIRMED}`;
}

export function reviewPr(ctx: Pick<TemplateContext, "prNumber">): string {
  return `Review PR #${ctx.prNumber}. Read the full diff, analyze every changed file for correctness, security, code quality, and alignment with the repo's patterns. Post specific line-level review comments on concerns, then submit an overall review (approve / request changes / comment) with a concise summary. Do not modify the code — this is a read-and-comment pass. ${BUTTON_CONFIRMED}`;
}

export function mergeSquash(ctx: Pick<TemplateContext, "prNumber">): string {
  return `Squash-merge PR #${ctx.prNumber} into its base. ${BUTTON_CONFIRMED}`;
}
