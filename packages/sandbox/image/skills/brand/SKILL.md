# brand — build an organization brand

Create and maintain an org's brand as a folder the whole platform reads:
colors, type, voice, logo and a deck theme. Use this whenever someone asks to
"set up our brand", "make a brand kit", "apply our colors/fonts", or before
producing branded artifacts (decks, pages, emails). One brand = one folder;
everything that generates output consumes it.

## Quick reference

| Task | How |
| --- | --- |
| See a complete example | read `examples/tokens.css` and `examples/brand.md` (in this skill folder) |
| Create a brand | write the files into `org/home/brands/<name>/` (steps below) |
| Build a deck theme | `slides-create … --theme org/home/brands/<name>/slides-theme.html` (see the `slides` skill) |
| Edit later | the user edits it in Studio's Library → Brands (or you rewrite the files) |

## Convention

A brand is `org/home/brands/<name>/` (`<name>` is lowercase kebab, e.g.
`acme`):

| File | What |
| --- | --- |
| `tokens.css` | Visual source of truth — CSS custom properties in the `--brand-*` namespace. |
| `brand.md` | The brand bible — voice, tone, color/type usage, components, do/don't (prose for agents). |
| `logo.svg` (or `.png`) | The logo. Name it `logo.*`. |
| `slides-theme.html` | Optional deck theme for the `slides` skill. |

The Library renders this folder as a first-class **Brand** (color bands, type
specimens, components & deck preview, all editable). Keep the file and token
names exactly as below so it groups them correctly.

## tokens.css — the token system

Everything lives under `--brand-*` in `:root`. Use these families/names — the
Library editor groups by them and consumers (decks, pages) map onto them:

- **Color ramps** — `--brand-<family>-50 … 950` (11 steps) for `primary`,
  `secondary`, `accent`, `neutral`; plus a flat alias `--brand-primary` (= the
  500), `--brand-secondary`, `--brand-accent` for the common case.
- **Semantic** — `--brand-{success,warning,error,info}`, each with `-bg` and
  `-fg` variants.
- **Surfaces / text (roles)** — `--brand-bg`, `--brand-bg-subtle`,
  `--brand-bg-elevated`, `--brand-fg`, `--brand-fg-muted`, `--brand-fg-subtle`,
  `--brand-border`, `--brand-border-strong`, `--brand-ring`.
- **Type** — `--brand-font-display`, `--brand-font-body`, `--brand-font-mono`;
  scale `--brand-text-xs … 5xl`; weights `--brand-fw-{regular,medium,semibold,
  bold}`; `--brand-leading-*`, `--brand-tracking-*`. Load web fonts with an
  `@import` at the top of the file.
- **Spacing** — `--brand-space-1 … 20` (4px base).
- **Radius** — `--brand-radius` + `--brand-radius-{sm,md,lg,xl,full}`.
- **Shadows** — `--brand-shadow-{sm,md,lg}` (+ an optional brand glow).
- **Motion** — `--brand-duration-{fast,base,slow}`, `--brand-ease`.

Copy `examples/tokens.css` (in this skill folder) and retune it. **Minimum
viable brand:** `--brand-primary`, `--brand-bg`, `--brand-fg`,
`--brand-font-display`, `--brand-font-body`, `--brand-radius` — add ramps,
semantics and roles as the brand grows. Build ramps around the seed colors
(lighten toward 50, darken toward 950); derive a neutral ramp and semantic
greens/ambers/reds when not provided.

## brand.md — the bible

Prose the agent follows when writing copy or designing. Structure (see
`examples/brand.md` in this skill folder):

- Optional frontmatter: `name` + `description`.
- **Concept** — what the brand feels like, in 2–3 adjectives.
- **Color** — each role and when to use it, plus rules (e.g. max N strong
  colors per view; never color without an icon/label).
- **Typography** — display vs body; heading style.
- **Voice & tone** — person, tense, do/don't, with **canonical examples**
  (hero, primary/secondary CTA, error, empty state).
- **Components** — recipes (button variants, card, input, badge, chip).
- **Do / Don't** — a tight checklist.

Be specific and opinionated — vague guidance ("be friendly") is useless;
canonical example strings are gold.

## logo

Save as `logo.svg` (preferred) or `logo.png`. An SVG using `currentColor` or
brand vars adapts to light/dark surfaces.

## slides-theme.html — branded decks

A brand can ship a deck theme so every generated deck is on-brand. It is a
**real deck** (the `slides` skill's "deck-as-theme"): a complete deck whose
`<deck-viewer>` holds one example `<section>` per layout, with the shell's
`:root` mapping `--deck-*: var(--brand-*)` and a snapshot of the brand tokens
inlined (decks must be self-contained). Build it once:

1. Copy a built-in theme from the `slides` skill's `themes/` folder (pick the
   light/dark one closest to the brand), retune its `:root` to map the deck
   variables onto the brand tokens, and `@import` the brand fonts.
2. Render a sample deck into it so it opens editable in Studio (use the
   `slides` skill's `examples/deck.json`, or author a small one):

   ```sh
   slides-create --data @deck.json \
     --theme <retuned-theme.html> \
     --output org/home/brands/<name>/slides-theme.html
   ```

Decks then use it: `slides-create --theme
org/home/brands/<name>/slides-theme.html …` (full flow in the `slides` skill).

## Building a brand — workflow

1. **Gather inputs:** brand name, a primary color (+ any secondary/accent),
   fonts, voice notes, logo. Ask for what's missing; infer sensible defaults
   from the primary (neutral ramp, semantic colors).
2. `mkdir org/home/brands/<name>/`.
3. Write **`tokens.css`** — copy the example, swap in the colors/fonts, build
   the ramps around the seed colors.
4. Write **`brand.md`** — the bible, with real canonical copy examples.
5. Add **`logo.*`**.
6. Optionally generate **`slides-theme.html`** (above).
7. Tell the user it's in the Library under **Brands**, editable there.

Never reference `tokens.css` by URL from a preview iframe (opaque origin
carries no cookies) — consumers inline its contents.
