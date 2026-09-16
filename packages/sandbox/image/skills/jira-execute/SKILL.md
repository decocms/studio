---
name: jira-execute
description: Implement a Jira issue, open a pull request, and report the work on the issue. Insert into the prompt of a Jira column rule that does the building.
disable-model-invocation: true
---

# jira-execute — implement the issue and hand over

Insert this into the prompt of the Jira column your team builds in. It is the
first of two runs: this one implements and hands over, and a later column
reviews what it left (`jira-review`).

It is ordinary text once inserted — read it, cut what does not apply to your
team, add what does.

---

You are implementing a Jira issue. The issue itself is above.

## Build it

- Make the change, commit it, push the branch, and open a pull request.
- Change only what the issue needs. Don't refactor around it.
- The change must be REACHABLE from the surface the issue names: edit the
  component that route actually renders, not one that merely looks like the
  right place. A change nothing imports is the most common reason work comes
  back rejected.
- Open the pull request from the branch you were given. Don't move the work to
  a differently-named one.

## Verify it on the deploy preview

Nobody else will. Do not hand over on a green test suite.

- After you push, the deploy bot comments the preview URL on the pull request —
  poll `gh pr view <n> --json comments` until it appears (it takes a couple of
  minutes), then open that URL. A first request may wake a hibernating build;
  retry until you get real HTML.
- Exercise the actual behaviour there and MEASURE it. Read the value back from
  the page rather than inferring it from a name or a spec — a spec that
  disagrees with production is a finding worth reporting, and it is the kind of
  thing only this step catches.
- Capture evidence with `qa-screenshot <url> <path>.png [--mobile]`, on desktop
  AND mobile, and `Read` each file. A screenshot you never opened is not
  verification, and mobile is not desktop resized.

## Report on the ISSUE

There is no card for anyone to read. A final message in this run is not a
report — the issue is the only place your work becomes visible.

- `JIRA_REMOTE_LINK_ADD` puts the pull request on the issue as a link
  (`key: "pull-request"`), and the deploy preview as another (`key: "preview"`).
  Do both — a URL buried in a comment is not something a person clicks.
- `JIRA_COMMENT_ADD` posts your report (markdown, tables included). Say what you
  changed, what you MEASURED on the preview, and what you deliberately left
  alone. Name anything the issue asked for that you did not do.
- To show evidence, write each screenshot to `org/output/<name>.png` and
  reference it in that comment as `![what it shows](org/output/<name>.png)` — it
  is uploaded to the issue and rendered inline. A before/after table of two
  images reads best.
- `JIRA_ISSUE_GET` re-reads the issue. Worth doing before you report: a person
  may have edited the card while you worked.
- `JIRA_ATTACHMENT_DOWNLOAD` fetches an attachment into the pod by its id, when
  the card carries a mockup or a log you need.
- `JIRA_ISSUE_TRANSITION` moves the issue on. Do this LAST, after the links and
  the comment are on the card.

If the issue turns out to need no code change, do not open a pull request:
say so in the comment, with what you checked, and move the issue on.
