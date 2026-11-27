# Plan engine reasoning

Status: phase 0 shipped (the yardstick). Phases 1 to 4 are proposals, one
pull request each, measured with the yardstick before the next starts.

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

### Phase 1: typed proof for "confirmed" (ARTEX `prove_goal`, XBOW validator)

After the judge, code keeps "confirmed" only when the hypothesis has all
three of:

- **baseline:** a cited fact with `measured: true`;
- **proof:** a test with `measures_cause: true` whose outcome met the
  `confirms_if` written before it ran;
- **verification:** a second test from another source (live, repo or data).

Without all three, the verdict becomes inconclusive and the reason goes to
the lifecycle log. The +0.2 confidence step applies only when the guard
passes. Files: `verify/verdict.ts`, `verify/index.ts`, `lifecycle.ts`.

### Phase 2: hypothesis ledger across rounds (ARTEX graph, Reflexion)

A storage query returns the org's earlier hypotheses for the same domain and
page type: 90 days, at most 20 per step. Each comes with its verdict and the
page signature (`knowledge/validity.ts`). The writer receives them as "tried
in earlier rounds":

- refuted on the same page: triage drops it by `crossRunKey` unless it brings
  a new mechanism;
- refuted on a page that has since changed: one more check is allowed;
- confirmed and still open: carried as context, not written again.

Files: `storage/plan-engine.ts`, `reinvestigate.ts` (`triedLines`),
`opportunities.ts`, `triage.ts`.

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

### Phase 4: sequential falsification on data (POPPER, simplified)

Traffic, segment, device and stage causes state up to three predictions in a
closed vocabulary over the evidence already collected. For example:

- "the gap in segment A is larger than in B";
- "the effect shows on mobile and not on desktop".

Code evaluates each prediction with the existing mix adjustment
(`losses.ts` `lossResidual`, `data-checks.ts`), turns it into an e-value and
multiplies the e-values. At α = 0.1 the cause is refuted, supported or left
inconclusive. For these causes this replaces the model judge inside the
`data-checks` step. No new BigQuery queries.

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
