---
name: blogpost
description: Work an organization's content track — shape a campaign from briefings, bring a blogpost card's hypothesis from the store's own data, then write the post yourself on the card's branch. Use when you are running in a campaign's chat or a blogpost card's chat, or are asked to shape a campaign or to bring or execute a card's hypothesis.
---

# blogpost — work the content track

A card is one blog post of one campaign, on its way from the campaign it
belongs to, through the hypothesis that argues for it, to the draft a person
reviews. A card with no approved campaign starts by shaping one. It lives in the brand folder,
`/app/org/home/brands/<brand>/cards/<id>.json`, and the board shows it as you
save it. Your chat's instructions name the card, its site and its branch. A
campaign's own chat has no card: its instructions name the campaign it shapes.

You do the thinking and the writing: read the store's systems, argue the
hypothesis, write the post. Studio's tools give you what only Studio has (the
card, the brand, the site's blocks, the images) and check and commit what you
wrote.

| Phase | File | Ends with |
| --- | --- | --- |
| Shape the campaign | `campaigns.md` (in this skill folder) | The campaign developed from the chosen briefing, presented in the chat |
| Bring the hypothesis | `hypothesis.md` (in this skill folder) | The hypothesis on the card, presented in the chat |
| Write the post | `execute.md` (in this skill folder) | The draft committed on the card's branch, the card in `awaiting_review` |

Read the file for the phase you were asked for, and follow it. Writing the
post also reads `writing.md`, how a post reads like the brand rather than a
model, and hands the draft to an editor that follows `review-prose.md`.

## The card

- **Read it first, every turn**, with `BLOG_CARD_GET`. A person may have
  edited it since your last turn, and the card wins over your memory.
- **Save after every step** with `BLOG_CARD_UPDATE`, sending only what changed.
  The patch merges into the card: objects merge, arrays replace, `null`
  removes a field. Two writers never lose each other's fields.
- **Never set** `status` to `generating`, `scheduled` or `published`. Starting
  a run sets the first; the other two are a person's decision. You end an
  execution with `awaiting_review`.
- On a step that fails twice, save `error` with what failed, in a sentence a
  person can act on, and stop.

## The store's systems

The store's VTEX, its GA4 and, when connected, its Search Console are
connections of the organization, and this run may read them:

1. `CONNECTION_TOOLS_SEARCH` with a few keywords (`vtex top searches`,
   `analytics run report`, `search console query`) and `withSchema: true`
   returns the tools, their input schemas and the connection ids. It lists
   only connections this run may use.
2. `CONNECTION_TOOL_CALL` with `connectionId`, `toolName` and `arguments`.

On VTEX you may call only these: `VTEX_IS_GET_TOP_SEARCHES`,
`VTEX_IS_GET_SEARCH_SUGGESTIONS`, `VTEX_IS_GET_PRODUCT_SEARCH`,
`VTEX_IS_GET_FACETS`, `VTEX_GET_PRODUCT`, `VTEX_GET_HOME_TOP_VIEWED_PRODUCTS`,
`VTEX_GET_SALES_PERFORMANCE_SUMMARY`, `VTEX_GET_ORDERS_TREND`,
`VTEX_LIST_CATEGORIES`, `VTEX_LIST_BRANDS`, `VTEX_LIST_COLLECTIONS`,
`VTEX_SEARCH_COLLECTIONS` and `VTEX_GET_COLLECTION_PRODUCTS`. GA4 and Search
Console default to the property and site their connections are configured
with.

For the web, use your own `WebSearch` and `WebFetch`. Studio's `web_search`
needs the organization's model, which a run on a person's Claude plan does not
have.

## Evidence

A hypothesis and a campaign cite the same shape: one item per finding, each
from one system. Every item is shown as a small card with its `figure` as the
headline, and opens up to its `detail`.

```json
{
  "source": "gsc",
  "figure": "22.140 impressões",
  "fact": "Buscam 'mala de bordo' e quase ninguém clica: o blog não aparece.",
  "tool": "<the tool's name>",
  "detail": {
    "trend": { "points": [3100, 3400, 3900, 4600], "label": "impressões por semana", "from": "2026-10-06", "to": "2026-10-27" },
    "stats": [{ "label": "Cliques", "value": "0" }, { "label": "Posição média", "value": "14,2" }],
    "link": { "url": "https://search.google.com/search-console/performance/search-analytics?resource_id=sc-domain%3Aexample.com" }
  }
}
```

- **`figure` is one number, written the way a reader reads it** in the
  brand's language: thousands separators, at most two decimals, its unit
  after it (`172.631 sessões`, `1,49 itens por pedido`, `R$ 232.081,52`). It
  stays the tool's number: format it, never compute it. A second number goes
  in `stats`, or in an item of its own.
- **`fact`** says what the number means, in one sentence.
- **`detail`**, when the tool gave the data for it. Each part is optional:
  - Search Console: `trend` (the query's impressions or clicks by day or week,
    oldest first), `stats` (impressions, clicks, average position, CTR) and
    `link` (the Performance report).
  - GA4: `compare` (the subject beside the site, such as a category's
    conversion rate and the site's: `value` sizes the bar, `display` is how it
    reads, the subject first), `stats` and `link`.
  - VTEX: `products` (`name`, price or stock as `note`, and the product's
    image URL as `image`).
  - Calendar: `timeline` (today with `now: true`, the dates that matter, the
    period's end).
- **Leave out a part the tool did not give.** Never draw a trend from numbers
  you remember, and add a `link` only when you know the address of the report
  or page the figure came from.

## How to call the tools

Small calls go through your Studio tools as usual, prefixed `mcp__studio__`:
`BLOG_CARD_GET`, `BLOG_CARD_UPDATE`, `BLOG_STATE_GET`, `BLOG_CAMPAIGN_UPDATE`,
`FILE_CONFIG_LIST`, `CONNECTION_TOOLS_SEARCH` and `BLOG_POST_ILLUSTRATE` with
one image.

Calls whose input or answer is large go through files, so a block schema, a
list of products or a whole post never passes through your context twice:
`BLOG_SITE_BLOCKS`, `BLOG_POST_BRIEF`, `BLOG_POST_ASSEMBLE`, `BLOG_POST_WRITE`
and any `CONNECTION_TOOL_CALL` that answers with a list. From your workspace
(the CLI finds its endpoint in `.deco/tools/`):

```bash
mkdir -p /tmp/blog
typegen call BLOG_SITE_BLOCKS "$(cat /tmp/blog/blocks.in.json)" > /tmp/blog/blocks.json
```

Build inputs and read outputs with `bun -e` (there is no `jq`), printing only
the fields you need. A call that fails prints the error and leaves the output empty. If
`typegen` cannot find its endpoint, make the same call through `mcp__studio__`.

## Rules

- **The card's branch, always.** Pass `branch` (from the card, `blog-<id>`) to
  every tool that takes one. Never the repository's default branch: it is
  production.
- **Keep each Studio call short.** An edge proxy hangs up on requests past
  about 100 seconds: draw one image per `BLOG_POST_ILLUSTRATE` call.
- **Retry a failed call once at most**, then save `error` and stop.
- **Figures are copied, never computed**, written as "Evidence" says, and
  every one names the tool it came from.
- **Write in the brand's language** (`brand.language` in `BLOG_STATE_GET`),
  whatever language you are spoken to in.
- **Publishing is a person's.** The draft you commit is a planning block the
  storefront ignores; a person publishes it from the Site Editor.

## When something is missing

| You see | It means | Do |
| --- | --- | --- |
| No VTEX or GA4 connection in `CONNECTION_TOOLS_SEARCH` | The organization has not connected it, or it is off | Save `error` naming which, and stop |
| A system that errors or answers nothing | The store answered thinly | Not a failure: go on with what the others said |
| `Agentic blog generation is off` | The blog is turned off for the organization | Save `error`, and stop |
| `no blocks a post can be built from` | The site has no blog app or no committed block manifest | Save `error`: the site needs it, not a retry |
| No bucket in `FILE_CONFIG_LIST` | Nowhere to put images | Go on without drawing, with a product photograph as the cover (`execute.md`, "No cover drawn"), and record the gap on the post |
