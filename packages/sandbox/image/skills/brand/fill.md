# Filling the brand guide from the site

How to write the sections of `brand.md` that the brand page shows and the
blog writes with, from evidence instead of imagination. The brand page's
"Fill from site" and "Fill" buttons send you here.

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
| Formatos / Formats | The shapes of blog post it publishes | One `### Name` per format, with its brief |

Frontmatter: keep an existing `name`. A new guide's `name` is the brand as
its customers know it (the store's name), never the folder's slug, which
often names the organization instead. Write `description` — the brand's
one-line pitch, in its own words — when it is missing, and set `site:` (the
store's public address, origin only) and `language:` (a BCP-47 tag such as
`pt-BR`) when you know them. The blog needs both.

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
3. **The store's systems, read-only.** If the organization has a VTEX
   connection, its categories and top searches say what is sold and what is
   searched — the best source for keywords. If it has GA4, its top pages and
   search terms say what readers come for.
4. **The web, for two sections only.** Competitors and special dates are what
   a site never states about itself. Search the brand's own market, in its
   language, and keep the URL behind every claim. Nothing else comes from the
   web.

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
5. **Formats** describe the job each post shape does: what it is for, how it
   opens, what it covers and how it ends. Cite the site's components as
   `@ComponentName` when you know them from its posts. Describe intent, not a
   fixed sequence. Two to five formats.

## Check before you write

Score every claim — each paragraph, each bullet — on two questions:

- **Confidence (0–100):** is it true, by evidence you actually read? A claim
  from the web is judged against its source, not against the site.
- **Relevance (0–100):** is it a good instance of what its section is for?

Keep a claim only with confidence ≥ 75 and relevance ≥ 60. A section whose
claims all fail stays empty.

## Modes

- **Only empty** (the default, and what "keep what is already written" means):
  write sections that are missing or empty; leave every other one untouched.
- **Replace** (only when asked): rewrite the sections you have evidence for.
  Never blank a section because you found nothing for it.

## Writing the file

With no `brand.md` yet, create it — and its folder — as `SKILL.md` describes,
frontmatter first. Otherwise edit `brand.md` in place. Change only the sections you are filling and the
frontmatter keys you are setting; every other byte stays as it was, including
section numbering, the opening quote and anything the page or a person wrote.
Then say, briefly, what you filled, what you left empty and why, and which
sources you used.
