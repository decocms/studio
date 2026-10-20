---
name: jira-merge
description: Land the pull requests a set of Jira issues carry, in order, resolving a conflict when one appears, and move each card on. Insert into the prompt of a run started on a batch of issues, or of a Jira column rule that ships.
disable-model-invocation: true
---

# jira-merge — land it and move the cards

Insert this into the prompt of a run you start on several issues at once ("one
run for all of them"), or of the Jira column your team ships from. Either way
the issues are in your opening message, web links included, and every Jira
tool takes `issueKey` to say which issue it is about. On a run about one issue
you can leave it out.

It is ordinary text once inserted — read it, cut what does not apply to your
team, add what does.

---

You are landing work that has already been implemented and reviewed: the
issues above, each carrying its pull request(s) as web links.

## Find what you are landing

- The pull requests are on each issue as web links. **An issue can carry more
  than one, in different repositories** — a change that spans two storefronts
  opens one in each, and both are the delivery.
- Ignore a link to a pull request that is already closed or merged, and links
  another team's automation left. `gh pr view <url> --json state,mergeable`
  tells you.
- An issue with no open pull request gets a comment saying so and nothing
  else.

## Order

Merging one pull request moves the base under the next, so land them **one at
a time, in the order the issues are listed**, and re-check the next one's
mergeability after each merge rather than trusting what you read at the start.

## Check before you merge

- **Already merged?** Say so in a comment and move on to the card. Do not
  re-merge, and do not open anything.
- **Checks red?** Read them (`gh pr checks <url>`, then the failing run's log)
  before deciding. A check that fails the same way on the base branch is not
  this change's fault — say that in your comment and merge. A check that fails
  because of this change is a stop for THAT issue: comment what broke, leave
  its card where it is, and carry on with the next issue.
- **Blocked by branch protection or a missing approval?** That needs a human.
  Report it on the issue and move to the next one; do not try to route around
  it.

## Merge

- `gh pr merge <url>` from a checkout of THAT repository. A run can hold
  several (`mcp__studio__TASK_ADD_REPO` accumulates), and each is authenticated
  for its own host.
- **A conflict is yours to fix.** Check the branch out, merge the base branch
  into it, resolve preserving BOTH sides' intent, push to update the SAME pull
  request, then merge it. Never open a new one.
- **All or none, when an issue spans repositories.** Landing one half of a
  reciprocal change is worse than landing neither — it ships a declaration that
  only holds on one side. If you cannot land them all, land none, and say which
  one blocked you.

## Report and move each card

Per issue, as soon as that issue is settled — not one summary at the end, which
a run that dies on the tenth issue never writes:

- `mcp__studio__JIRA_COMMENT_ADD` with `issueKey` — what merged, with the pull
  request links, and anything you decided (a red check you judged
  pre-existing, a conflict you resolved and how). This is the only record: a
  merge otherwise leaves no trace on the card.
- `mcp__studio__JIRA_ISSUE_TRANSITION` with `issueKey` — move the card to where
  your team puts shipped work, LAST, after the comment. If your team's flow
  ends before that column — some hand off with a comment and let the customer
  pull the card themselves — then say so in the comment and leave the status
  alone. Moving a card into someone else's column is a handoff they did not
  agree to.
- If anything is left undone on an issue, its comment says it plainly. A card
  that reads "merged" while half of it is still open is the one failure nobody
  catches.
