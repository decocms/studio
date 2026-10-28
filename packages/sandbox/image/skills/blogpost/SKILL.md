---
name: blogpost
description: Work a blogpost card of an organization's content track — bring the post's hypothesis from the store's own data, then write the post on the card's branch. Use when you are running in a blogpost card's chat, or are asked to bring or execute a card's hypothesis.
---

# blogpost — work a card of the content track

A card is one blog post on its way, from the hypothesis that argues for it to
the draft a person reviews. It lives in the brand folder,
`/app/org/home/brands/<brand>/cards/<id>.json`, and the board shows it as you
save it. Your chat's instructions name the card, its site and its branch.

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
- On a stage that fails twice, save `error` with what failed, in a sentence a
  person can act on, and stop.

## How to call the tools

Small calls go through your Studio tools as usual, prefixed `mcp__studio__`:
`BLOG_CARD_GET`, `BLOG_CARD_UPDATE`, `BLOG_STATE_GET`, `FILE_CONFIG_LIST` and
`BLOG_POST_ILLUSTRATE` with one image.

Heavy calls go through files, so a block schema or a whole post never passes
through your context: `BLOG_SITE_GROUND`, `BLOG_SITE_BLOCKS`,
`BLOG_POST_DRAFT`, `BLOG_POST_ASSEMBLE`, `BLOG_LINK_SUGGEST` and
`BLOG_POST_WRITE`. Set the caller up once:

```bash
mkdir -p /tmp/blog && cd /tmp/blog
[ -f package.json ] || bun init -y >/dev/null
if [ -f /opt/sandbox-daemon/typegen.tgz ]; then bun add /opt/sandbox-daemon/typegen.tgz; else bun add @decocms/typegen; fi
cat > call.ts <<'EOF'
import { createStudioClient } from "@decocms/typegen";
const [tool, input, output] = process.argv.slice(2);
const client = createStudioClient() as unknown as Record<string, (i: unknown) => Promise<unknown>> & { close(): Promise<void> };
try {
  const result = await client[tool](JSON.parse(await Bun.file(input).text()));
  await Bun.write(output, JSON.stringify(result));
  console.log(`${tool} -> ${output}`);
} finally {
  await client.close();
}
EOF
cd - >/dev/null
```

Then write the input to a file and call, from your workspace (the client finds
its endpoint by walking up from the working directory to `.deco/tools/`):

```bash
bun run /tmp/blog/call.ts BLOG_SITE_BLOCKS /tmp/blog/blocks.in.json /tmp/blog/blocks.json
```

Build inputs and read outputs with `bun -e` or `jq`, printing only the fields
you need.

## Rules

- **The card's branch, always.** Pass `branch` (from the card, `blog-<id>`) to
  every tool that takes one. Never the repository's default branch: it is
  production.
- **About 100 seconds per call.** An edge proxy hangs up on longer requests
  while the server keeps working and billing. So: ground once and pass the
  `report` on; draft with `count: 1` and no `fileConfigId`; draw one image per
  `BLOG_POST_ILLUSTRATE` call; never call `BLOG_CAMPAIGN_SUGGEST`.
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
| `blog-connections-missing: …` | The organization's VTEX or GA4 is not connected | Save `error` naming which, and stop |
| `Agentic blog generation is off` | The blog is turned off for the organization | Save `error`, and stop |
| `no blocks a post can be built from` | The site has no blog app or no committed block manifest | Save `error`: the site needs it, not a retry |
| `outcome: no-tools`, `timeout` or `failed` from grounding | The store answered thinly | Not a failure: save the outcome and go on with less |
| No bucket in `FILE_CONFIG_LIST` | Nowhere to put images | Go on without images and record the gap on the post |
