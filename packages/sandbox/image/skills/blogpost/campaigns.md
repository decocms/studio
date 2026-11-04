# Shape a campaign

A campaign is a temporary content pillar: a moment the brand writes into — a
launch, a date, a search it does not answer, stock that needs to move — with a
period, targets and an objective. You shape one: the campaign your chat's
instructions name, or, in a blogpost card's chat, the card's `campaignId`.

Studio created the campaign before your first turn, so you never create one.
Save with `BLOG_CAMPAIGN_UPDATE` on its id, sending only what changed: objects
merge, arrays replace, `null` removes, and `goals` and `briefing` are replaced
whole. You set its goals (§5). Never send `status`: approving a campaign is a
person's.

## 1. Read, and let the campaign say what comes next

- `BLOG_STATE_GET`: the `brand` (its language and `storeUrl`), the `context`
  (don'ts, special dates, keywords), the name of every other campaign in any
  status (you never repeat one) and this campaign, by its id.
- In a card's chat, also `BLOG_CARD_GET`: the card's `prompt` is what the
  person wants to explore.
- Today's date: `date +%F`.

What the campaign holds decides your step:

| It holds | You |
| --- | --- |
| No `briefings` and no `briefing` | Suggest briefings (§2–§4) |
| A `briefing` | Develop it (§5–§7) |
| `briefings` but no `briefing` | Wait for the person to choose. If they name one or write their own in the chat, save it as `briefing` and develop it |
| A developed campaign, and the person asks for changes | Change it (§8) |

## 2. Gather the evidence

Ask the store's systems (see "The store's systems" in `SKILL.md`) about what
the brand could write into now, or about what the person asked. A dozen calls
at most; lists go through files with `typegen`.

- **What sells and what has stalled**: `VTEX_GET_SALES_PERFORMANCE_SUMMARY`,
  `VTEX_GET_ORDERS_TREND`, `VTEX_GET_HOME_TOP_VIEWED_PRODUCTS`.
- **The shelf**: `VTEX_IS_GET_PRODUCT_SEARCH` and `VTEX_IS_GET_FACETS`. For each
  product keep its `productId`, name, main category, price, image URLs verbatim
  and `linkText`.
- **Where they sit**: categories and collections with their ids, from
  `VTEX_LIST_CATEGORIES`, `VTEX_LIST_COLLECTIONS`, `VTEX_SEARCH_COLLECTIONS`
  and `VTEX_GET_COLLECTION_PRODUCTS`.
- **What readers look for**: `VTEX_IS_GET_TOP_SEARCHES` and
  `VTEX_IS_GET_SEARCH_SUGGESTIONS`; Search Console's queries with many
  impressions and few clicks, or on the second page; GA4's most visited pages
  over the last 90 days.
- **The calendar**: the brand's special dates near today, and anything already
  in flight. For the date of a public moment, such as a holiday or a season,
  search with your own `WebSearch`. Nothing else comes from the web.

A system that is missing or errors is a gap to report, not a reason to stop.

## 3. Save the evidence first

One update, before any briefing:

```json
{
  "evidence": [
    {
      "source": "ga4",
      "figure": "12.400 sessões em 90 dias",
      "fact": "What the number says, in one sentence.",
      "tool": "<the tool's name>"
    }
  ]
}
```

- `source` is the system: `gsc`, `ga4`, `vtex`, `calendar` (a date from the
  brand's special dates or the web) or `brand` (the brand guide).
- Three to eight items, strongest first. `figure`, `fact` and `detail`
  follow "Evidence" in `SKILL.md`; no number, no `figure`. No item for a
  system that did not answer: the page shows it as missing.

## 4. Suggest three briefings

One update with three genuinely different readings of what the evidence
supports — a moment, a slice of the store, a search the brand does not
answer — each standing on a figure from the evidence. Three wordings of one
idea are worse than one good briefing.

```json
{
  "briefings": [
    {
      "id": "b1",
      "title": "Back to school: backpacks for February",
      "idea": "Two or three sentences: the moment, the slice of the store, why now.",
      "figure": "1.240 buscas por mochila infantil",
      "source": "vtex"
    }
  ]
}
```

`figure` is written as "Evidence" says: one number, as a reader reads it.

Present them in the chat — each title, its idea and the figure it stands on —
then say the person can pick one on the page or write their own, and wait.
Asked for others, replace the whole list.

## 5. Develop the chosen briefing

Develop the campaign from `briefing.text`, and from the suggestion it came
from when it names one. Save it in parts as each is ready — the name, trigger
and period first, then the goals, then the intent, then the guardrails:

```json
{
  "campaignName": "Back to school 2027",
  "period": { "start": "2027-01-10", "end": "2027-02-28" },
  "trigger": {
    "type": "seasonal",
    "note": "Why now, with the figures that say so and the tool behind each"
  },
  "goals": [
    {
      "text": "Grow organic traffic on backpacks",
      "metric": "organic_sessions",
      "target": "+20%"
    }
  ],
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
  "guardrails": { "avoidComplements": [], "toneOverrides": "" }
}
```

- `trigger.type`: `launch`, `seasonal`, `trend`, `seo_gap`, `inventory`,
  `partnership` or `reputation`.
- `goals`: one to three, five at most — what the campaign is for, each
  checkable by the end of its period. `metric` is the one of
  `organic_sessions`, `sessions`, `search_clicks`, `search_impressions`,
  `conversions` or `revenue` that the evidence counts it in; `target` is how
  far from where the evidence puts it today ("+20%"). With no baseline in the
  evidence, keep the goal and leave `target` empty. A campaign that still has
  a single `goal`, from before `goals`, has that goal: it goes first in the
  `goals` you send, since sending them replaces it.
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
  and description.
- **Products are a shelf, not an example**: every product that fits, up to a
  dozen. A campaign around one product reads like an ad for it.
- **A product's `id` is its storefront `productId`**, never a SKU, a group id
  or an EAN. Up to 3 images each, copied character for character.
- **Figures** (prices, stock, traffic) only as a tool returned them.
- **Dates**: a seasonal campaign carries the period it actually runs. A moment
  with no fixed date gets `null`, never a guess: a wrong date is read as a
  commitment.
- **Keywords** start from the briefing's terms and are not limited to them.
- **Guardrails** only where this campaign needs something the brand's standing
  rules do not already say. Empty is the normal case.
- **A refused write names its fix**: fix the patch and send it again, once.

## 6. Review your own work

Before presenting, judge the campaign as the person approving it would:

- `strong`: a writer could start today, and the store data backs it.
- `workable`: the idea holds, but something needs filling in or checking first.
- `weak`: too vague to write from, or resting on facts nothing confirmed.

Empty targets and products are not weak on their own when no store data came
back: say that is what needs filling, and judge the thinking. List what is
unverified or could age badly, concretely: "the price cited appears in no tool
result" beats "check the facts".

## 7. Present and wait

The campaign's name, its period, why now (with its figures and their tools),
its goals, its objective, how many targets and products it has, its keywords,
and your verdict with its risks. Then one line for each system you could not
read, and why. Close by saying a person approves it and can change its goals
on the page. Then stop.

## 8. Change on request

Read the campaign again with `BLOG_STATE_GET`, change only what was asked, and
save it with `BLOG_CAMPAIGN_UPDATE`. This holds after it is approved too: a
person adjusts a campaign through you. Its status stays theirs, and its goals
change only when they ask — except a campaign with none, which gets them (§5).

## When something is missing

| You see | Do |
| --- | --- |
| No VTEX connection in `CONNECTION_TOOLS_SEARCH` | Work from the brand and what the person asked, with empty targets and products, and say so |
| No GA4 or no Search Console | Go on with what the others said, and report the gap |
| `BLOG_CAMPAIGN_UPDATE` refuses a write | The refusal names the fix: fix the patch and send it once more. Refused again, stop and say why |
| `Agentic blog generation is off` | Say so, and stop |
