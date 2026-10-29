---
name: blogpost
description: Work a blogpost card of an organization's content track — bring the post's hypothesis from the store's own data, then write the post yourself on the card's branch. Use when you are running in a blogpost card's chat, or are asked to bring or execute a card's hypothesis.
---

# blogpost — work a card of the content track

A card is one blog post on its way, from the hypothesis that argues for it to
the draft a person reviews. It lives in the brand folder,
`/app/org/home/brands/<brand>/cards/<id>.json`, and the board shows it as you
save it. Your chat's instructions name the card, its site and its branch.

You do the thinking and the writing: read the store's systems, argue the
hypothesis, write the post. Studio's tools give you what only Studio has (the
card, the brand, the site's blocks, the images) and check and commit what you
wrote.

| Phase | File | Ends with |
| --- | --- | --- |
| Bring the hypothesis | `hypothesis.md` (in this skill folder) | The hypothesis on the card, presented in the chat |
| Write the post | `execute.md` (in this skill folder) | The draft committed on the card's branch, the card in `awaiting_review` |

Read the file for the phase you were asked for, and follow it.

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

## How to call the tools

Small calls go through your Studio tools as usual, prefixed `mcp__studio__`:
`BLOG_CARD_GET`, `BLOG_CARD_UPDATE`, `BLOG_STATE_GET`, `FILE_CONFIG_LIST`,
`CONNECTION_TOOLS_SEARCH` and `BLOG_POST_ILLUSTRATE` with one image.

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
  about 100 seconds: draw one image per `BLOG_POST_ILLUSTRATE` call, and never
  call `BLOG_SITE_GROUND`, `BLOG_POST_DRAFT`, `BLOG_LINK_SUGGEST` or
  `BLOG_CAMPAIGN_SUGGEST` — they spend the organization's model on work that
  is yours.
- **Retry a failed call once at most**, then save `error` and stop.
- **Figures are copied, never computed or rounded**, and every one names the
  tool it came from.
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
| No bucket in `FILE_CONFIG_LIST` | Nowhere to put images | Go on without images and record the gap on the post |
