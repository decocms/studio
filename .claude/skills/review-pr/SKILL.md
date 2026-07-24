---
name: review-pr
description: Analyze the git diff between the current branch and main from multiple perspectives (duplication, correctness, security, performance, testing, architecture, scope) using parallel subagents, then produce a remediation plan for issues found. Use when reviewing branch changes before merge, after implementation, or when the user asks to critique or review current code changes.
---

# Review PR

Spawn parallel subagents to critique the git diff of the current branch (vs main) from independent perspectives. Synthesize findings into a prioritized remediation plan.

## When to Use

- Before merging a feature branch
- After implementation to catch issues before PR
- When you want a thorough multi-perspective review of code changes
- When the user says "review my changes" or "critique this branch"

## Critique Perspectives

One subagent per perspective. Each critic is independent.

| Perspective | Focus |
|-------------|-------|
| **Duplication** | DRY violations, repeated logic, consolidation opportunities |
| **Correctness** | Bugs, edge cases, missing error handling, logic flaws |
| **Security** | Auth, validation, sensitive data, injection risks |
| **Performance** | N+1, scalability, bottlenecks, efficiency |
| **Testing** | Coverage gaps, missing tests, untested edge cases |
| **Architecture** | Fit with existing patterns, layering violations, coupling |
| **Scope** | Unrelated changes, incomplete work, leftover debug code |

## Workflow

### 1. Gather the Diff

Run these commands to collect context for the critics:

```bash
# Get the base branch (usually main)
git merge-base main HEAD

# Full diff against main
git diff main...HEAD

# List of changed files
git diff main...HEAD --name-status

# Recent commit messages on this branch
git log main..HEAD --oneline
```

If the diff is very large, also get a `--stat` summary and split the diff by file groups when dispatching critics.

### 2. Dispatch Critics in Parallel

For each perspective, spawn a subagent with the diff content and a focused prompt. Use the Task tool with `subagent_type: "generalPurpose"` and `readonly: true`.

**Template per critic:**

```
Critique the following code changes from the [{PERSPECTIVE}] perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:** {DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** You are a critical code reviewer focused ONLY on [{PERSPECTIVE}]. Be skeptical. Find real problems, not style nitpicks.

**Check:**
[PERSPECTIVE-SPECIFIC CHECKS - see references/critic-prompts.md]

**Output format:**
- **Issues found:** (Blocker / Important / Minor) — cite file and line from the diff
- **Missing considerations:** What the changes don't address
- **Recommendations:** Specific improvements with code suggestions where possible
- **Verdict:** Ready / Needs changes / High risk
```

For full prompts per perspective, see [references/critic-prompts.md](references/critic-prompts.md).

**Important:** Each subagent needs the actual diff content. If the diff is too large for a single prompt, split by domain (e.g., backend files vs frontend files) and send relevant portions to each critic.

### 3. Synthesize Results

When all critics return:

1. **Merge by severity** — Collect Blockers from all critics first
2. **Deduplicate** — Same issue from multiple critics = higher priority
3. **Locate** — Every issue must reference specific file(s) and line(s)
4. **Prioritize** — Blockers > Important > Minor

### 4. Critique Summary

```markdown
# Review PR Summary

**Branch:** {branch_name}
**Files changed:** {count}
**Commits:** {count}

## Blockers
[Must fix before merge — file:line references]

## Important
[Should fix — file:line references]

## Minor
[Nice to have — file:line references]

## Overall Verdict
[Ready / Needs changes / High risk]
```

### 5. Create Remediation Plan

Transform findings into an actionable plan. Group by file or concern, not by critic.

```markdown
# Remediation Plan

## Tasks

### 1. [Task title — addresses Blocker/Important]
**Files:** list of files to change
**What:** Specific change description
**Why:** Which critique finding this addresses

### 2. [Next task...]
...

## Out of Scope
[Issues deliberately deferred with reasoning]
```

**Plan guidelines:**
- One task per logical fix (may span multiple files)
- Blockers become mandatory tasks; Important become recommended; Minor are optional
- Reference the critique finding each task addresses
- Keep tasks small and independently mergeable when possible
- If a finding is invalid (false positive), note it in Out of Scope with reasoning

## Feedback as Guidance

**Core principle:** Critics are advisors. You are the decision-maker.

**Act on when:**
- The issue is clearly a bug or security risk
- Multiple critics flag the same concern
- The fix is low-cost relative to the risk

**Defer when:**
- The suggestion would expand scope significantly
- It contradicts project conventions (check CLAUDE.md / AGENTS.md)
- The concern is speculative with low probability

**Reject when:**
- It's a false positive (critic misread the diff)
- The existing pattern is intentional and documented
- The "fix" would introduce more complexity than it solves

## Red Flags

- **Don't** run critics sequentially (perspectives are independent)
- **Don't** send critics a summary instead of the actual diff (they need real code)
- **Don't** include style/formatting issues (the formatter handles those)
- **Don't** create remediation tasks for false positives
- **Don't** let critics override project conventions
- **Don't** skip the remediation plan (findings without a plan are just noise)

## Integration

- **review-plan** — Similar pattern but for plans; use review-pr for code
- **superpowers:verification-before-completion** — Run after remediation to confirm fixes
- **superpowers:finishing-a-development-branch** — Use review-pr before finishing
