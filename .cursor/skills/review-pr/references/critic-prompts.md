# Review Critic Prompts

Copy the appropriate block when dispatching each critic subagent. Replace `{BRANCH_NAME}`, `{FILE_LIST}`, `{DIFF_CONTENT}`, and `{COMMIT_LOG}` with actual values.

---

## Duplication Critic

```
Critique these code changes from the DUPLICATION perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:**
{DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** Find DRY violations, repeated logic, or missed consolidation opportunities in the changed code. Compare new code against itself AND against the existing codebase patterns you can see in the diff context.

**Check:**
- Does the new code duplicate logic already present elsewhere in the diff?
- Are there similar handlers, schemas, or utilities that could be shared?
- Could existing helpers or abstractions be reused instead of new code?
- Are there copy-paste patterns (similar functions, near-identical components)?
- Do new types or interfaces overlap with existing ones?

**Output:**
- **Issues found:** (Blocker / Important / Minor) — cite file:line
- **Consolidation opportunities:** specific suggestions
- **Recommendations:** what to extract, merge, or reuse
- **Verdict:** Ready / Needs changes / High risk
```

---

## Correctness Critic

```
Critique these code changes from the CORRECTNESS perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:**
{DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** Find bugs, logic flaws, missing edge cases, and incomplete implementations.

**Check:**
- Are there off-by-one errors, null/undefined risks, or type mismatches?
- Are error paths handled (try/catch, error returns, promise rejections)?
- Do conditional branches cover all cases?
- Are new functions called with correct arguments everywhere?
- Do database operations handle failures and rollbacks?
- Are there race conditions or async ordering issues?
- Do removed lines break existing functionality?

**Output:**
- **Issues found:** (Blocker / Important / Minor) — cite file:line
- **Missing considerations:** edge cases, error paths, untested states
- **Recommendations:** specific fixes with code suggestions
- **Verdict:** Ready / Needs changes / High risk
```

---

## Security Critic

```
Critique these code changes from the SECURITY perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:**
{DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** Find authentication, authorization, validation, and data safety gaps.

**Check:**
- Are new endpoints or tools protected with proper auth checks?
- Is user input validated before use (type, format, bounds, length)?
- Are SQL queries parameterized (no raw string interpolation)?
- Are secrets, tokens, or credentials exposed in logs, responses, or client code?
- Are permission checks at the right boundaries (not just UI-level)?
- Could any change allow privilege escalation or data leakage?
- Are new dependencies trustworthy (no known vulnerabilities)?

**Output:**
- **Issues found:** (Blocker / Important / Minor) — cite file:line
- **Missing considerations:** unprotected paths, validation gaps
- **Recommendations:** specific mitigations
- **Verdict:** Ready / Needs changes / High risk
```

---

## Performance Critic

```
Critique these code changes from the PERFORMANCE perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:**
{DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** Find N+1 queries, scalability risks, and unnecessary computation.

**Check:**
- Are there database queries or API calls inside loops?
- Could operations be batched instead of sequential?
- Are there missing indexes for new query patterns?
- Do new list/search endpoints have pagination?
- Are there expensive computations on hot paths?
- Could lazy loading or caching reduce redundant work?
- Do new event handlers or subscriptions create memory leak risks?

**Output:**
- **Issues found:** (Blocker / Important / Minor) — cite file:line
- **Missing considerations:** scalability limits, expected data volumes
- **Recommendations:** specific optimizations with code suggestions
- **Verdict:** Ready / Needs changes / High risk
```

---

## Testing Critic

```
Critique these code changes from the TESTING perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:**
{DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** Assess whether the changes have adequate test coverage.

**Check:**
- Are there new test files for new functionality?
- Do existing tests still cover the modified behavior?
- Are error paths and edge cases tested?
- Are integration tests needed (DB, API, auth flows)?
- Could the changes break existing tests that weren't updated?
- Are there complex conditionals or branching logic without tests?
- Is the happy path tested end-to-end?

**Output:**
- **Issues found:** (Blocker / Important / Minor) — cite file:line
- **Missing considerations:** untested paths, coverage gaps
- **Recommendations:** specific test cases to add
- **Verdict:** Ready / Needs changes / High risk
```

---

## Architecture Critic

```
Critique these code changes from the ARCHITECTURE perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:**
{DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** Assess whether the changes fit existing patterns and maintain clean layering.

**Check:**
- Do new tools use defineTool() and StudioContext correctly?
- Are database operations going through ctx.storage (not raw Kysely)?
- Are HTTP objects leaking into tool handlers?
- Do new components follow existing UI patterns?
- Are imports respecting package boundaries (no cross-app imports)?
- Are new dependencies justified and on the correct layer?
- Could these changes conflict with other in-progress work?

**Output:**
- **Issues found:** (Blocker / Important / Minor) — cite file:line
- **Missing considerations:** pattern violations, coupling risks
- **Recommendations:** how to align with existing architecture
- **Verdict:** Ready / Needs changes / High risk
```

---

## Scope Critic

```
Critique these code changes from the SCOPE perspective.

**Branch:** {BRANCH_NAME}
**Changed files:** {FILE_LIST}
**Diff:**
{DIFF_CONTENT}
**Commit messages:** {COMMIT_LOG}

**Your role:** Find unrelated changes, incomplete work, or leftover artifacts.

**Check:**
- Are all changes related to the branch's stated purpose (commit messages)?
- Are there TODO/FIXME/HACK comments left in new code?
- Is there debug logging, console.log, or commented-out code?
- Are there unrelated formatting or refactoring changes mixed in?
- Is the work complete or are there half-implemented features?
- Are there changes that should be in a separate PR?

**Output:**
- **Issues found:** (Blocker / Important / Minor) — cite file:line
- **Scope reduction opportunities:** changes to split out
- **Recommendations:** what to remove, defer, or separate
- **Verdict:** Ready / Needs changes / High risk
```

