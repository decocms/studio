---
name: business-case
description: Turn an idea for a change to an online store (a button, a page section, shipping, checkout, search) into a business case the person can take to their team — the measured problem, who already does it, the money at stake, effort, tracking and the A/B test. Use when someone describes a store improvement and wants a plan, a business case or material to convince their team.
---

# business-case — from an idea to a case the team can approve

Someone had an idea for their store ("show the delivery date on the product
page", "change the buy button color", "show shipping in the cart"). Before
anyone builds it, they need to convince their team: is the problem real, how
big is it, who already does this, how much work is it, and how will we know it
worked. This skill writes that document.

Write the document in the language the person wrote in. Save it under
`/app/org/home/plans/` and tell them the path.

## Quick reference

| Task | How |
| --- | --- |
| Money at stake | `bun /app/org/public/core/business-case/business-case-math.mjs money --base <people/month> --delta-pp <x> --value <R$ per conversion> --gap-pp <gap>` |
| A/B size and duration | `bun /app/org/public/core/business-case/business-case-math.mjs ab-test --baseline <rate 0..1> --effect-pp <x> --weekly <people/week> [--exposure <0..1>]` |
| Where to save | `/app/org/home/plans/YYYY-MM-DD-<short-slug>.md` |

Both commands print JSON. Copy the numbers from it; never redo the
arithmetic yourself.

## Rules

1. **Every number carries its source and window.** "33% start checkout
   (store data lake, last 7 days)". A number you did not read from a source
   does not go in the document.
2. **Missing data is said, not guessed.** If the funnel, the traffic or the
   competitors are not available, write what is missing and how to get it.
   A short, honest case beats a complete invented one.
3. **The promise is small and named.** The gain (`delta-pp`) is a step on one
   funnel stage, between 0.3 and 3 percentage points and never more than the
   gap you measured. The full gap appears only as a ceiling, never as the
   expected result. The script enforces this; quote its `notes` when it moves
   your number.
4. **An idea is a hypothesis, not a proof.** Say what would make it wrong
   (how to refute it) next to what supports it. Only the A/B test proves it.
5. **Do not ask questions you can answer with an assumption.** State the
   assumption in the document. Ask only when the idea itself is unclear.
6. If the person stated a store goal (for example "sell more on mobile without
   spending more on media"), check the idea against it and say whether it moves
   that goal.

## Workflow

1. **Understand the idea.** Which page, which device, which funnel step it
   should move (e.g. "product viewed → added to cart", "cart → checkout").
2. **Measure the step.** Look for the store's funnel and orders with the
   tools this organization has (for example the data lake query tool for
   orders and the GA4 funnel, or Deco Analytics for page funnels, scroll and
   clicks). Get, for the step and device: people reaching it per week, the
   rate that passes, the same rate on the other device when it helps, and the
   average order value. If none of it is reachable, go on and mark the
   numbers as unknown.
3. **Look at the page and at competitors.** Open the store's page when you can
   and describe what is there today. Check two to five competitors with web
   search or by opening their pages, and write only what you actually saw,
   with the URL.
4. **Run the numbers.**
   - `money`: `base` = people reaching the step per month (weekly × 30/7);
     `value` = what one more conversion at that step is worth (average order
     value × share of people who buy after that step); `delta-pp` = your
     small, defensible gain; `gap-pp` = the measured gap, when there is one.
   - `ab-test`: `baseline` = the step's current rate; `effect-pp` = the same
     gain; `weekly` = people reaching the step per week; `exposure` = the share
     of them who would actually see the change (1 if everyone).
5. **Estimate the effort.** Front-end, back-end and QA days, and which
   sections or components change if you can read the store's code.
6. **Write the document** with the outline below and save it.
7. **Reply** with three lines: the money at stake, the test duration, and the
   path to the document.

## Document outline

```markdown
# <the change, as an action>

| At stake per month | Effort | A/B test | Competitors doing it |
| --- | --- | --- | --- |
| R$ … (if it closes … pp) | … days | … weeks | … of … |

## The idea
What changes, on which page and device, and which goal it serves.

## The problem, measured
The step, its rate, the comparison, the source and the window. Or: what is
not measured yet and how to measure it.

## Why it could work
The mechanism in one or two sentences. Evidence for, evidence against.
What result would prove the idea wrong.

## Who already does it
One line per competitor actually checked: what they do, with the URL.

## The math
| | |
| --- | --- |
| Base: people at the step per month | … (source) |
| Expected gain | +… pp (assumption) |
| Value of each extra conversion | R$ … (how) |
| **At stake per month** | **R$ …** |

Closing the whole gap would be worth R$ … per month; that is a ceiling,
not a promise.

## Effort
Front-end, back-end, QA. What changes in the code, if known.

## Tracking
Which existing events measure it and which need to be added.

## A/B test
Control vs. variant, primary metric, guardrails (revenue per visitor,
conversion of the next step), minimum detectable effect, people per group,
weeks. If it is not measurable in 8 weeks, say so and what would make it
measurable.

## Risks
What could get worse and what to watch during the test.

## What we still don't know
The gaps, and how to close each one.

## Next step
One concrete action.
```
