# Repository upkeep plan

Status: proposal. Nothing here is implemented yet.

## Decision

Keeping a project's repository in good shape is ordinary work that moves
through the project lifecycle. It is not a separate cleanup screen. When a
project has a bound GitHub repository, Studio:

1. **Context:** understands what the repository is for, from its code, its
   recent history, and the organization context.
2. **Plan:** reviews the open pull requests and issues against that purpose
   and proposes upkeep cards in Triage, each with the evidence behind it.
3. **Execute:** carries out the cards a person approves, such as commenting
   and closing, rebasing, merging, or opening a fix pull request.
4. **Monitor:** tracks repository health over time and proposes new cards
   when it degrades.

The board already covers this lifecycle (`triage` → … →
`post_deploy_validation` → `done`), and `TASK_BOARD_DISMISSED_*` already
records rejected proposals. Upkeep adds a producer of proposals, not new
board machinery.

## What exists

| Need | Already in the codebase |
| --- | --- |
| List, read, and merge open pull requests, and read their checks | `ChangeRequestClient` (`apps/api/src/git-providers/change-requests.ts`) |
| Read the tree, files, code search, and merged history over a window | `RepoInsightsClient` (`apps/api/src/git-providers/insights.ts`) |
| Lexical pre-filter, then an LLM verdict accepted only at high confidence | `tools/task-board/duplicate-check.ts` |
| Run board work with no user attached | `tools/task-board/org-context.ts` and the DBOS sweeps |
| Agent review of a pull request | `enqueue-reviewer.ts`, `review-sweeper.ts` |
| Remember rejected proposals | `tools/task-board/dismissed.ts` |
| Issue client shape (search, comment, transition) | `apps/api/src/jira/client.ts` |

## What is missing

- **Git provider issues.** No provider client reads or writes issues.
- **A repository brief:** a short, cached statement of what the repository is
  for, used as the yardstick for every verdict.
- **Upkeep verdicts** for open pull requests and issues, with evidence.
- **Proposal cards** that group verdicts so one approval clears a batch.
- **Health metrics** for the Monitor stage.

## Request budget

Worst case for one repository, when every call fails and is retried once:

| Step | Cap | Provider reads | LLM calls |
| --- | --- | --- | --- |
| Brief (README, tree, 30 merged PRs, up to 20 files) | 1 per day | about 25 | 1 |
| Open pull requests: `read` + checks + comments | 50 | about 150 | at most 50, judgement verdicts only |
| Open issues: list + comments | 100 | about 105 | at most 100, judgement verdicts only |
| **Total, doubled for retries** | | **about 560** | **about 300** |

This runs only on a schedule into a snapshot. Opening the board reads the
snapshot and never calls GitHub. Each run has a per-repository read budget
and stops when it is spent, and records `partial` instead of a clean result.
A failed run gets a short negative cache. A rebuild never replaces a good
snapshot with a worse one.

## Phases

Everything sits behind a new org flag, `repoUpkeep`, which is off by default
(see `packages/shared/AGENTS.md`).

### 1. Issues in the git provider contract

- Add `IssueClient` next to `ChangeRequestClient`: `listOpen(limit)`,
  `read(number)`, `comment(number, body)`, `close(number, reason)`.
- GitHub first. A repository on GitLab or Bitbucket reads like one with
  issues turned off until those clients exist.
- Exclude pull requests from GitHub's issues endpoint.
- The factory in `clients.ts` lands with its first caller, the phase 2 sweep.
- Tests: empty repository, a repository with issues disabled, pagination at the
  cap, a 403 or 404 reported as a failure rather than as "no issues".

### 2. Repository brief (Context)

- DBOS workflow, daily per bound repository, using `buildOrgContext`.
- Input: README, top-level tree, recent merged pull requests, and the
  project's org context files.
- Output: purpose, active areas, abandoned areas, and conventions, stored as a
  snapshot keyed by `(organization_id, repository_id)`.
- Rebuild when the default branch moves past a threshold, not on every push.

### 3. Verdicts (Plan)

Signals the code can compute come first, and the LLM only judges what they
cannot settle:

| Verdict | Decided by |
| --- | --- |
| `stale` (no activity for N days, author inactive) | code |
| `needs_rebase` (conflicts, or behind the base by more than N commits) | code |
| `ci_failing` | code (`summarizeChecks`) |
| `merge_ready` (approved, green, no conflicts) | code |
| `already_fixed` (a merged PR or commit references or resolves it) | code first, LLM to confirm |
| `duplicate_of` / `superseded_by` | lexical pre-filter, then LLM (`duplicate-check` pattern) |
| `out_of_scope` (contradicts the brief) | LLM, high confidence only |
| `keep` | default |

Each verdict carries evidence links (commit, pull request, file and line) and a
confidence score. Low-confidence verdicts become `keep`.

### 4. Proposal cards (Plan → Execute)

- One Triage card per repository and verdict group, for example "Close 9 stale
  pull requests". The card lists every item with its evidence, and all items
  start selected.
- Approving the card moves it to `todo`. Items a person deselects go to the
  dismissed list, so they are not proposed again until something changes.
- Idempotent per item and verdict, so a rerun updates the open card instead of
  adding a second one.
- No automatic actions in the first version. Closing someone else's issue is a
  public action that needs approval.

### 5. Execution

- An approved card runs as a normal task run with new tools: `ISSUE_COMMENT`,
  `ISSUE_CLOSE`, `CHANGE_REQUEST_CLOSE`, plus the existing merge.
- Each close posts a comment that gives the reason and links the evidence.
- A pull request needing a rebase or fix gets its own coding task through the
  existing sandbox path.
- Re-read the item before acting. If it changed since the verdict, skip it and
  report the skip.

### 6. Monitor

- Health per repository: open pull request count, median pull request age,
  issues older than 90 days, the default branch's CI state, and the share of
  open items with a verdict other than `keep`.
- After an upkeep card runs, `post_deploy_validation` confirms the numbers
  moved.
- A threshold breach opens a Triage card, deduplicated against the open ones.

## Open questions

- Does the Monitor stage get its own surface now, or start as a section of the
  project page until the Monitor module ships?
- Should merging the author's own green bot PRs be the first action allowed to
  run without approval?
- Thresholds (stale days, how far behind counts as needing a rebase) as
  project settings or fixed defaults?
- Should a repository with no project get a brief at all, or does binding a
  repository to a project turn upkeep on?

## Verification

- Unit tests per phase, following `TESTING.md`.
- Seed a test repository with stale, duplicate, conflicting, and green pull
  requests and issues. Check the proposed cards match, and that two runs
  produce one card.
- Count the provider calls in a run and compare them with the budget above.
