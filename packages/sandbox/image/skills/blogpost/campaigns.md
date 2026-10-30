# Propose campaigns from a seed

A campaign is a temporary content pillar: a moment the brand writes into — a
launch, a date, a search it does not answer, stock that needs to move — with a
period, targets and an objective. A person gave you a seed: a sentence about
the moment, and sometimes a name and terms. Your chat's instructions name the
seed and the ids your drafts are written under.

This phase has no card and no branch. Where `SKILL.md` says to save on the
card, say it in the chat instead.

## 1. Read

- `BLOG_STATE_GET`: the `brand` (its language and `storeUrl`), the `context`
  (don'ts, special dates, keywords), the name of every campaign in any status
  (you never repeat one, drafts included) and the seed, by the id your
  instructions name.
- Today's date: `date +%F`.

## 2. Gather the evidence

Ask the store's systems about the seed's subject (see "The store's systems" in
`SKILL.md`). A dozen calls at most; lists go through files with `typegen`.
Keep what each answered, with the tool's name, in `/tmp/campaigns/evidence.txt`.

- **What sells and what has stalled**: `VTEX_GET_SALES_PERFORMANCE_SUMMARY`,
  `VTEX_GET_ORDERS_TREND`, `VTEX_GET_HOME_TOP_VIEWED_PRODUCTS`.
- **The shelf for the seed's terms**: `VTEX_IS_GET_PRODUCT_SEARCH` and
  `VTEX_IS_GET_FACETS`. For each product keep its `productId`, name, main
  category, price, image URLs verbatim and `linkText`.
- **Where they sit**: categories and collections with their ids, from
  `VTEX_LIST_CATEGORIES`, `VTEX_LIST_COLLECTIONS`, `VTEX_SEARCH_COLLECTIONS`
  and `VTEX_GET_COLLECTION_PRODUCTS`.
- **What readers look for**: `VTEX_IS_GET_TOP_SEARCHES` and
  `VTEX_IS_GET_SEARCH_SUGGESTIONS`; Search Console's queries on the subject
  with many impressions and few clicks, or on the second page; GA4's landing
  pages on the subject over the last 90 days.
- **The calendar**: the brand's special dates near today, and anything already
  in flight. For the date of a public moment, such as a holiday or a season,
  search with your own `WebSearch`. Nothing else comes from the web.

A system that is missing or errors is a gap to report, not a reason to stop.

## 3. How many

The count in the ask is a maximum, not a quota. When the seed pins the campaign
down (a named date, one product line, a single angle), propose one. Propose
more only when the seed admits genuinely different readings, and say what
makes each one different. Three near-duplicates are worse than one good
campaign: the person has to read all three to find that out.

## 4. Write each campaign

As soon as one is ready, write it with one `BLOG_STATE_SET` call, under the
next id your instructions name:

```json
{
  "campaigns": [
    {
      "id": "<the next id>",
      "data": {
        "campaignName": "Back to school 2027",
        "seedKey": "blog-manager/campaign-seeds/<the seed's id>",
        "status": "draft",
        "period": { "start": "2027-01-10", "end": "2027-02-28" },
        "trigger": {
          "type": "seasonal",
          "note": "Why now, with the figures that say so and the tool behind each"
        },
        "intent": {
          "objective": "conversion",
          "targets": [
            {
              "kind": "category",
              "id": "12",
              "name": "Backpacks",
              "url": "https://<store>/backpacks",
              "description": "What falls inside, and who it is for"
            }
          ],
          "products": [
            {
              "id": "<productId>",
              "name": "<name>",
              "url": "https://<store>/<linkText>/p",
              "images": ["<image URL, verbatim>"],
              "category": "<main category>",
              "description": "<what it is, for whom>"
            }
          ],
          "keywords": ["<what the campaign wants to be found by>"]
        },
        "guardrails": { "avoidComplements": [], "toneOverrides": "" },
        "createdAt": "<now, ISO 8601>",
        "updatedAt": "<now, ISO 8601>"
      }
    }
  ]
}
```

- `trigger.type`: `launch`, `seasonal`, `trend`, `seo_gap`, `inventory`,
  `partnership` or `reputation`.
- `intent.objective`: `awareness`, `education`, `conversion`, `retention` or
  `repositioning`.
- `targets[].kind`: `category` or `collection`.
- `guardrails.avoidComplements`: rules `{ "name", "value" }` added to the
  brand's don'ts for this campaign only.

The rules:

- **The brand's language** for every name, note and description.
- **Never invent the store.** Targets and products come only from what a tool
  reported. With no store data, leave both lists empty and say so in the note.
  A made-up product URL is worse than a blank field: a blank field asks to be
  filled, a wrong URL gets published.
- **Links are the store's.** Join the brand's `storeUrl` to the path or
  `linkText` a tool reported (`<storeUrl>/<linkText>/p` for a product). Never
  use a host a tool handed you (`*.vtexcommercestable.com.br` and the like),
  and never guess a slug. Without a store address, leave `url` empty.
- **A collection has no address**: its `url` is `""` and its `id` is required.
- **A product without a link is still a product**: keep its id, name, category
  and description, and the person completes it in the editor.
- **Products are a shelf, not an example**: every product that fits, up to a
  dozen. A campaign around one product reads like an ad for it.
- **A product's `id` is its storefront `productId`**, never a SKU, a group id
  or an EAN. Up to 3 images each, copied character for character.
- **Figures** (prices, stock, traffic) only as a tool returned them.
- **Dates**: a seasonal campaign carries the period it actually runs. A moment
  with no fixed date gets `null`, never a guess: a wrong date is read as a
  commitment.
- **Keywords** start from the seed's terms and are not limited to them.
- **Guardrails** only where this campaign needs something the brand's standing
  rules do not already say. Empty is the normal case.
- **No `goal`**: a person sets it.
- **A refused write names its fix**: fix that record and write it again, once.

## 5. Review your own work

Before presenting, judge each campaign as the person choosing between them
would:

- `strong`: a writer could start today, and the store data backs it.
- `workable`: the idea holds, but something needs filling in or checking first.
- `weak`: too vague to write from, a near-duplicate of another, or resting on
  facts nothing confirmed.

Empty targets and products are not weak on their own when no store data came
back: say that is what needs filling, and judge the thinking. List what is
unverified or could age badly, concretely: "the price cited appears in no tool
result" beats "check the facts".

## 6. Present and wait

For each campaign: its name, its period, why now (with its figures and their
tools), its objective, how many targets and products it has, its keywords,
and your verdict with its risks. Then one line for each system you could not
read, and why. Close by saying they are drafts in Campaigns, where a person
sets the goal and activates the ones worth running. Then stop.

When the person asks for a change, read the campaign again with
`BLOG_STATE_GET`, change only what was asked, and write the whole record back
with its version as `expect`.

## When something is missing

| You see | Do |
| --- | --- |
| No VTEX connection in `CONNECTION_TOOLS_SEARCH` | Propose from the seed and the brand alone, with empty targets and products, and say so |
| No GA4 or no Search Console | Go on with what the others said, and report the gap |
| `BLOG_STATE_SET` refuses a write | The refusal names the fix: fix the record and write once more. Refused again, stop and say why |
| `Agentic blog generation is off` | Say so, and stop |
