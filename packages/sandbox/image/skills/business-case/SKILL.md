---
name: business-case
description: Turn an idea for a change to an online store (a button, a page section, shipping, checkout, search) into a business case the person can take to their team — the measured problem, who already does it, the money at stake, effort, tracking and the A/B test. Builds it together with the person, one question at a time, on a live canvas. Use when someone describes a store improvement, however vague ("I want to improve search"), and wants a plan, a business case or material to convince their team.
---

# business-case — from an idea to a case the team can approve

Someone had an idea for their store ("show the delivery date on the product
page", "I want to improve search"). Before anyone builds it, they need to
convince their team: is the problem real, how big is it, who already does
this, how much work is it, and how will we know it worked.

You build that case **with** them. Studio shows the case as a canvas of cards
next to the chat, and every command below updates it live. The person watches
it fill in while you talk.

Write in the language the person wrote in.

## Quick reference

| Task | How |
| --- | --- |
| Open the canvas | `bun /app/org/public/core/business-case/business-case-canvas.mjs init --path <case> --title <t> --request <their words> --area <area> [--objective <goal>]` |
| Mark the card you are asking about | `... business-case-canvas.mjs ask --path <case> --card <key>` |
| Fill a card | `... business-case-canvas.mjs set --path <case> --card <key> --summary <text> [--bullet <text>]... [--source "<label>\|<url>"]... [--assumption <text>]` |
| Close the case | `... business-case-canvas.mjs finish --path <case> --document /app/org/home/plans/<file>.md` |
| Money at stake | `bun /app/org/public/core/business-case/business-case-math.mjs money --base <people/month> --delta-pp <x> --value <R$ per conversion> --gap-pp <gap>` |
| A/B size and duration | `bun /app/org/public/core/business-case/business-case-math.mjs ab-test --baseline <rate 0..1> --effect-pp <x> --weekly <people/week> [--exposure <0..1>]` |
| The document for the team | `/app/org/home/plans/YYYY-MM-DD-<short-slug>.md` |

`<case>` is the path the message gives you
(`/app/org/home/plans/cases/<chat id>.json`). Without one, use the chat id.
Never write the case JSON by hand; always go through the canvas script. The
math script prints JSON: copy the numbers from it and never redo the
arithmetic yourself.

### The cards

| Key | Card | What fills it |
| --- | --- | --- |
| `problem` | The problem, measured | The funnel step, its rate, the comparison, source and window |
| `scope` | What we will change | The option chosen, on which page and device; options set aside |
| `money` | Money at stake | The `money` output: monthly value and the ceiling |
| `competitors` | Who already does it | One bullet per competitor actually checked, with the URL as source |
| `measurement` | How we measure | Primary metric, guardrails, events that exist and events to add |
| `abTest` | A/B test and timeline | The `ab-test` output: people per group, weeks |
| `effort` | Effort and deliveries | Front-end, back-end, QA days; what changes in the code |
| `risks` | Risks | What could get worse and what to watch |
| `unknowns` | What we still don't know | Each gap and how to close it |

Areas: `pdp`, `search`, `category`, `home`, `cart`, `checkout`, `shipping`,
`performance`, `paid-media`, `other`.

A card's `summary` is one or two sentences a manager reads in five seconds.
Bullets are short. Put the detail in the document, not on the card.

## Rules

1. **Every number carries its source and window.** "33% start checkout
   (store data lake, last 7 days)". A number you did not read from a source
   does not go in the case.
2. **Missing data is said, not guessed.** If the funnel, the traffic or the
   competitors are not available, fill `unknowns` with what is missing and
   how to get it. A short, honest case beats a complete invented one.
3. **The promise is small and named.** The gain (`delta-pp`) is a step on one
   funnel stage, between 0.3 and 3 percentage points and never more than the
   gap you measured. The full gap appears only as a ceiling, never as the
   expected result. The script enforces this; quote its `notes` when it moves
   your number.
4. **An idea is a hypothesis, not a proof.** Say what would make it wrong
   next to what supports it. Only the A/B test proves it.
5. **Ask when the request does not say where and what.** "I want to improve
   search" does not say what in search; ask. Everything else you can assume:
   assume it, and write the assumption on the card (`--assumption`).
6. **One question at a time, with options.** Use the question tool
   (`user_ask`, type `choice`) with 3 to 5 concrete options, the recommended
   one first. Build the options from what you know about this store (its
   pages, its data, its sector), not from a generic list. Never ask in plain
   prose what the tool can ask, and never ask two things in one question.
7. If the person stated a store goal, check the idea against it and say
   whether it moves that goal.

## Workflow

### 1. Frame — before anything else

Run `init` right away, before reading data or searching: the person is
looking at an empty canvas. Title is the change as an action ("Suggest terms
when search finds nothing"); while the request is vague, use their words
("Improve search").

### 2. Converse — until you know where and what

If the message says the person already answered questions before the chat
(the Plan page's guided intro), do not ask them again: `set` the cards those
answers cover (`scope` first, then `measurement`, `effort` or `risks`; a
skipped or vague answer becomes an `--assumption`), sharpen the title with
`init`, and go to step 3. Ask in the chat only when something still blocks
the case.

If the request already says where and what ("a fit guide on the PDP would
raise conversion"), skip to step 3.

Otherwise, for each question:

1. `ask --card scope` (or the card the question fills), so the card shows
   that it is waiting for the person.
2. Ask with `user_ask`. Example for "I want to improve search": *"What
   bothers you most in search?"* → "Searches that find nothing", "Weak
   autocomplete", "Filters hard to use", "Results in a bad order".
3. With the answer, `set` the card and, when the scope is clearer, run
   `init` again with a sharper `--title` (the cards stay).

Two or three questions are usually enough. Stop asking once you know the
page, the device and the change; the rest is research.

### 3. Build — fill the cards as you learn

Fill each card the moment you have its content; do not wait to finish
everything. The person sees the canvas grow.

1. **Measure the step** (`problem`). Look for the store's funnel and orders
   with the tools this organization has (for example the data lake query
   tool for orders and the GA4 funnel, or Deco Analytics for page funnels,
   scroll and clicks). Get, for the step and device: people reaching it per
   week, the rate that passes, the same rate on the other device when it
   helps, and the average order value. If none of it is reachable, say so in
   `unknowns` and go on.
2. **Look at the page and at competitors** (`competitors`). Open the store's
   page when you can and describe what is there today. Check two to five
   competitors with web search or by opening their pages; write only what
   you actually saw, with the URL as the source.
3. **Run the numbers** (`money`, `abTest`).
   - `money`: `base` = people reaching the step per month (weekly × 30/7);
     `value` = what one more conversion at that step is worth (average order
     value × share of people who buy after that step); `delta-pp` = your
     small, defensible gain; `gap-pp` = the measured gap, when there is one.
   - `ab-test`: `baseline` = the step's current rate; `effect-pp` = the same
     gain; `weekly` = people reaching the step per week; `exposure` = the share
     of them who would actually see the change (1 if everyone). If it is not
     measurable in 8 weeks, say so and what would make it measurable.
4. **Effort, measurement, risks** (`effort`, `measurement`, `risks`).
   Front-end, back-end and QA days, and which sections or components change if
   you can read the store's code. Primary metric and guardrails (revenue per
   visitor, conversion of the next step). What could get worse.
5. **What is still unknown** (`unknowns`): every gap left, with how to close
   it.

If the person answers something mid-way that changes the scope, update
`scope` (and `init` the title) and redo only the cards it affects.

### 4. Close

1. Write the document with the outline below and save it.
2. `finish --document <its path>`.
3. Reply with three lines: the money at stake, the test duration, and the
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
