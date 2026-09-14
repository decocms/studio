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
 * There are TWO of these runs per issue, because that is the process the
 * column rules automate (see `JiraRunKind`): one column implements, a later
 * column reviews. The single thread that implemented and signed off on its own
 * work was a hand-fired exception, and its instructions are wrong for a
 * reviewer — "open a pull request" tells the reviewer to redo the work.
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

import type { JiraRunKind } from "@/jira/run-kind";

export type JiraToolPrefix = "mcp__studio__" | "";

/** The lead a Jira run opens with when its rule supplies no instruction of
 *  its own. Replaces the board's "you've been assigned this task". */
export function jiraDefaultLead(kind: JiraRunKind): string {
  return kind === "review"
    ? "A Jira issue was moved into a column you review. Someone else " +
        "implemented it and opened a pull request: review that change and QA " +
        "it, then record your verdict on the issue."
    : "A Jira issue was moved into a column you are responsible for. Work the " +
        "issue: implement what it asks, verify it, and report back on the issue.";
}

/**
 * Verification, for a run whose work reaches a deploy preview.
 *
 * The board's rule is the opposite of this ("do not verify against the
 * preview — a reviewer checks it after you hand over") and it does not hold
 * here: the reviewer of a Jira run writes its verdict to the hidden anchor
 * card, so nobody checks the preview and nobody reports it. The two Jira runs
 * are the only ones that can, and for the review run it is the whole job.
 */
export function jiraRunVerifyInstructions(kind: JiraRunKind): string[] {
  const findPreview =
    kind === "review"
      ? "- Find the deploy preview. The deploy bot comments its URL on the pull request — `gh pr view <n> --json comments`; the issue's web links may carry it too. If no preview exists yet, poll until it does (it takes a couple of minutes). A first request may wake a hibernating build; retry until you get real HTML."
      : "- Verify on the DEPLOY PREVIEW, not only locally. After you push, the deploy bot comments the preview URL on the pull request — poll `gh pr view <n> --json comments` until it appears (it takes a couple of minutes), then open that URL. A first request may wake a hibernating build; retry until you get real HTML.";
  return [
    findPreview,
    "- Exercise the actual behaviour on that preview and MEASURE it. Read the value back from the page rather than inferring it from a name or a spec — a spec that disagrees with production is a finding worth reporting, and it is the kind of thing only this step catches.",
    '- Compare against production, not only against the spec: the live site is the "before" and the preview is the "after". A difference you cannot see on both is not evidence.',
    "- Capture before/after evidence with `qa-screenshot <url> <path>.png [--mobile]`, on desktop AND mobile, and `Read` each file — a screenshot you never opened is not verification. Mobile is not desktop resized: plenty of these issues only reproduce on one of the two.",
  ];
}

/** How a run reports back: on the ISSUE, with the tools its endpoint serves. */
export function jiraRunFinishInstructions(
  prefix: JiraToolPrefix,
  kind: JiraRunKind,
): string[] {
  const tool = (name: string) => `\`${prefix}${name}\``;
  const lead =
    kind === "review"
      ? "This run was started by a Jira issue, not a board card. Your verdict goes on the ISSUE — there is no card for anyone to read, and nobody reports for you:"
      : "This run was started by a Jira issue, not a board card. Report on the ISSUE — there is no card for anyone to read, and no reviewer will report for you:";
  const lines = [lead];

  if (kind === "execute") {
    lines.push(
      `- ${tool("JIRA_REMOTE_LINK_ADD")} puts the pull request on the issue as a link (\`key: "pull-request"\`), and the deploy preview as another (\`key: "preview"\`). Do both — a URL buried in a comment is not something a person clicks.`,
      `- ${tool("JIRA_COMMENT_ADD")} posts your report (markdown, tables included). This is the ONLY way your work gets reported — a final message in this run is not a report. Say what you changed, what you MEASURED on the preview, and what you deliberately left alone. Name anything the issue asked for that you did not do.`,
    );
  } else {
    lines.push(
      `- ${tool("JIRA_COMMENT_ADD")} posts your review (markdown, tables included). This is the ONLY way your verdict gets recorded — a final message in this run is not a report. Open with the verdict in one line (approved, or changes requested), then the evidence, then the findings, each naming a file and line or a screenshot.`,
      "- A finding is a defect you OBSERVED, not a preference. Say what you did, what you expected, and what happened instead. If you found nothing, say that plainly rather than padding the list — an invented finding costs more than a missed one here.",
      `- ${tool("JIRA_REMOTE_LINK_ADD")} adds the deploy preview you reviewed (\`key: "preview"\`) if the implementing run did not already put it on the issue.`,
    );
  }

  lines.push(
    "- To show evidence, write each screenshot to `org/output/<name>.png` and reference it in that comment as `![what it shows](org/output/<name>.png)` — it is uploaded to the issue and rendered inline. A before/after markdown table of two images reads best.",
    `- ${tool("JIRA_ISSUE_GET")} re-reads the issue — worth doing before you report, since a person may have edited the card while you worked.`,
  );

  if (kind === "review") {
    lines.push(
      `- ${tool("JIRA_ISSUE_TRANSITION")} carries the verdict: move the issue ON when it passes, and BACK to the column the implementing run works in when it does not. Do this last, after the comment is on the card — the transition with no comment beside it is the one nobody can act on.`,
    );
  } else {
    lines.push(
      `- ${tool("JIRA_ISSUE_TRANSITION")} moves the issue on when your work warrants it. Do this last, after the links and the comment are on the card.`,
    );
  }

  lines.push(
    `- ${tool("JIRA_ATTACHMENT_DOWNLOAD")} fetches an attachment of the issue into the pod by its id, when the card carries a mockup or a log you need.`,
    "You have no board tools on this run. Do not look for them.",
  );
  return lines;
}

/**
 * The review run's working instructions — what replaces "make the change,
 * commit it, push the branch, and open a pull request".
 *
 * It has to FIND the pull request first: the anchor item is off the board's
 * reactions, so nothing linked one, and the implementing run may have been a
 * different sandbox entirely. The issue's web links are where that run was
 * told to put it; the branch name and a search are the fallbacks.
 */
export function jiraReviewWorkInstructions(
  cli: string | null,
  issueKey: string,
): string[] {
  // Bitbucket checkouts have no CLI (`providerCli`), so name the act rather
  // than a command that is not installed.
  const find = cli
    ? `\`${cli} pr list --search "${issueKey}" --state all\` finds it either way`
    : `the host's API, searched for ${issueKey}, finds it either way`;
  const diff = cli
    ? `\`${cli} pr diff <n>\`, then the files around it`
    : "`git diff <base>...<head>`, then the files around it";
  return [
    "How to review:",
    `- FIND the pull request first. The implementing run was told to add it to the issue as a web link, and its branch is normally named for the issue key — ${find}. If there is genuinely no pull request, do not write one: report that on the issue and stop.`,
    `- Check that branch out and READ the diff (${diff}). Review the change as written: does it do what the issue asks, is it reachable from the surface the issue names, does it break something next to it.`,
    "- Do NOT implement the fix yourself and do NOT open a pull request. A reviewer that rewrites the change has reviewed nothing, and a second pull request for one issue is what a human then has to clean up. Small, unambiguous corrections are a comment on the issue, not a commit.",
  ];
}
