# Bringing a card's hypothesis

A hypothesis is the case for one post: what it argues, for whom, why now, and
the figures that say so. A person reads it on the card and approves it,
adjusts it with you in the chat, or drops it. It is the post's reason to
exist, and it becomes the draft's brief.

## 1. Read

- The card, with `BLOG_CARD_GET`: its campaign (`campaignId`) and what the
  person asked to explore (`prompt`).
- The brand, with `BLOG_STATE_GET`: `brand` (who it is, its language),
  `context` (tone, rules, don'ts), `formats`, and the card's campaign among
  `campaigns`, by id. The campaign is the frame: its brief, its products and
  its own guardrails.

## 2. Ground

One call to `BLOG_SITE_GROUND`, through a file:

```json
{
  "purpose": "hypothesis",
  "focus": "<campaign name>: <campaign brief>. <what the person asked, if anything>",
  "language": "<brand.language>"
}
```

It reads the store's VTEX and GA4, and its Search Console when connected, and
answers with a `report` of figures and the `outcome`. Read the report.

## 3. Save the evidence first

Before any conclusion, save what the systems said, so the person sees the
ground the hypothesis stands on:

```json
{
  "hypothesis": {
    "groundingOutcome": "<outcome>",
    "evidence": [
      {
        "source": "gsc",
        "figure": "1.240 impressões, CTR 0,8%",
        "fact": "Buscam 'sofá para sala pequena' e quase ninguém clica.",
        "tool": "gsc_<tool name from the report>"
      }
    ]
  }
}
```

- One item per finding, three to eight in all, the strongest first.
- `source` is the system: `gsc`, `ga4`, `vtex`, `calendar` (a date from the
  brand's special dates or the campaign's period) or `brand` (the guide).
- `figure` is the number exactly as the report gave it. No figure, no
  `figure`: a fact without a number is still evidence, an invented number is
  not.
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
    "metric": "<what would show it worked>"
  }
}
```

- **The statement argues from the evidence.** Name the figure it rests on.
- **Format**: pick one of `formats` and copy its `name` and `value`. Do not
  invent one.
- **Keywords**: three to eight terms readers search. `volume` only when a tool
  reported it.
- **Guardrails**: from the brand's don'ts and rules (`origin: "brand"`) and
  the campaign's own (`origin: "campaign"`), only the ones this post could
  break.
- **Metric**: one, measurable in the systems you read, such as clicks from
  search for the keywords or sessions that reach a campaign product.

## 5. Present it and wait

In the chat, in the brand's language: the title, the statement, and the two
or three figures that carry it. Then stop. The person approves it from the
card, or tells you what to change.

When they ask for a change, change the card (`BLOG_CARD_UPDATE`) and present
it again. Ground again only when they move the post somewhere the evidence
does not reach.
