/**
 * How a Jira-triggered run is told to finish.
 *
 * Its card is a hidden anchor nobody reads, so the board's closing
 * instructions are wrong for it twice over: they point at `TASK_BOARD_*` tools
 * its endpoint does not serve (`JIRA_RUN_TOOL_NAMES`), and they would have it
 * record its work where no one looks while the issue stayed untouched. Observed
 * on the first production run: the model searched for `TASK_BOARD_COMMENT_CREATE`,
 * found nothing, and fell back to the issue tools on its own.
 *
 * `prefix` is the harness's tool namespace. A sandbox-hosted run reaches Studio
 * over MCP and sees `mcp__studio__JIRA_COMMENT_ADD`; a Decopilot run has the
 * same tools registered as built-ins under their bare names. Naming them the
 * way the model will actually see them is the difference between a call and a
 * tool search.
 */

export type JiraToolPrefix = "mcp__studio__" | "";

export function jiraRunFinishInstructions(prefix: JiraToolPrefix): string[] {
  const tool = (name: string) => `\`${prefix}${name}\``;
  return [
    "This run was started by a Jira issue, not a board card. Report on the ISSUE — there is no card for anyone to read:",
    `- ${tool("JIRA_ISSUE_GET")} re-reads the issue (description, comments, attachments).`,
    `- ${tool("JIRA_COMMENT_ADD")} posts a comment on it (markdown). Leave one when you finish, with what you did and any pull request link. This is the ONLY way your work gets reported — a final message in this run is not a report.`,
    `- ${tool("JIRA_ISSUE_TRANSITION")} moves it to another status when your work warrants it.`,
    `- ${tool("JIRA_ATTACHMENT_DOWNLOAD")} fetches an attachment into the sandbox by its id.`,
    "You have no board tools on this run. Do not look for them.",
  ];
}
