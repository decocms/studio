# Writing a card's post

The hypothesis is approved; now the post, which you write yourself. Five
stages, in order. At the start of each, save its name as the card's `stage`,
so the board shows where you are, and save each stage's result as soon as you
have it. The card arrives in `generating` at `grounding`.

Read the card and `BLOG_STATE_GET` first. You need from them: the site
(`virtualMcpId`), the branch (`branch`), the hypothesis, the campaign (by
`campaignId`), the brand (`brand` and `context`) and the chosen format.

## 1. `grounding` — what the store has, and what the site renders

- **The store**, through `CONNECTION_TOOL_CALL`: each of the campaign's
  products (`VTEX_GET_PRODUCT`: its name, price, availability and address),
  and anything the post will claim that the hypothesis's evidence does not
  already carry. Write what you learn to `/tmp/blog/grounding.txt`, one fact
  per line, each figure exactly as reported and the tool it came from. The
  evidence on the card goes in too.
- **The site**: `BLOG_SITE_BLOCKS` with `virtualMcpId`, `branch` and the
  hypothesis's `format`, through a file. It returns `blocks` (the only ones a
  post may be built from, with their schemas), `categories` and `authors`.

## 2. `drafting` — the post, written by you

`BLOG_POST_BRIEF`, through a file, built with `bun -e` from what you have:

```json
{
  "brand": { "...": "brand and context from BLOG_STATE_GET, merged" },
  "campaign": { "...": "the campaign's data", "name": "<its campaignName>" },
  "format": { "name": "...", "value": "..." },
  "blocks": [], "categories": [], "authors": [],
  "extraInstructions": "<the statement, the angle, the keywords and the guardrails, as the hypothesis has them>",
  "grounding": "<the contents of /tmp/blog/grounding.txt>"
}
```

It answers with `brief`: the rules this brand's posts are written under, the
brand, the campaign, the blocks with their schemas, and the JSON shape to
answer in. Read it whole, then write the post to `/tmp/blog/post.json` in that
shape. The brief is binding: its blocks are the only ones, their schemas say
what each section's `props` may hold, and its products are the only products.

Save the post on the card: `title`, `excerpt`, `seo`, `cover` (`alt` and
`prompt`) and `sections`.

## 3. `illustrating` — the cover, then the body

Find the bucket: the card's `fileConfigId`, or the only one `FILE_CONFIG_LIST`
returns. With several and none on the card, ask the person which. With none,
skip this stage and add `{ "code": "no-bucket" }` to the post's `gaps`.

Offer the products' own photographs, so the images look like what the brand
sells: from the campaign's products, one image of each product before a
second of any, at most 12, as `productImages`.

**The cover**, one `BLOG_POST_ILLUSTRATE` call:

```json
{
  "requests": [{ "id": "cover", "prompt": "<post.cover.prompt, verbatim>", "alt": "<post.cover.alt>" }],
  "productImages": ["..."],
  "companyName": "<brand.companyName>",
  "fileConfigId": "<bucket>"
}
```

Pass the prompt verbatim: the tool adds the brand and the no-lettering rule
itself. Save the address as the post's `cover.url` as soon as it comes.

**The body**: where you wanted a picture, a prop's value starts with
`generate:` followed by what it shows. For each, at most two, call
`BLOG_POST_ILLUSTRATE` with one request whose `prompt` is the text after
`generate:`, then put the address in that prop and save `sections`. A failed
one gets an empty value, never the note.

`outcome`: `ok` is an address; `no-model` means the organization has no image
model: add `{ "code": "no-image-model" }` to the post's `gaps`, clear every
`generate:` note, and go on; `failed` can be retried once, then add
`{ "code": "images-failed" }` if no image was made at all.

## 4. `assembling` — the block this site stores

`BLOG_POST_ASSEMBLE`, through a file:

```json
{
  "virtualMcpId": "...",
  "branch": "<the card's branch>",
  "postId": "<the card's id>",
  "draft": { "...": "the post from the card, with cover.url and the filled sections" },
  "planning": {
    "campaignKey": "blog-manager/campaigns/<campaignId>",
    "format": { "name": "...", "value": "..." },
    "brief": "<the hypothesis's statement>"
  }
}
```

`postId` is always the card's id: the draft is filed under it.

It checks every section against its block's schema. `droppedReasons` says
which sections it dropped and why: fix those sections in `post.json`, save
`sections` on the card, and assemble again, once. What still fails stays out;
record `{ "code": "sections-dropped", "count": <dropped> }` in the post's
`gaps` and say so in the chat.

**Internal links**, when `posts` is not empty: choose up to five yourself.
Each is an exact phrase from `bodyText`, a few words that name what another
post is about, and that post's `slug`; one link per post at most, and only
where a reader would want it. Assemble again with the same input plus `links`.
`applied` lower than what you sent is normal.

## 5. `writing` — the draft, on the card's branch

`BLOG_POST_WRITE`, through a file: `virtualMcpId`, `branch`, `postId` (the
card's id) and `post` (from the last assembly). Check that the `branch` it
answers with is the card's.

A `BlockConflictError` means someone edited the same post meanwhile: read the
card again and write once more.

Then, in one update: `stage: "done"`, `status: "awaiting_review"`, `postKey`
(the `key`) and `commit` (the `version`). In the chat, say what was written,
what was dropped or left without an image, and that the draft is waiting for
review in the Site Editor.
