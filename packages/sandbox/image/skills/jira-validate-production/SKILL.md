---
name: jira-validate-production
description: Check that the fix a Jira issue carries is live on the PRODUCTION site and behaves as the issue asked, then close the card or send it back with evidence. Insert into the prompt of a run started on a batch of merged issues, or of a Jira post-deploy column rule.
disable-model-invocation: true
---

# jira-validate-production — confirm it on the live site

Insert this into the prompt of a run you start on several issues at once ("one
run for all of them"), or of the Jira column your team parks merged work in
until someone has seen it live. Either way the issues are in your opening
message, web links included, and every Jira tool takes `issueKey` to say which
issue it is about. On a run about one issue you can leave it out.

It is ordinary text once inserted — read it, cut what does not apply to your
team, add what does.

---

You are the last check before an issue is closed: its change was implemented,
reviewed and merged, and a deploy has (probably) shipped it. Nobody has looked
at production yet. You are not reviewing the code again and you are not
changing anything — you are answering one question per issue: **is the
behaviour the issue asked for live on the production site?**

## What to check, per issue

- Read the issue (`JIRA_ISSUE_GET` with its key): the description says what was
  wrong, and the review and merge comments say what changed and on which
  pages. That is your checklist. Do not invent extra criteria.
- Find the merged pull request in the issue's web links and read its diff
  (`gh pr diff <url>`) so you know the CONCRETE effect to look for — a tag, an
  attribute, a header, a redirect, a value — rather than a paraphrase of it.
- The production URL is the site the issue is about. Your team's own skill or
  the issue names it; if neither does, the repository's README usually does.
  Never guess a domain.

## Confirm the deploy is live before you judge

A merge is not a deploy. Before calling anything a failure, make sure the
change has actually reached production:

- Look for the change itself in the live response (`curl -sL <url> | grep …`,
  or the rendered page). If it is there, the deploy is live.
- If it is not, distinguish "not deployed yet" from "deployed and wrong": the
  repository's deploy workflow or the hosting dashboard shows whether the merge
  commit has shipped (`gh run list --branch main --limit 5`, `gh api
  repos/<owner>/<repo>/deployments`). If the deploy is still running, wait for
  it — poll, with a bound of a few minutes — and re-check.
- If the deploy is still not live when you give up waiting, that is NOT a
  failed validation. Say so in a comment and leave the card where it is.

## Validate the behaviour, not the code

- Exercise the pages the issue names, on production, and MEASURE. Read the
  value back from the live page — `curl`, the DOM, response headers — rather
  than inferring it from the diff. The diff tells you what to look for; the
  page tells you whether it is there.
- Where the issue is visual or interactive, capture evidence with
  `qa-screenshot <url> <path>.png [--mobile]` on desktop AND mobile and `Read`
  each file. A screenshot you never opened is not verification.
- Check the page next to it too: the most common post-deploy defect is not
  "the fix is missing" but "the fix broke the thing beside it" — a duplicated
  tag, a page that now 500s, a layout that shifted. One quick look at the
  obvious neighbour is enough; you are validating, not auditing.
- A fix that is live on one page the issue names and missing on another is a
  fail, not a partial pass.

## Report and move each card

Per issue, as soon as that issue is settled — not one summary at the end, which
a run that dies on the tenth issue never writes:

- `JIRA_COMMENT_ADD` with `issueKey` — open with the verdict in ONE line
  (validated in production, or not), then what you checked, on which URLs, and
  what you observed. Screenshots go to `org/output/<name>.png` and are
  referenced as `![what it shows](org/output/<name>.png)` so they render inline.
  This comment is the record that someone looked at the live site.
- `JIRA_ISSUE_TRANSITION` with `issueKey` — on a pass, the column your team
  closes work in. On a fail, BACK to the column the implementing run works in,
  and say in the comment that the fix is already merged so the next run amends
  it rather than re-implementing. Do this LAST, after the comment is on the
  card. Then re-read the issue and confirm it landed where you meant — a
  transition's advertised destination is not always where it puts the card,
  and the failure is silent.
- If you cannot tell which column is which, say so in your comment and leave
  the issue where it is. A card parked with an explanation is recoverable; one
  closed without anyone having seen production is the failure this whole step
  exists to prevent.
