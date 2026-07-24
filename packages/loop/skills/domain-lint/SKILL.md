---
name: domain-lint
description: Semantic lint for domain declarations (domains/<name>/DOMAIN.md). Use when writing, reviewing, or tightening a domain declaration, when the user says "lint this domain", "red-team this declaration", or after rejecting a reconciler PR ("update the declaration so this doesn't happen again"). Validates that every invariant is checkable, red-teams the text for loopholes a lazy agent could exploit, and structures an owner's loose prose into declaration format.
---

# Domain Lint

A domain declaration is a spec that an autonomous reconciler agent will obey
literally, repeatedly, unsupervised. Classic lint validates form; this skill
validates **semantics**: what behavior does this text actually authorize?

Run all three passes and report findings grouped by pass, most severe first.
For each finding, propose the concrete rewrite — never just "this is vague".

## Pass 1 — Mechanical

Reject the declaration if any of these fail:

- Every invariant and health assert has a **check**: a command, grep, query, or
  a heuristic with both good AND bad examples. No check → it does not go in.
  ("The code should be clean" is wishful thinking, not a declaration.)
- Scope lists real paths/globs that exist in the repo (verify them).
- Subjective heuristics have good **and** bad examples — good-only examples
  don't teach the boundary.
- Has a limits section (what the reconciler must never do without a human).
- Has an owner.
- Checks are runnable as written (correct commands, existing scripts).

## Pass 2 — Red-team (the heart of this skill)

Simulate the reconciler in bad faith: a literal-minded, lazy agent that wants
to look useful. Ask of every sentence:

- **What useless-but-justifiable PR does this text authorize?** ("improve
  translation quality" → a cosmetic retranslation PR every week, forever.)
- **What infinite work does it authorize?** The loop must CONVERGE: on a
  healthy domain, ten runs must produce zero PRs. Any line that always finds
  something to do is a bug in the declaration.
- **What loophole lets the agent escape scope or limits?** Ambiguous scope
  ("the i18n code") instead of globs; limits phrased as advice ("prefer not
  to") instead of prohibition.
- **Where would the agent guess?** A check that can error ambiguously, a term
  with two readings, a threshold left implicit.

For each hole: quote the offending line, state the bad PR it permits, and
propose the tightened wording or the objective check that closes it.

## Pass 3 — Authoring / restructuring

When given loose prose instead of (or alongside) a declaration — an owner's
brain-dump, a PR rejection reason — structure it into the declaration format:

- Separate: scope, checkable invariants, health asserts, runbook steps, tools,
  limits, examples.
- For each statement, either attach a concrete check or flag it as
  "not declarable yet — needs a check or examples" with a suggestion.
- For a PR rejection ("I rejected #123 because X"): produce the minimal edit to
  the declaration that would have prevented that PR. Rejections MUST become
  text — that is how the owner's judgment compounds.

## Output

```
VERDICT: pass | fail
[Pass 1] <finding> → <rewrite>
[Pass 2] <quoted line> → authorizes: <bad PR> → tighten to: <rewrite>
[Pass 3] <restructured sections or edits, ready to paste>
```

A declaration passes only when a bad-faith reconciler, given the text as-is,
could not justify a single useless PR.
