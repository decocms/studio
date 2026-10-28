# Writing a card's post

The hypothesis is approved; now the post. Five stages, in order. At the start
of each, save its name as the card's `stage`, so the board shows where you
are, and save each stage's result as soon as you have it. The card arrives in
`generating` at `grounding`.

Read the card and `BLOG_STATE_GET` first. You need from them: the site
(`virtualMcpId`), the branch (`branch`), the hypothesis, the campaign (by
`campaignId`), the brand (`brand` and `context`) and the chosen format.

## 1. `grounding` — what the store has, and what the site renders

Two calls, through files:

- `BLOG_SITE_GROUND` with `purpose: "post"`, `focus` the hypothesis's title
  and statement, and the brand's `language`. Keep `report` and `outcome`.
- `BLOG_SITE_BLOCKS` with `virtualMcpId`, `branch` and the hypothesis's
  `format`. It returns `blocks` (the only ones a post may be built from, with
  their schemas), `categories` and `authors`.

## 2. `drafting` — the post

`BLOG_POST_DRAFT`, through a file:

```json
{
  "brand": { "...": "brand and context from BLOG_STATE_GET, merged" },
  "campaign": { "...": "the campaign's data", "name": "<its campaignName>" },
  "format": { "name": "...", "value": "..." },
  "blocks": [], "categories": [], "authors": [],
  "count": 1,
  "grounding": { "report": "...", "outcome": "ok" },
  "extraInstructions": "<the statement, the angle, the keywords and the guardrails, as the hypothesis has them>"
}
```

- No `fileConfigId`: the images are the next stage, one call each.
- Pass the `grounding` you already have. Without it the call grounds again
  inside the same request, and runs out of time.
- If `posts` comes back empty, the gap is `drafts-failed`: save `error` and
  stop.

Save the post on the card: `posts[0]` without anything you do not need
(`title`, `excerpt`, `seo`, `cover` with `alt` and `prompt`, `sections`), and
the response's `gaps`.

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

**The body**: the draft leaves a note where it wants a picture, a prop whose
value starts with `generate:` followed by what it shows. For each, at most
two, call `BLOG_POST_ILLUSTRATE` with one request whose `prompt` is the text
after `generate:`, then put the address in that prop and save `sections`.
A failed one gets an empty value, never the note.

`outcome`: `ok` is an address; `no-model` means the organization has no image
model (record the gap, go on); `failed` can be retried once.

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

`postId` is always the card's id: the draft is filed under it. `dropped` says
how many sections this site has no block for; a number above zero is worth a
line in the chat.

If `posts` is not empty, the site has other posts to link to:
`BLOG_LINK_SUGGEST` with `virtualMcpId`, `body` (the `bodyText`), `posts`,
`count: 8` and your `grounding`, then `BLOG_POST_ASSEMBLE` again with the same
input plus `links` (the `suggestions`). `applied` lower than suggested is
normal.

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
