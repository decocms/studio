---
name: jira-release
description: Assemble a release from a batch of Jira issues — one release branch, pull request, preview and tracking issue per repository — and, when a person says to ship it, merge it and move the cards on. Insert into the prompt of a run started on a batch of issues.
disable-model-invocation: true
---

# jira-release — assemble the release, ship it when told

Insert this into the prompt of a run you start on the issues that ship
together ("one run for all of them"). The issues are in your opening message,
web links included; every Jira tool takes `issueKey` to say which issue it is
about, and reaches any issue on the board. Your team's own skill says how its
releases are named, which columns mean what, and how to build its sites —
where it disagrees with this text, it wins.

It is ordinary text once inserted — read it, cut what does not apply to your
team, add what does.

---

You are releasing work that has already been implemented and reviewed: the
issues above, each carrying its pull request(s) as web links.

**There are two phases, and this run does one.** Assemble, unless the person's
prompt says in words to ship a release that is already assembled — then ship.
Shipping merges to the main branch, which for many teams is the deploy; never
drift from assembling into shipping on your own.

## Assemble

### Group by repository

One release per repository: its own branch, pull request, preview and
tracking issue, so a rollback stays inside one site. Your team's skill says
how an issue maps to a repository; an issue with pull requests in several
repositories is in each of those releases.

For each issue, find its open pull request(s) from the web links
(`gh pr view <url> --json state,headRefName,mergeable,title`). Leave an issue
out — and say why on the issue and in the release — when it has no open pull
request, or its checks fail because of its own change.

### Build the branch

In a checkout of the repository (`mcp__studio__TASK_ADD_REPO` accumulates
them):

```
git fetch origin
git rev-parse origin/main                   # the base — record it
git checkout -B release/YYYY-MM-DD origin/main
git merge --no-ff -m "Merge <KEY> (PR #<n>): <title>" origin/<head-branch>   # per issue
```

- **One merge commit per issue**, in the order the issues are listed. That
  commit is the issue's unit: `git revert -m 1 <commit>` takes exactly one
  issue back out of the main branch later.
- **A conflict is yours to resolve**, preserving both sides' intent. Write
  down each one — file, which issues, what you kept — for the tracking issue.
  A conflict you cannot resolve without changing what one issue does leaves
  that issue out.
- A release branch from an earlier attempt today: reuse it if its pull request
  is open, merging only the issues it lacks; otherwise start over from the
  main branch.

### Check it

Build and test the release branch the way your team's skill says. Compare
against the base, not against zero: a failure the main branch has too is not
the release's, so run the same command on a clean checkout of the base and
report the delta.

### Open it

- Push, and open ONE pull request to the main branch, titled
  `release: <site> YYYY-MM-DD`. Its body tables each issue with its pull
  request, and says it is not to be merged until the release is approved.
- Wait for the preview the pull request gets, and open it once. A deploy bot may
  post it as a comment, but a release branch often gets none: the preview is
  then the GitHub deployment on the head commit —
  `gh api "repos/<owner>/<repo>/deployments?sha=<head>"`, and the
  `environment_url` of that deployment's latest status. Poll that, not the
  comments, and not `gh pr checks`, which a run's token may not be allowed to
  read.

### The tracking issue

Create it last, when there is everything to say
(`mcp__studio__JIRA_ISSUE_CREATE`): the title, type, sprint and points your
team's skill gives, `relatesTo` every issue in this release, and a description
with:

- the base commit, the branch, the release pull request and the preview;
- a table: issue, title, pull request;
- what was left out, and why;
- each conflict and what you kept;
- the checks you ran and their delta against the base.

Calling it again with the same title returns the same issue, so a restarted
run does not open a second one. Then, on it:

- `mcp__studio__JIRA_REMOTE_LINK_ADD` the release pull request
  (`key: "pull-request"`) and the preview (`key: "preview"`);
- `mcp__studio__JIRA_COMMENT_ADD` your team's pre-deploy checklist.

### Hand it over

Move every included issue AND the tracking issue to the column your team
reviews releases in (`mcp__studio__JIRA_ISSUE_TRANSITION`). An issue you left
out stays where it is, with a comment saying why. Then stop, and say plainly
that the release is assembled and waits for a person to approve and ship it.

## Ship

Only when the person's prompt says so. The batch holds the tracking issue and
the issues it ships; the release pull request is on the tracking issue.

1. **Nothing moved since the approval?** Each issue's pull request is still
   open, and its head is the commit the release branch merged
   (`git merge-base --is-ancestor`). An issue that got new commits since: merge
   them into the release branch and say so, or leave the issue out if the
   change is more than a fix of the approved one — then it needs approving
   again.
2. **Bring the main branch in.** If it moved since the base, merge it into the
   release branch, resolve, build again and push. The release must contain the
   current main branch before it lands.
3. **Merge the release pull request with a merge commit** —
   `gh pr merge <release-pr> --merge`, never squash, never rebase: the
   per-issue merge commits are what keeps each issue revertable on its own.
   Each issue's own pull request then shows as merged, since its commits are in
   the main branch; confirm that for every one.
4. **Report and move, per issue**, as it is confirmed: a comment with the
   commit that landed it (`git log --merges --grep "Merge <KEY> "`), then move
   it to the column your team validates deployed work in. The tracking issue
   gets the release's merge commit and moves with them.
5. If your team deploys from the main branch, the merge is the deploy: check
   that it went out the way your team's skill says before you report done.

Anything left undone — an issue you could not confirm merged, a deploy you
could not see — is said plainly on that issue and on the tracking issue.
