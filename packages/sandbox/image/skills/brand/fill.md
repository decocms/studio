# Filling the brand guide from the site

How to write the sections of `brand.md` that the brand page shows and the
blog writes with, and the colors and fonts in `tokens.css`, from evidence
instead of imagination. The brand page's "Fill from site" and "Fill" buttons
send you here.

The guide is read by people and by every agent that writes for the brand, so a
wrong sentence spreads. **Empty beats a guess**: a section left empty is asked
for again; a plausible invention is believed.

## The sections

Each is a `## ` heading in `brand.md`, written in the brand's language. Use
these labels: the brand page finds a section by its heading, and the blog
reads each one as a field.

| Section (pt-BR / en) | What it holds | Shape |
| --- | --- | --- |
| Tom de voz / Voice & tone | How the brand talks: person, register, rhythm | Prose, 2–4 short paragraphs or bullets |
| Público / Audience | Who it talks to, in their words | One paragraph |
| Frases de exemplo / Example phrases | Sentences that sound like it, and that don't | `- ✅ "…"` and `- ❌ "…"` lines |
| Regras / Rules | How to write for it | Bullets, each an imperative |
| Vocabulário / Vocabulary | Words it uses, and the ones it never does | `- **Term** — how to use it` |
| O que evitar / Don'ts | What never goes in its copy | Bullets |
| Valores / Values | What it stands for, each with its evidence | `- **Value** — the evidence` |
| Concorrentes / Competitors | Who it is compared with, and how it differs | `- **Name** — how it differs` |
| Palavras-chave / Keywords | What its customers search for | Bullets or one comma-separated line |
| Datas especiais / Special dates | Dates its sales and content turn on | `- **Date** — when, and why it matters here` |
| Políticas comerciais / Commercial policies | Shipping, returns, payment, as customers see them | `- **Policy** — what it promises` |

Frontmatter: keep an existing `name`. A new guide's `name` is the brand as
its customers know it (the store's name), never the folder's slug, which
often names the organization instead. Write `description` — the brand's
one-line pitch, in its own words — when it is missing, and set `site:` (the
store's public address, origin only) and `language:` (a BCP-47 tag such as
`pt-BR`) when you know them. The blog needs both.

## The formats

The shapes of blog post the brand publishes are files, not a section: one per
format, `formats/<id>.md` beside `brand.md`, where `<id>` is its name in
lowercase kebab. Follow `templates/format.md` in this skill folder: flat
frontmatter (`name`, a one-line `summary` an agent chooses the format by, and
`length`), then the brief as the body, written in the brand's language. A
`## Formatos` section in `brand.md` is how formats were kept before; the blog
reads it only while `formats/` is empty.

- **Two to five formats**, from what the brand's blog already publishes and
  what works: its posts in the repository's blocks, and the `/blog` pages with
  the most sessions and conversions in GA4.
- **Each one complete.** Fill every section of the template from evidence: a
  structure a writer can follow, the site blocks its posts use, cited as
  `@ComponentName`, title patterns taken from its posts, and two or three
  example URLs. A section you have no evidence for says so in one line.
- **Only blocks the site renders.** A post is built from the blocks its format
  cites. When the ask names the site's `virtualMcpId`, list them with
  `BLOG_SITE_BLOCKS` (an empty `format` and the site's default branch) and cite
  the names it returns; otherwise, the blocks its posts in the repository use.
- **Up to 8,000 characters** a file: the card carries the brief whole, and a
  longer one is left out.
- **Intent, not a script**: say what each part of the post does, not the
  sentences it says.

## The look

The brand page's Visual card shows the colors and fonts in `tokens.css`, next
to `brand.md`, under the names `SKILL.md` gives. Take them from what the site
declares in its repository, never from taste:

- a theme block in `.deco/blocks/`, such as a `Theme` section with its colors
  and font;
- the global stylesheet and the Tailwind config: custom properties such as
  `--color-primary` or `--primary`, a DaisyUI theme, Tailwind's `@theme`,
  `theme.extend.colors` and `fontFamily`;
- the fonts the site loads: `@font-face`, a Google Fonts link or `@import`,
  and the `font-family` on `body` and on headings.

When they disagree, the theme block the site's app points to (`theme` in its
`site` block) is what the pages render, over the stylesheet: use it, and name
the other in what you report.

Write only the core: `--brand-primary`; `--brand-secondary` and
`--brand-accent` when the site has them; `--brand-bg` and `--brand-fg`;
`--brand-font-display` and `--brand-font-body`; and `--brand-radius` when the
site declares one. Write colors in hex, converting `oklch()` or `rgb()`. Keep
each font's own name with a generic fallback, and `@import` the fonts the site
loads from Google Fonts at the top of the file. Leave out a role the site does
not declare, and skip the ramps: the page shows the core.

## Evidence, in order of trust

1. **The site's own content, in its repository.** The storefront's CMS keeps
   every page, section and blog post as JSON blocks in the repository, under
   `.deco/blocks/` (or `<app>/.deco/blocks/` in a monorepo). That is the
   brand's own copy, readable even when the live site blocks bots.
   - Call `TASK_ADD_REPO` with no arguments to list the organization's
     repositories, pick the storefront (its name usually matches the brand or
     the site), and call it again with that id to clone it.
   - Read the blocks' prose: string values with spaces in them. Skip URLs,
     image and data addresses, ids, and anything under `__resolveType`; keep
     the prop name, it says what the text is (a title, a description, a CTA).
   - Read breadth first, by page role: blog posts (`blog-manager/posts/…`,
     `collections/blog/posts/…`), then the home page, institutional pages
     (about, "sobre", "quem somos"), category and product pages.
   - SEO lives in the blocks too: the site's default SEO and each page's `seo`
     prop (title and description) are the brand's one-line pitch.
   - Write what you read to a file, so quotes can be checked against it.
2. **The live site, when it answers.** Fetch the same pages for what the
   blocks do not hold. If the site refuses automated requests (a Cloudflare
   challenge, 403), move on: do not try to get around the block.
3. **The store's systems, read-only, for what a site never says about
   itself.** They are the only source of what customers search for, visit
   and buy, so read every one before you write a section. Search for each
   system, even one you expect to be missing: `CONNECTION_TOOLS_SEARCH`, with
   `withSchema: true`, lists only the connections this chat may use, with
   their ids and tools. Then call the tools with `CONNECTION_TOOL_CALL`.
   - **VTEX** (search `vtex top searches`): top searches and search
     suggestions (`VTEX_IS_GET_TOP_SEARCHES`, `VTEX_IS_GET_SEARCH_SUGGESTIONS`)
     for Palavras-chave; categories, brands and collections
     (`VTEX_LIST_CATEGORIES`, `VTEX_LIST_BRANDS`, `VTEX_LIST_COLLECTIONS`) for
     Vocabulário and for what the brand sells; the orders trend
     (`VTEX_GET_ORDERS_TREND`) for the peaks behind Datas especiais.
   - **GA4** (search `analytics run report`): the most visited pages over the
     last 90 days, and the audience by `userAgeBracket`, `region` and
     `deviceCategory`, for Público. A property without demographics answers
     age empty; keep region and device.
   - **Search Console** (search `search console query`): the queries with the
     most impressions over the last 90 days, for Palavras-chave.

   A system is missing only when its search finds no connection, or its call
   answers "Connection not found" or access denied. Then it is a gap to
   report, not a reason to stop.
4. **The web, for two sections only.** Competitors and special dates are what
   a site never states about itself. Search with your own `WebSearch` and read
   pages with `WebFetch`, never Studio's `web_search`: that one needs the
   organization's model, and a fill on a person's Claude plan has none. Search
   the brand's own market, in its language, and keep the URL behind every
   claim. If neither tool answers, leave both sections empty and say why.
   Nothing else comes from the web.

Read breadth before depth: voice repeats across a site, so fifteen pages read
shallowly describe it better than five read in full.

## Traps

- **Editor labels.** Section names, internal ids and CMS placeholders ("Banner
  Home 2", "Lorem ipsum", "Nome do produto") are not the brand talking.
- **Operational copy.** Shipping, returns and legal text belong in Políticas
  comerciais. They are not values and not the brand's voice.
- **SEO.** A meta description is the brand's own one-line pitch: good evidence
  for who it is and how it talks. Never quote it as an example phrase.
- **Casing and punctuation.** A site written by many hands is inconsistent.
  Describe the dominant habit; do not elevate an accident into a rule.

## How to write it

1. **Identity first, then voice.** Write Público, Valores, Concorrentes,
   Palavras-chave, Datas especiais and Políticas comerciais first. Then write
   Tom de voz, Frases de exemplo, Regras, Vocabulário and O que evitar, taking
   the first pass as established fact.
2. **Write in the site's language**, whatever language you were asked in.
3. **Example phrases are verbatim.** Every ✅ line is copied exactly from a page
   you fetched; check it with a substring search over what you saved, and drop
   it if it is not there. ❌ lines are counter-examples you write, in the
   brand's subject, the way it would never say it.
4. **Rules are imperatives** ("Fale com o leitor como 'você'"), not adjectives
   ("acolhedor"). Don'ts are things to avoid, not dos turned around.
5. **Formats** follow "The formats" above, one file each.

## Check before you write

Score every claim — each paragraph, each bullet — on two questions:

- **Confidence (0–100):** is it true, by evidence you actually read? A claim
  from the web is judged against its source, not against the site.
- **Relevance (0–100):** is it a good instance of what its section is for?

Keep a claim only with confidence ≥ 75 and relevance ≥ 60. A section whose
claims all fail stays empty.

## Modes

- **Only empty** (the default, and what "keep what is already written" means):
  write sections that are missing or empty, and the core tokens `tokens.css`
  lacks; leave every other section and every value already set untouched.
  Formats are missing only when `formats/` holds no file and the guide has no
  formats section.
- **Replace** (only when asked): rewrite the sections, format files and core
  tokens you have evidence for. Never blank a section, delete a format, or drop
  a token, because you found nothing for it. When the guide still has a
  formats section, move each `###` format into its own file in the template's
  shape, then delete the section.

## Writing the file

With no `brand.md` yet, create it — and its folder — as `SKILL.md` describes,
frontmatter first. Otherwise edit `brand.md` in place. Change only the sections you are filling and the
frontmatter keys you are setting; every other byte stays as it was, including
section numbering, the opening quote and anything the page or a person wrote.
`tokens.css` follows the same rule: create it with the core when it is
missing, otherwise change only the tokens you are setting. Format files are
written whole, one per format, under `formats/`, which you create when it is
missing.

Then say, briefly, what you filled, what you left empty and why, the formats
you wrote, which sources you used, and the colors and fonts you set with the file each came
from. For VTEX, GA4 and Search Console, one line each: what you read, or the
search or call that failed. "Did not look" is not an answer; go back and
look.
