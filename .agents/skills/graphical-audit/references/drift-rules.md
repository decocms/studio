# Theme drift rules

Apply these against the active local theme and component conventions. `GUI.md` and `gui/foundations.md` own the underlying contracts; this file explains how to gather evidence.

| Category | Candidate evidence | Confirm before reporting |
| --- | --- | --- |
| Theme bypass | Literal colors, dimensions, typography, radii, shadows, or motion at use sites; arbitrary utilities | The value controls themed appearance, the declaration is effective, and it is not a valid alias, token definition, or deliberate exception. Equality with today’s resolved value does not make a literal live. |
| Unknown vocabulary | Undefined CSS variables; guessed color keys, part IDs, states, or variants | Trace imports, runtime variable scopes, utility configuration, and mode/theme branches. A name missing from the snapshot may exist in customized source. A fallback does not prove the token exists. |
| Competing treatments | Near-duplicate buttons/cards, component copies, local overrides on equivalent roles | Confirm equivalent meaning and state. Different component variants and deliberately distinct surfaces are not drift. |
| Incomplete typography | Tokenized size with independent line height, tracking, font, or weight | Compare the complete authored text role and nearby peers. Preserve semantic heading levels independently of visual size. |
| State or mode drift | Default styles use tokens but hover, selected, disabled, invalid, or dark styles do not | Confirm the state is supported and the proposed mapping preserves its meaning. Do not collapse selected, focus, disabled, and invalid into one treatment. |
| Scope failure | Static nested theme, missing portal variables, theme/mode changes not reflected | Trace document/mode ownership and portal container placement. Independent theme scopes can be intentional. Source may expose the cause; rendered effects still need review. |
| Surface mismatch | Native border strokes, whole-component opacity used for an edge, replaced shadow chains | Preserve SVG strokes/focus outlines. Confirm the current theme/state/mode’s placement, literal chosen opacity, and composed elevation/focus treatment. |
| Frozen or invented tokens | Copied snapshot values, new aliases masking literals, another spacing/color scale | Distinguish the theme’s authoritative definitions from consumer use sites. An explicitly requested theme change is not drift. |

## Search without treating matches as findings

Use the project’s search tools to locate `var(--`, inline `style`, relevant utility classes, color functions/hex literals, typography, spacing, borders, shadows, and transitions. Adapt searches to its styling system. Follow aliases and shared classes; do not replace values by regex across the repository.

Inspect state and media-query overrides, not just the normal state. A CSS variable that exists globally can still be missing in a detached portal or overwritten by a local declaration. Conversely, a numeric class can be valid because the utility configuration maps it to the active theme.

## Exceptions and gaps

- Token definitions legitimately contain literal values; correct drift at consumption sites unless the definition itself contradicts an explicit project contract.
- Structural widths, grid ratios, breakpoints, aspect ratios, positioning math, and SVG geometry need not become spacing tokens. Internal component padding and typography do.
- Verified aliases are useful when they preserve an application role and resolve to the theme. Avoid adding aliases solely to disguise arbitrary values.
- Brand artwork, user content, stable data encodings, externally controlled widgets, and deliberate isolated themes require context. Record a material exception and reason; do not blanket-exempt all custom CSS.
- If no existing token preserves the required meaning or distinction, report a **theme gap**. Do not choose a merely similar color or add a new token under a drift-repair request.
- An accessibility issue that persists with the intended theme is a shared contract problem, not grounds to conceal it with an arbitrary local override. Report the concrete evidence and required decision.

## Prioritize the cause

High impact: a shared theme/scope failure or missing token makes multiple required controls or states unusable or unreadable. Medium: repeated overrides or component divergence prevent consistent theme behavior. Low: an isolated discrepancy with a clear existing mapping. Assess impact from evidence; a raw-value match alone does not establish severity. Within an impact level, prefer the shared fix that reaches more confirmed consumers.
