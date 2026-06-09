# Plan Critic Prompts

Copy the appropriate block when dispatching each critic subagent.

---

## Duplication Critic

```
Critique this implementation plan from the DUPLICATION perspective.

**Plan:** {PLAN_PATH_OR_CONTENT}

**Your role:** Find potential DRY violations, repeated logic, or consolidation opportunities. Ask: will this plan produce duplicated code or patterns?

**Check:**
- Are similar operations repeated across tasks?
- Could multiple tasks share a helper, schema, or utility?
- Is there existing code the plan could reuse instead of reimplementing?
- Are there copy-paste risks (e.g., similar forms, handlers, types)?

**Output:**
- Issues found: (Blocker / Important / Minor)
- Consolidation opportunities
- Recommendations
- Verdict: Ready / Needs changes / High risk
```

---

## Correctness Critic

```
Critique this implementation plan from the CORRECTNESS perspective.

**Plan:** {PLAN_PATH_OR_CONTENT}

**Your role:** Find gaps in requirements, missing edge cases, unclear steps, or logic flaws.

**Check:**
- Are all requirements explicit enough to implement?
- Are edge cases (null, empty, missing) addressed?
- Is task ordering correct (dependencies respected)?
- Are there ambiguous or underspecified steps?
- Could the plan produce incorrect behavior?

**Output:**
- Issues found: (Blocker / Important / Minor)
- Missing considerations
- Recommendations
- Verdict: Ready / Needs changes / High risk
```

---

## Security Critic

```
Critique this implementation plan from the SECURITY perspective.

**Plan:** {PLAN_PATH_OR_CONTENT}

**Your role:** Find auth, validation, and sensitive data gaps.

**Check:**
- Is authentication/authorization addressed for new endpoints/flows?
- Is input validation planned (type, format, bounds)?
- Are sensitive data (tokens, secrets) handled safely?
- SQL injection, XSS, or other injection risks?
- Permission checks at the right boundaries?

**Output:**
- Issues found: (Blocker / Important / Minor)
- Missing considerations
- Recommendations
- Verdict: Ready / Needs changes / High risk
```

---

## Performance Critic

```
Critique this implementation plan from the PERFORMANCE perspective.

**Plan:** {PLAN_PATH_OR_CONTENT}

**Your role:** Find N+1 risks, scalability issues, and bottlenecks.

**Check:**
- Could loops trigger N+1 queries or repeated API calls?
- Are there anticipated hot paths or high-volume operations?
- Is pagination/batching considered where needed?
- Any expensive operations in loops or frequent paths?
- Caching or indexing considerations?

**Output:**
- Issues found: (Blocker / Important / Minor)
- Missing considerations
- Recommendations
- Verdict: Ready / Needs changes / High risk
```

---

## Testing Critic

```
Critique this implementation plan from the TESTING perspective.

**Plan:** {PLAN_PATH_OR_CONTENT}

**Your role:** Assess whether the testing strategy is adequate.

**Check:**
- Which behaviors will be tested? Which won't?
- Are edge cases and error paths covered?
- Is integration testing needed (DB, APIs, auth)?
- Are tests mentioned in the plan or assumed?
- Could implementation proceed without tests?

**Output:**
- Issues found: (Blocker / Important / Minor)
- Missing considerations
- Recommendations
- Verdict: Ready / Needs changes / High risk
```

---

## Architecture Critic

```
Critique this implementation plan from the ARCHITECTURE perspective.

**Plan:** {PLAN_PATH_OR_CONTENT}

**Your role:** Assess fit with existing patterns, dependencies, and layering.

**Check:**
- Does it follow project conventions (e.g., defineTool, StudioContext)?
- Are dependencies on the right layers (no direct DB in tools)?
- Does it integrate with existing systems correctly?
- New dependencies justified?
- Could it conflict with other features or refactors?

**Output:**
- Issues found: (Blocker / Important / Minor)
- Missing considerations
- Recommendations
- Verdict: Ready / Needs changes / High risk
```

---

## Scope Critic

```
Critique this implementation plan from the SCOPE perspective.

**Plan:** {PLAN_PATH_OR_CONTENT}

**Your role:** Find scope creep, YAGNI violations, or unnecessary features.

**Check:**
- Is everything in the plan actually needed now?
- Are there "nice to have" items that could be deferred?
- Does the plan over-engineer for hypothetical future needs?
- Could scope be reduced for a faster, safer first iteration?
- Are there features with no clear user or system need?

**Output:**
- Issues found: (Blocker / Important / Minor)
- Scope reduction opportunities
- Recommendations
- Verdict: Ready / Needs changes / High risk
```

