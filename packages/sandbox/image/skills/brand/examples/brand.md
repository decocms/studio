---
name: Acme
description: Bold, optimistic fintech voice — confident, plain-spoken, numbers-first. Dark, premium, calm.
---

# Acme — brand guide

> Acme is the money app that talks like a smart friend, not a bank. Everything
> we make should feel **confident, warm, and effortless**. The product does the
> hard work; the interface gets out of the way and the number is the hero.

This is the prose half of the brand. The visual half is `tokens.css` (full
token system), `logo.svg`, and `slides-theme.html`. **Agents: read this before
writing any Acme copy or designing any Acme artifact, and inline `tokens.css`
for color/type.**

## 1. Concept

Three feelings, always together:

1. **Confident** — lead with the outcome and the number. No hedging.
2. **Warm** — plain language, second person ("you"), never condescending.
3. **Effortless** — generous spacing, one clear action per screen, calm motion.

The result: "a serious money tool that feels like a good friend just gave you
the answer." Premium without being cold; the canvas is deep and calm, the data
is bright.

## 2. Color (see `tokens.css`)

Full ramps live in `tokens.css` (`--brand-{primary,secondary,accent,neutral}-50…950`).
Use them through their roles, not by reaching for a raw hex:

| Role | Token | Use |
| --- | --- | --- |
| Primary | `--brand-primary` (#0a84ff) | Primary action, links, key figures, focus. One dominant use per view. |
| Secondary | `--brand-secondary` (#5e5ce6) | Supporting accent, gradients, secondary series. |
| Accent | `--brand-accent` (#ff375f) | A single highlight/alert per view. Never for body text. |
| Canvas | `--brand-bg` (#0b0f1a) | Deep base for data, focus flows, decks. |
| Surface | `--brand-bg-subtle` / `--brand-bg-elevated` | Cards / raised surfaces on the canvas. |
| Text | `--brand-fg` / `--brand-fg-muted` / `--brand-fg-subtle` | Primary / secondary / meta. |
| Semantic | `--brand-{success,warning,error,info}` (+ `-bg`/`-fg`) | State, always with an icon + label. |

Rules:
- **Max 3 strong colors** in one view. Accent is a spice (one element/viewport).
- Color never carries meaning alone — pair with an icon + label.
- Dark-first: design on `--brand-bg`; light surfaces are the exception.

## 3. Typography (see `tokens.css`)

- **Display** `--brand-font-display` (Space Grotesk) — headings, hero numbers.
- **Body** `--brand-font-body` (Inter) — everything else.
- **Mono** `--brand-font-mono` (JetBrains Mono) — figures in tables, code, tickers.
- Scale `--brand-text-xs…5xl`; weights `--brand-fw-regular…bold`; tracking
  `--brand-tracking-tight` on display, `-normal` on body, `-wide` on eyebrows.
- Headings: tight, sentence case ("Your money, working" — not Title Case).
  **Numbers are heroes**: large, display font, often `--brand-text-4xl/5xl`.

## 4. Voice & tone

- **Person:** "you", always. Direct and respectful.
- **Tense:** present. "You're saving $240/mo", not "you saved".
- **Numbers first.** "3× faster payouts" beats "much faster payouts".
- **Confident, not arrogant.** "Here's the move:" not "You should probably…".
- **No jargon, no fear.** Never "synergy"/"leverage", no fake urgency
  ("ACT NOW!"), no guaranteed-returns language — ever (compliance + trust).
- **Encouraging, measured.** "Nice — you're ahead of plan." not "You crushed it!!!"
- **Emoji:** none in product UI. At most one, optional, in external comms.

### Canonical examples

| Where | Says |
| --- | --- |
| Hero | "Your money, working" |
| Stat | "You're saving $240 a month" |
| Primary CTA | "Start saving" / "Move money" |
| Secondary CTA | "See the math" |
| Empty state | "Nothing here yet — let's set up your first goal." |
| Error | "That amount is over your balance. Try $500 or less." |
| AI note | "You spend most on weekends — want a weekend cap?" |

## 5. Spacing, grid & radii

- **4px base** (`--brand-space-*`). Section gaps 24–32px; card padding 16–24px.
- One primary action per screen; everything else secondary or ghost.
- Rounded everywhere: inputs/buttons `--brand-radius` (14px), cards
  `--brand-radius-lg`, sheets/hero `--brand-radius-xl`, pills `--brand-radius-full`.
  Never sharp corners.

## 6. Elevation & motion

- Cool shadows only (`--brand-shadow-sm/md/lg`) — cards float on the canvas,
  never hard borders. `--brand-shadow-glow` is reserved for AI / primary moments.
- Motion: `--brand-duration-fast/base/slow` + `--brand-ease`. Fade + short
  slide (8–12px). Nothing over 400ms. Calm, never bouncy.

## 7. Components (recipes)

| Component | Recipe |
| --- | --- |
| Primary button | `--brand-primary` fill, white text, radius 14, subtle glow. One per screen. |
| Secondary button | Transparent, `--brand-fg`, 1.5px `--brand-border-strong` inset. Liberal use. |
| Ghost button | No fill, `--brand-fg-muted`. For "cancel", "later". |
| Card | `--brand-bg-subtle`, radius-lg, `--brand-shadow-sm`. AI cards add `--brand-shadow-glow`. |
| Stat / KPI | Big `--brand-text-5xl` figure in display font + one `--brand-fg-muted` line. |
| Input | `--brand-bg-elevated`, 1.5px border; focus → `--brand-ring`; error → `--brand-error` + microcopy. |
| Chip / filter | Pill (`--brand-radius-full`); active = `--brand-primary` fill, inactive = border. |
| Badge | Pill, semantic `-bg` + `-fg`, with a Lucide icon. |

## 8. Iconography

- **Lucide** ([lucide.dev](https://lucide.dev)) — stroke 1.75, never filled,
  `currentColor`. Sizes 18 (inline) / 22 (buttons) / 26 (nav).
- Canonical: `trending-up` (growth), `wallet`/`piggy-bank` (savings),
  `arrow-left-right` (transfer), `sparkles` (AI), `shield-check` (security),
  `bar-chart-3` (insights). No emoji, no unicode glyphs as icons.

## 9. Do / Don't

- ✅ Lead with the outcome and the number.
- ✅ One bold accent moment per view.
- ✅ Plain, present-tense, second person.
- ✅ Dark canvas, bright data, generous space.
- ❌ Fake urgency, guarantees, or hype punctuation (!!!).
- ❌ More than three strong colors at once.
- ❌ Jargon, or color used without an icon/label.
- ❌ Hard borders, sharp corners, busy backgrounds.
