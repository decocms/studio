---
name: review-plan
description: Spawn parallel subagents to criticize implementation plans from multiple perspectives (duplication, correctness, security, performance, testing, architecture, scope), then improve the plan based on feedback. Use when reviewing a plan before implementation or when stress-testing a plan for gaps.
---

# Review Plan

Spawn parallel subagents, each critiquing a plan from a single perspective. Synthesize results into actionable feedback, then improve the plan and document decisions.

## When to Use

- Before implementing a plan (stress-test for gaps)
- After drafting a plan in superpowers:writing-plans
- When a plan feels risky or complex
- When you want diverse criticism without one reviewer dominating
- When a plan references specific frameworks/APIs and you want to verify against official docs

## Critique Perspectives

Dispatch one subagent per perspective. Each critic is independent.

| Perspective | Focus |
|-------------|-------|
| **Duplication** | DRY violations, repeated logic, consolidation opportunities |
| **Correctness** | Completeness, edge cases, missing steps, unclear requirements |
| **Security** | Auth, validation, sensitive data, injection risks |
| **Performance** | N+1, scalability, bottlenecks, efficiency |
| **Testing** | Coverage strategy, edge cases, integration needs |
| **Architecture** | Fit with existing patterns, dependencies, layering |
| **Scope** | YAGNI, scope creep, unnecessary features |
| **Documentation** | *(Conditional)* API docs, guides, best practices alignment (when plan mentions docs, frameworks, or external APIs) |

## Workflow

### 1. Prepare the Plan

Ensure the plan is in context (read the file or paste it). Note the plan path for subagent prompts.

### 2. Dispatch Critics in Parallel

For each perspective, spawn a subagent with a focused prompt. Use the Task tool with the critic template below.

**Standard critics (always dispatch these 7):**
- Duplication, Correctness, Security, Performance, Testing, Architecture, Scope

**Documentation critic (dispatch if):**
- Plan mentions specific frameworks, libraries, or external APIs
- Plan references documentation or docs lookup
- Plan involves integrating with third-party services
- You need to verify best practices from official sources

**Template per critic:**

```
Critique the implementation plan from the [{PERSPECTIVE}] perspective.

**Plan:** [path or paste plan content]

**Your role:** You are a critical reviewer focused ONLY on [{PERSPECTIVE}]. Be skeptical. Find gaps, risks, and oversights.

**Check:**
[PERSPECTIVE-SPECIFIC CHECKS - see below]

**Output format:**
- **Issues found:** (Blocker / Important / Minor)
- **Missing considerations:** What the plan doesn't address
- **Recommendations:** Specific improvements
- **Verdict:** Ready / Needs changes / High risk
```

#### Documentation Critic Template (when applicable)

```
Review the implementation plan against official documentation and best practices.

**Plan:** [path or paste plan content]

**Your role:** You are a documentation expert. Look up official docs, guides, and best practices for the technologies mentioned in the plan.

**Steps:**
1. Identify frameworks, libraries, APIs, or services mentioned in the plan
2. Search for and read relevant official documentation
3. Check if the plan's approach aligns with recommended patterns
4. Identify any deprecated methods, better alternatives, or missing configurations

**Check:**
- Does the plan use recommended/current APIs and patterns?
- Are there official best practices the plan should follow?
- Are there important configuration options or setup steps missing?
- Are there newer or better approaches documented?
- Are there known gotchas or warnings in the docs?

**Output format:**
- **Issues found:** (Blocker / Important / Minor) - cite specific docs
- **Missing considerations:** What the docs recommend but plan doesn't address
- **Recommendations:** Specific improvements with doc references
- **Verdict:** Ready / Needs changes / High risk
```

### 3. Synthesize Results

When all critics return:

1. **Merge by severity** – Collect Blockers from all critics first
2. **Deduplicate** – Same issue raised by multiple critics = higher priority
3. **Prioritize** – Blockers before Important, Important before Minor
4. **Present** – Structured summary with actionable next steps

### 4. Output Format

```markdown
# Review Plan Summary

## Blockers
[Must address before implementation]

## Important
[Should address]

## Minor
[Nice to have]

## Recommendations
[Improvements to consider]

## Overall Verdict
[Ready / Needs changes / High risk]
```

### 5. Improve the Plan (Replan)

Apply feedback selectively—treat feedback as guidance, not mandatory.

**For each feedback item:**
- **Adopt** – if you agree, update the plan.
- **Reject** – if you disagree, document why and leave the plan unchanged.
- **Adapt** – if partially valid, implement a middle ground.

**Document decisions** – add a short "Critique Decisions" section to the plan.

## Feedback as Guidance

**Core principle:** Critics are advisors. You are the decision-maker.

**Adopt when:**
- You agree with the reasoning
- The fix is low-cost and improves the plan
- Multiple critics flag the same issue

**Reject when:**
- You have valid counter-arguments (e.g., scope justified, YAGNI not applicable here)
- The suggestion contradicts project constraints or conventions
- It would add unnecessary complexity

**Adapt when:**
- Feedback is partially right (e.g., address the concern differently)
- You want a lighter version of the suggestion

**Never:**
- Blindly apply every critique
- Treat critic verdict as final
- Assume critics have full context (they may not)

## Critique Decisions Section

Add to the plan after the improvement pass:

```markdown
## Critique Decisions

**Adopted:** [Brief list of changes made based on feedback]

**Rejected (with reason):** [Item] – [Why you kept the original]

**Adapted:** [Item] – [How you addressed it differently]
```

## Examples

### Example 1: Standard Critique (7 critics)

```
Plan: .cursor/plans/tasks_feature_implementation_a2a999e8.plan.md

Dispatch 7 subagents in parallel:
- Task("Critique from Duplication perspective...")
- Task("Critique from Correctness perspective...")
- Task("Critique from Security perspective...")
- Task("Critique from Performance perspective...")
- Task("Critique from Testing perspective...")
- Task("Critique from Architecture perspective...")
- Task("Critique from Scope perspective...")

[Synthesize when all return] → Critique Summary

[Improve plan] → Adopt/Reject/Adapt each item

[Add Critique Decisions section]
```

### Example 2: With Documentation Lookup (8 critics)

```
Plan: .cursor/plans/react_query_integration_b3f441a2.plan.md
(Plan mentions "React Query", "TanStack Query", and "data fetching patterns")

Dispatch 8 subagents in parallel:
- Task("Critique from Duplication perspective...")
- Task("Critique from Correctness perspective...")
- Task("Critique from Security perspective...")
- Task("Critique from Performance perspective...")
- Task("Critique from Testing perspective...")
- Task("Critique from Architecture perspective...")
- Task("Critique from Scope perspective...")
- Task("Review against React Query official docs...") ← Documentation critic

[Synthesize when all return] → Critique Summary (includes doc-based recommendations)

[Improve plan] → Adopt/Reject/Adapt each item

[Add Critique Decisions section]
```

## Integration

- **superpowers:writing-plans** – Use after drafting to critique before implementation
- **plan-with-critique** – Runs plan first, then invokes this skill (review-plan)
- **superpowers:dispatching-parallel-agents** – Same pattern (independent domains)

## Red Flags

- **Don't** run critics sequentially (wastes time; perspectives are independent)
- **Don't** let one critic's verdict override synthesis (merge all)
- **Don't** spawn critics without the full plan in context (each needs the plan)
- **Don't** adopt every critique without evaluation
- **Don't** skip the Critique Decisions section (it clarifies your reasoning)
- **Don't** let critics override project conventions (e.g., CLAUDE.md patterns)
- **Don't** make the plan worse by over-incorporating feedback (e.g., scope creep from "add more")
- **Don't** skip the documentation critic when plan references specific frameworks/APIs/libraries (docs often reveal better approaches or missing steps)
- **Don't** dispatch documentation critic for generic plans without specific tech mentioned (wastes time)
