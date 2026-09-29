# Fonts

The product speaks in two faces. There is no third, and adding one needs a
better reason than fashion — see `foundations/system.stories.tsx`.

## Switzer — the UI face

**License**: SIL Open Font License (OFL) 1.1
**Source**: https://www.fontshare.com/fonts/switzer (Indian Type Foundry)

Deco's own typeface. It already set the landing page and the report deck
(`apps/web/src/routes/reports/`), where it was deliberately scoped so it would
not leak into the app — which left the product speaking in a different voice
from its own brand. It is now the app's `--font-sans`, with Inter kept only as
the fallback while the variable file loads.

Variable, 100–900. Display headings use weight 640 and −0.03em tracking via
the `font-display` utility; body runs at 450.

- `Switzer-Variable.woff2`

## Commit Mono — code and identifiers

**License**: SIL Open Font License (OFL) 1.1
**Source**: https://github.com/eigilnikolajsen/commit-mono

Strings you copy or compare character by character: run ids, SHAs, file paths,
commands, code blocks. NOT captions — a status, a relative time or a project
name is language, and mono makes language read as log output. Those use the
`text-meta` utility, which is Switzer with lining figures.

- `CommitMono-VariableFont.woff2`

## Inter — fallback only

**License**: SIL Open Font License (OFL) 1.1

Retained as the `--font-sans` fallback so text does not reflow into a system
grotesque before Switzer lands. Not a design choice; do not target it.

- `InterVariable.woff2`, `InterVariable-Italic.woff2`

## License compliance

All three are OFL 1.1. `OFL.txt` must ship alongside the font files.
