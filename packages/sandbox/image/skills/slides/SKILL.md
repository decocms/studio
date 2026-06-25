---
name: slides
description: Create and edit presentation decks as single self-contained HTML files with a live, editable preview and print-to-PDF export. Use when the user wants slides, a deck, or a presentation.
---

# slides — presentation decks

Create and edit presentation decks as single self-contained HTML files,
rendered by Studio's `<deck-viewer>` runtime. The user gets a live preview
with inline editing, and exports PDF by printing (the deck ships print CSS
— one page per slide; nothing for you to generate).

## Quick reference

| Task                      | How                                                                   |
| ------------------------- | --------------------------------------------------------------------- |
| Create a deck             | `slides-create --data @deck.json --output org/home/decks/<name>.html`   |
| List themes / templates   | `slides-create --help`                                                 |
| See a full data example   | `cat org/public/core/slides/examples/deck.json`                     |
| Edit an existing deck     | `read` the HTML, edit the `<section>` slides, write it back            |
| Org brand templates       | add `--templates-dir org/home/templates/slides`                        |
| PDF export                | user prints from the preview — no action needed                        |

## Path convention

Decks live at `org/home/decks/<name>.html` (`<name>` is lowercase kebab).
Files written there sync to Studio near-instantly and the user sees a live
preview that updates as you work.

## Creating a deck

1. Read `org/public/core/slides/examples/deck.json` once to learn the
   data shapes.
2. Author your own deck JSON (a file is easier to iterate than inline):
   `{ "title": …, "theme": …, "slides": [ { "template": …, "data": … } ] }`
3. Render: `slides-create --data @deck.json --output org/home/decks/<name>.html`
4. Iterate content by editing the **HTML output** (see lifecycle below),
   or re-render with `-f` only while the user hasn't touched the deck.

Themes (`--theme` or `"theme"` in data; default `aurora-light`):
`aurora-light` (clean light, soft gradients), `ink-dark` (dark keynote,
amber accents), `bold-gradient` (vivid full-bleed gradient, glass cards).

`--theme` also accepts a **path to a custom theme file**, in either shape:

1. A **shell** with a `{{{slides}}}` insertion point (copy a built-in from
   `org/public/core/slides/themes/` and retune its CSS custom properties).
2. A **real deck** ("deck-as-theme") — a complete deck whose `<deck-viewer>`
   holds example slides. On render, `{{title}}` is filled and the
   `<deck-viewer>` body is replaced with the generated slides. So one file is
   both an editable sample deck (open it in Studio and edit the slides inline,
   like any deck) **and** the generation shell — the cleanest way to author a
   brand theme.

Keep org brand themes in org-fs so they persist, e.g.:

```sh
slides-create --data @deck.json \
  --theme org/home/templates/slides/brand-theme.html \
  --templates-dir org/home/templates/slides \
  --output org/home/decks/q3.html
```

### Brand folders

If the org has a brand at `org/home/brands/<name>/` (check with
`ls org/home/brands/`), honor it before any built-in theme (to *create* or
edit a brand, use the `brand` skill):

- **`tokens.css`** — the brand's `--brand-*` CSS custom properties. Inline
  them into the deck (paste into the theme `<style>` block; never reference the
  org-fs file by URL — preview iframes carry no cookies). A brand theme shell
  maps deck variables onto them, e.g. `--deck-accent: var(--brand-primary);`.
- **`slides-theme.html`** — if present it's a ready deck shell for this brand;
  pass it as `--theme org/home/brands/<name>/slides-theme.html`.
- **`brand.md`** — voice, tone, do's and don'ts; read it and follow it when
  writing slide copy.
- **`logo.*`** — the brand logo; place it on the title/closing slides.

### Slide templates and their data

| Template          | Data fields (`?` = optional)                                              |
| ----------------- | ------------------------------------------------------------------------- |
| `title`           | `heading`, `subheading?`, `eyebrow?`, `meta?`                              |
| `agenda`          | `heading`, `items: [string]`, `eyebrow?`                                   |
| `section-divider` | `heading`, `number?`, `subheading?`                                        |
| `bullets`         | `heading`, `items: [string]`, `intro?`, `eyebrow?`                         |
| `two-column`      | `heading`, `left/right: { title?, html }` (`html` is raw trusted HTML), `eyebrow?` |
| `quote`           | `quote`, `attribution?`, `role?`                                           |
| `kpi-row`         | `kpis: [{ value, label, delta? }]`, `heading?`, `eyebrow?` (3 KPIs fit best) |
| `timeline`        | `heading`, `steps: [{ label, title, description? }]`, `eyebrow?` (3–4 steps) |
| `comparison`      | `heading`, `columns: [{ title, items: [string] }]`, `eyebrow?` (2–3 columns) |
| `closing`         | `heading`, `subheading?`, `cta?`                                           |

This skill is built on the `templating` skill
(`org/public/core/templating/SKILL.md`). For a one-off custom slide
or deck template, render it directly with `create-from-template`; for an
org's own slide layouts, keep them in `org/home/templates/slides/` and
pass `--templates-dir` — they resolve before the built-ins.

## Lifecycle — templates create, edits go to the HTML

Rendering is for **creation**. After that, the HTML file is the live
artifact: **the user can edit it inline in the preview** (retype text,
reorder/duplicate/delete/skip slides) and those edits are saved back into
the same file. Therefore:

- **Always re-read the deck file before editing it** — your last copy may
  be stale.
- Iterate with `read`/`edit` on the HTML, not by re-rendering;
  `slides-create -f` overwrites the user's edits.

## Editing slides by hand

Slides are the direct `<section>` children of `<deck-viewer>`. Rules:

- Fixed 1920×1080 canvas (the runtime scales it). Never set
  `position`/`inset`/`width`/`height` on the `<section>` itself; lay out
  inner elements freely.
- Static HTML only — no JS-rendered text, no per-deck scripts. Inline
  editing depends on the text being in the markup.
- Reuse the theme's classes (`deck-h1`, `deck-h2`, `deck-sub`,
  `deck-body`, `bullets`, `cols`, `card`, `kpi-value`, …) and tune the
  look via the CSS custom properties in the theme `<style>` block rather
  than scattering literal colors.
- Entrance animations: gate on `section[data-deck-active]`, keep the
  visible end state as the base state, respect
  `prefers-reduced-motion` — required so print/PDF renders full content.
- Images: absolute public URLs or data URIs only (relative paths do not
  resolve when the deck is served). Prefer CSS shapes/gradients.
- Content budget: a slide fits roughly one heading plus 5 bullets (or
  3 cards). When in doubt, split into two slides.
- `data-deck-skip` on a `<section>` hides it from presentation and print
  without deleting it.
- Never touch the `<script src="/deck-runtime/v1/deck-viewer.js">` tag or
  rename `<deck-viewer>`.
