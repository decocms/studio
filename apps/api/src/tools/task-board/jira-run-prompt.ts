/**
 * How a Jira-triggered run is told to work and to finish.
 *
 * Its card is a hidden anchor nobody reads, so the board's closing
 * instructions are wrong for it twice over: they point at `TASK_BOARD_*` tools
 * its endpoint does not serve (`JIRA_RUN_TOOL_NAMES`), and they would have it
 * record its work where no one looks while the issue stayed untouched. Observed
 * on the first production run: the model searched for `TASK_BOARD_COMMENT_CREATE`,
 * found nothing, and fell back to the issue tools on its own.
 *
 * The bar is what a person doing this by hand produces on the card: the PR and
 * the preview as links, before/after screenshots taken on the deployed preview,
 * a report that says what was measured rather than what was intended, and the
 * issue moved on. Everything below exists because a compared run was missing it.
 *
 * `prefix` is the harness's tool namespace. A sandbox-hosted run reaches Studio
 * over MCP and sees `mcp__studio__JIRA_COMMENT_ADD`; a Decopilot run has the
 * same tools registered as built-ins under their bare names. Naming them the
 * way the model will actually see them is the difference between a call and a
 * tool search.
 */

export type JiraToolPrefix = "mcp__studio__" | "";

/** The lead a Jira run opens with when its rule supplies no instruction of
 *  its own. Replaces the board's "you've been assigned this task". */
export const JIRA_DEFAULT_LEAD =
  "A Jira issue was moved into a column you are responsible for. Work the " +
  "issue: implement what it asks, verify it, and report back on the issue.";

/**
 * Verification, for a run whose work reaches a deploy preview.
 *
 * The board's rule is the opposite of this ("do not verify against the
 * preview — a reviewer checks it after you hand over") and it does not hold
 * here: the reviewer of a Jira run writes its verdict to the hidden anchor
 * card, so nobody checks the preview and nobody reports it. This run is the
 * only one that can.
 */
export function jiraRunVerifyInstructions(): string[] {
  return [
    "- Verify on the DEPLOY PREVIEW, not only locally. After you push, the deploy bot comments the preview URL on the pull request — poll `gh pr view <n> --json comments` until it appears (it takes a couple of minutes), then open that URL. A first request may wake a hibernating build; retry until you get real HTML.",
    "- Exercise the actual behaviour on that preview and MEASURE it. Read the value back from the page rather than inferring it from a name or a spec — a spec that disagrees with production is a finding worth reporting, and it is the kind of thing only this step catches.",
    "- Capture before/after evidence with `qa-screenshot <url> <path>.png [--mobile]`, on desktop AND mobile, and `Read` each file — a screenshot you never opened is not verification.",
  ];
}

/** How the run reports back: on the ISSUE, with the tools its endpoint serves. */
export function jiraRunFinishInstructions(prefix: JiraToolPrefix): string[] {
  const tool = (name: string) => `\`${prefix}${name}\``;
  return [
    "This run was started by a Jira issue, not a board card. Report on the ISSUE — there is no card for anyone to read, and no reviewer will report for you:",
    `- ${tool("JIRA_REMOTE_LINK_ADD")} puts the pull request on the issue as a link (\`key: "pull-request"\`), and the deploy preview as another (\`key: "preview"\`). Do both — a URL buried in a comment is not something a person clicks.`,
    `- ${tool("JIRA_COMMENT_ADD")} posts your report (markdown, tables included). This is the ONLY way your work gets reported — a final message in this run is not a report. Say what you changed, what you MEASURED on the preview, and what you deliberately left alone. Name anything the issue asked for that you did not do.`,
    "- To show evidence, write each screenshot to `org/output/<name>.png` and reference it in that comment as `![what it shows](org/output/<name>.png)` — it is uploaded to the issue and rendered inline. A before/after markdown table of two images reads best.",
    `- ${tool("JIRA_ISSUE_GET")} re-reads the issue — worth doing before you report, since a person may have edited the card while you worked.`,
    `- ${tool("JIRA_ISSUE_TRANSITION")} moves the issue on when your work warrants it. Do this last, after the links and the comment are on the card.`,
    `- ${tool("JIRA_ATTACHMENT_DOWNLOAD")} fetches an attachment of the issue into the pod by its id, when the card carries a mockup or a log you need.`,
    "You have no board tools on this run. Do not look for them.",
  ];
}
