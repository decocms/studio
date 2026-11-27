# Plan engine reasoning

Status: phases 0, 1, 2 and 4 are implemented. Phase 3 adds model calls, so
it waits for a replay with human labels to show it pays off.

The Plan engine (`apps/api/src/plan-engine/`) turns a store's measured losses
into opportunities and, for each one, into competing causes that it tries to
refute. This document compares that reasoning with public agents that work
the same way in other domains, mostly autonomous penetration testing and
automated science, and lists what to take from them.

## 1. What the engine already does

| Pattern | Where |
| --- | --- |
| Numbered fact book; each fact is either measured by code or read by a model | `facts.ts` |
| Losses become opportunities in code, ranked by money × data reliability | `loss-opportunities.ts`, `reliability.ts` |
| Competing causes across six categories, each with a mechanism, how to refute it and a prediction checked against the data | `opportunities.ts` (`HYPOTHESES_SYSTEM_PDP`) |
| An adversarial critic that knocks causes down using only the data | `opportunities.ts` (`challengeHypotheses`) |
| Model-free triage before any test is paid for | `triage.ts` |
| Tests whose `confirms_if` / `refutes_if` are written before the result | `verify/plan.ts` |
| A judge, and a rewrite that gets one more round of tests | `verify/verdict.ts`, `verify/index.ts` |
| Reinvestigation with the causes that fell, then reserves | `reinvestigate.ts`, `run/verify-steps.ts` |
| An independent reviewer that can only lower a cause | `review.ts` |
| A knowledge base with verdicts, team decisions and decay when the page changes | `knowledge/` |
| Priority computed in code, ignoring the model's own confidence | `priority.ts` |

## 2. What the public agents do that the engine does not

**ARTEX** is an autonomous multi-agent pentest framework in Go, AGPL-3.0, now
closed upstream. The live forks are `cskwork/scopeweaver` and `Hinln/ARTEX`.
It keeps a graph of `goal`, `intent` (an open hypothesis), `fact` and
`finding` nodes, each marked `observed` or `inferred`, with lineage between
them. Its planner:

- proposes the next directions only from the round's changes;
- deduplicates by a one-sentence summary;
- re-checks an inferred negative at most once;
- must never leave the frontier empty while a goal is unmet.

A goal is proved only by citing a node whose measured values meet the
requirement. A finding binds its evidence by role (`baseline`, `proof`,
`verification`), and one invalid reference rejects the whole finding.

**ARTEMIS** (Stanford, `Stanford-Trinity/ARTEMIS`, Apache-2.0) is a supervisor
with sub-agents and a triage step. Findings that fail validation go back to
the supervisor. **XBOW** validates every finding with a separate agent and a
proof that is hard to fake. **PentestGPT** (`GreyDGL/PentestGPT`, MIT) holds
its task tree outside the model's context.

**POPPER** (`snap-stanford/POPPER`, arXiv 2502.09858, no license file) tests
a hypothesis through falsifiable sub-hypotheses. Each result becomes an
e-value, and the product of the e-values controls the Type-I error.
**Google's AI co-scientist** (arXiv 2502.18864, no public code) generates
many hypotheses, critiques them, and ranks them in a pairwise tournament
before evolving the best ones. **Reflexion**, **Tree of Thoughts**, **LATS**,
**Data Interpreter** (MetaGPT) and **DS-Agent** cover retrying with a lesson,
branching, tree search and case reuse. **BLADE** and **DiscoveryBench**
evaluate data-driven hypothesis work.

Licenses: take ideas only. ARTEX is AGPL and POPPER has no license, so no
code is copied from either.

The engine has five gaps when compared with these agents:

1. No way to tell whether a change improved the reasoning. `eval.ts` existed;
   the script it named did not.
2. A "confirmed" verdict comes from a model judge. Nothing in code requires a
   measured baseline and a second, independent test.
3. Causes from earlier rounds do not reach the writer, except through the
   knowledge base. A refuted cause can come back the following week.
4. One pass writes at most three causes per opportunity, and all of them
   reach verification, which is the expensive part.
5. Traffic, segment and device causes are settled by one data check, with no
   control over how often a wrong cause is accepted.

## 3. Phases

### Phase 0: the yardstick (done)

`apps/api/scripts/plan-ux-eval.ts` reads stored diagnoses
(`PLAN_UX_DIAGNOSIS_GET` JSON) and human labels (`EvalLabel`). It reports:

- opportunities with a comparison, and titles that read as a cause;
- hypotheses that cite a fact, and "fato" claims the cited facts support;
- lifecycle outcomes;
- hypotheses per category;
- agreement with the human labels;
- causes proposed again after an earlier round of the same store and page
  refuted them (`repeatedRefutedCauses`, keyed by `crossRunKey` in
  `triage.ts`).

`--replay` runs the writer and the critic again on each diagnosis's stored
evidence and opportunities, with the code checked out now, and prints stored
→ replayed metrics and the model cost. Diagnoses and labels carry store data,
so keep them outside the repository.

The first baseline used 14 rounds stored by the external engine on
2026-11-16, covering five page types of one store. Those rounds predate fact
citations, so the replay of the same evidence with today's code is the
baseline later phases must beat.

| Metric | Value |
| --- | --- |
| Hypotheses | 50 |
| ux | 24 |
| traffic | 10 |
| technology | 6 |
| commercial | 5 |
| trust | 4 |
| performance | 1 |
| Refuted | 16% |
| Ready for an experiment | 10% |
| Opportunity titles that read as a cause | 14 of 25 |
| Causes repeated after a refutation | 0 |

The repeat check sees only causes with a target. Most traffic and commercial
causes have none.

### Phase 1: graded confirmation (ARTEX typed evidence, XBOW validator)

The first plan was a hard guard: keep "confirmed" only with a measured
baseline, a proof test and a second test from another source. The baseline
rounds showed it would demote 11 of 12 confirmed hypotheses. Only one had two
confirming tests, and none had them from two sources. So a confirmation now
carries its strength instead:

- **corroborated:** confirming tests from at least two vantage points. The
  code counts as one; the live page and the data count once per screen.
- **isolated:** one vantage point decided.

Corroborated adds 0.2 to the confidence and isolated adds 0.1, both capped at
0.9. The dossier, which the independent reviewer reads, says which kind of
confirmation it was. A code answer that cites a line the file does not have
no longer decides; before, only a missing file was caught. Files:
`verify/verdict.ts` (`confirmationStrength`), `verify/index.ts`,
`verify/types.ts`, `verify/repo.ts`, `dossier.ts`.

### Phase 2: refuted causes blocked in code (ARTEX negatives, Reflexion)

Memory across rounds already existed: each verdict becomes a knowledge entry
(`knowledge/learn.ts`) with the page signature, and the entry goes stale when
the page changes (`knowledge/validity.ts`). It reached the model only through
the prompt, though, and only when selected among the other entries. Now each
hypotheses call (first round, reinvestigation and reserve) does three things:

- reads the refuted verdicts that still hold for this page type, up to 40,
  plus the hypotheses behind them (`listHypothesesByIds`, scoped to the org);
- lists them in the prompt;
- has triage drop a cause with the same `crossRunKey` (category, target,
  funnel step).

A page that changed lets the cause be tried once more, since its verdict is
stale. Refuting it again records a verdict on the new page. Team dismissals
stay as prompt context only: they are judgment, not evidence. Files:
`ledger.ts`, `run/ledger.ts`, `triage.ts`, `opportunities.ts`,
`storage/plan-engine.ts`.

### Phase 3: write wide, verify narrow (co-scientist, Tree of Thoughts)

Two independent writer passes per batch, with different lenses:

- data, traffic and commercial causes;
- UX, performance, trust and technology causes.

They are merged and deduplicated by `triageKey`, then go through the existing
critic. The survivors meet in a pairwise tournament (`smart` tier,
temperature 0): which cause better explains the measured gap, and which can
be tested with the tools we have. Code computes Elo-style scores, the top
three go to verification, and the rest stay as reserve causes. A constant
next to `HYPOTHESES_BATCH` caps the number of calls, and their cost goes to
`plan_cost_events`. The phase ships only if the yardstick shows more human
acceptance at an agreed cost per opportunity.

### Phase 4: segment verdicts beyond sampling noise (POPPER, simplified)

The data check (`data-checks.ts`) already decides traffic causes in code,
with no model judge. Its segment comparison used ratios alone, though: a
desktop segment of 40 users at 25% "converted like the rest" and refuted the
cause. Now each side of the comparison is a one-sided test at 5%
(`zAgainst`):

- **confirm** needs the segment below the rest beyond noise on both screens;
- **refute** needs the "worse" zone (below 85% of the rest) ruled out on the
  other screen, not just a close number.

Otherwise the cause stays undecided, and the observation gives the sample
sizes. This controls how often a data verdict is wrong, which is the part of
POPPER that fits without new queries. Sequential e-values over several
predictions are left for when the model writes typed predictions.

### Left out

- **ARTEX's open-ended planner and worker pool.** It conflicts with the
  durable DBOS workflow, where a paid step runs once, and with cost control.
  Revisit once the yardstick shows where the reasoning fails.
- **ARTEX's cold-graph digests, MCTS and LATS.** Runs are short, and each
  verification step is expensive.

## 4. References

- ARTEX fork: https://github.com/cskwork/scopeweaver (`agent/planner.go`, `agent/goals.go`, `agent/finding_workflow.go`, `agent/terminal_proof.go`)
- ARTEMIS: https://github.com/Stanford-Trinity/ARTEMIS, https://arxiv.org/abs/2512.09882
- PentestGPT: https://github.com/GreyDGL/PentestGPT
- XBOW validators: https://xbow.com/whitepaper/autonomous-pentesting-without-false-positives
- POPPER: https://github.com/snap-stanford/POPPER, https://arxiv.org/abs/2502.09858
- AI co-scientist: https://arxiv.org/abs/2502.18864
- Reflexion: https://github.com/noahshinn/reflexion
- Tree of Thoughts: https://github.com/princeton-nlp/tree-of-thought-llm
- LATS: https://github.com/andyz245/LanguageAgentTreeSearch
- Data Interpreter: https://github.com/FoundationAgents/MetaGPT
- DS-Agent: https://github.com/guosyjlu/DS-Agent
- BLADE: https://github.com/behavioral-data/BLADE
- DiscoveryBench: https://github.com/allenai/discoverybench
