# Bringing a card's hypothesis

A hypothesis is the case for one post of a campaign: what it argues, for
whom, why now, what it moves toward the campaign's goal, and the figures that
say so. A person reads it on the card and approves it, adjusts it with you in
the chat, or drops it. It is the post's reason to exist, and it becomes the
draft's brief.

## 1. Read

- The card, with `BLOG_CARD_GET`: its campaign (`campaignId`) and what the
  person asked to explore (`prompt`).
- The brand, with `BLOG_STATE_GET`: `brand` (who it is, its language),
  `context` (tone, rules, don'ts, special dates), `formats`, and the card's
  campaign among `campaigns`, by id.

The campaign is where the post starts, not where it lands. Its `goal` (what
the campaign is for, counted in `goal.metric`, as far as `goal.target`, by the
end of its period), its brief (`trigger.note`), its targets, its products and
its guardrails frame everything below: the post is one step toward that goal.
Never pick another campaign, and never argue a post this one would not want.

## 2. Gather the evidence

Ask each system for figures around the campaign's subject and what the person
asked, through `CONNECTION_TOOL_CALL` (see "The store's systems" in
`SKILL.md`). A handful of calls, ten at most:

- **Search Console**, when connected: the queries on the subject, with their
  impressions, clicks, click-through rate and average position. Above all the
  ones with many impressions and few clicks, or sitting on the second page.
- **GA4**: the pages and content on the subject whose readers go on to buy —
  sessions and conversions or revenue, over the last 90 days.
- **VTEX**: what people search for (`VTEX_IS_GET_TOP_SEARCHES`), what the store
  has for the campaign's terms (`VTEX_IS_GET_PRODUCT_SEARCH`), what sells
  (`VTEX_GET_SALES_PERFORMANCE_SUMMARY`, `VTEX_GET_ORDERS_TREND`), and searches
  that find nothing.
- **Calendar**: the campaign's period, and the brand's special dates near it.
- **The goal's baseline**, when the campaign has a goal: where its metric
  stands today on the campaign's targets, from the system that counts it
  (sessions and conversions in GA4, clicks and impressions in Search Console,
  revenue in GA4 or VTEX), over the last 90 days. The post's objective moves
  it.

Keep what each answered, with the tool's name. A system that errors or
answers nothing is left out; the others carry the hypothesis.

## 3. Save the evidence first

Before any conclusion, save what the systems said, so the person sees the
ground the hypothesis stands on:

```json
{
  "hypothesis": {
    "groundingOutcome": "ok",
    "evidence": [
      {
        "source": "gsc",
        "figure": "1.240 impressões, CTR 0,8%",
        "fact": "Buscam 'sofá para sala pequena' e quase ninguém clica.",
        "tool": "<the tool's name>"
      }
    ]
  }
}
```

- `groundingOutcome`: `ok` when every system you asked answered, `partial`
  when some did, `none` when none did.
- One item per finding, three to eight in all, the strongest first.
- `source` is the system: `gsc`, `ga4`, `vtex`, `calendar` (a date from the
  brand's special dates or the campaign's period) or `brand` (the guide).
- `figure` is the number exactly as the tool gave it. No figure, no `figure`:
  a fact without a number is still evidence, an invented number is not.
- A system that did not answer gets no item. The card shows it as missing.

## 4. Save the hypothesis

```json
{
  "hypothesis": {
    "title": "<working headline>",
    "statement": "<the thesis: what the post argues, for whom, and why now>",
    "angle": "<how it differs from what is already out there>",
    "format": { "name": "<one of the brand's formats>", "value": "<its brief, verbatim>" },
    "keywords": [{ "term": "sofá para sala pequena", "volume": 1240 }],
    "guardrails": [{ "text": "<what the post must not do>", "origin": "brand" }],
    "objective": "<what this post moves, toward the campaign's goal>",
    "metric": "<what would show it worked>"
  }
}
```

- **The statement argues from the evidence**, for the campaign. Name the
  figure it rests on.
- **Format**: pick one of `formats` and copy its `name` and `value`. Do not
  invent one.
- **Keywords**: three to eight terms readers search. `volume` only when a tool
  reported it.
- **Guardrails**: from the brand's don'ts and rules (`origin: "brand"`) and
  the campaign's own (`origin: "campaign"`), only the ones this post could
  break.
- **Objective**: what this post moves, as its share of the campaign's goal:
  the figure it aims at and how that adds up to the goal ("1.500 sessões
  orgânicas por mês em mochilas, parte dos +20% em acessórios"). A number only
  when the evidence gives a baseline to aim from. When the campaign has no
  goal, never invent one: write the objective from the campaign's
  `intent.objective` (awareness, conversion…) and say in the chat that the
  campaign has no goal yet.
- **Metric**: one, measurable in the systems you read: how the objective will
  be checked, such as clicks from search for the keywords or sessions that
  reach a campaign product.

## 5. Present it and wait

In the chat, in the brand's language: the campaign and its goal first, then
the title, the statement, the post's objective, and the two or three figures
that carry it. Then stop. The person approves it from the
card, or tells you what to change.

When they ask for a change, change the card (`BLOG_CARD_UPDATE`) and present
it again. Ask the systems again only when they move the post somewhere the
evidence does not reach.
