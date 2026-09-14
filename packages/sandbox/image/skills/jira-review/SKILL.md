---
name: jira-review
description: Review the pull request a Jira issue already carries, QA it on the deploy preview, and record the verdict on the issue. Insert into the prompt of a Jira review or QA column rule.
disable-model-invocation: true
---

# jira-review — review what the other run built

Insert this into the prompt of the Jira column your team reviews in. It is the
second of two runs: an earlier column implemented the issue and opened a pull
request (`jira-execute`), and this one judges it.

It is ordinary text once inserted — read it, cut what does not apply to your
team, add what does.

---

You are reviewing someone else's change to a Jira issue. The issue itself is
above, web links included.

## Find what you are reviewing

- The pull request is normally on the issue as a web link, put there by the run
  that implemented it. If it is not, its branch is normally named for the issue
  key: `gh pr list --search "<the issue key>" --state all`.
- If there is genuinely no pull request, do not write one. Report that on the
  issue and stop.

## Review the code

- Check the branch out and read the diff (`gh pr diff <n>`, then the files
  around it). Does it do what the issue asks; is it reachable from the surface
  the issue names; does it break something next to it.
- **Do NOT implement the fix yourself and do NOT open a pull request.** A
  reviewer that rewrites the change has reviewed nothing, and a second pull
  request on one issue is what a human then has to clean up. A small,
  unambiguous correction is a comment on the issue, not a commit.

## QA it on the deploy preview

- The deploy bot comments the preview URL on the pull request
  (`gh pr view <n> --json comments`); the issue's web links may carry it too. If
  no preview exists yet, poll until it does. A first request may wake a
  hibernating build; retry until you get real HTML.
- Exercise the behaviour and MEASURE it. Read the value back from the page
  rather than inferring it from a name or a spec.
- Compare against production, not only against the spec: the live site is the
  "before" and the preview is the "after". A difference you cannot see on both
  is not evidence. If production is unreachable from this pod, say so in your
  report rather than passing the card on an untested comparison.
- Capture before/after evidence with `qa-screenshot <url> <path>.png [--mobile]`,
  on desktop AND mobile, and `Read` each file. A screenshot you never opened is
  not verification, and mobile is not desktop resized — plenty of these issues
  only reproduce on one of the two.

## Record the verdict on the ISSUE

There is no card for anyone to read. A final message in this run is not a
report.

- `JIRA_COMMENT_ADD` posts your review (markdown, tables included). Open with
  the verdict in ONE line — approved, or changes requested — then the evidence,
  then the findings, each naming a file and line or a screenshot.
- A finding is a defect you OBSERVED, not a preference. Say what you did, what
  you expected, and what happened instead. If you found nothing, say that
  plainly rather than padding the list: an invented finding costs more than a
  missed one here.
- To show evidence, write each screenshot to `org/output/<name>.png` and
  reference it in that comment as `![what it shows](org/output/<name>.png)` — it
  is uploaded to the issue and rendered inline. A before/after table of two
  images reads best.
- `JIRA_REMOTE_LINK_ADD` adds the preview you reviewed (`key: "preview"`) if the
  implementing run did not already put it on the issue.
- `JIRA_ISSUE_GET` re-reads the issue before you report — a person may have
  edited the card, or answered a question on it, while you worked.
- `JIRA_ISSUE_TRANSITION` carries the verdict: move the issue ON when it passes,
  and BACK to the column the implementing run works in when it does not. Do this
  LAST, after the comment is on the card — a transition with no comment beside
  it is the one nobody can act on.
