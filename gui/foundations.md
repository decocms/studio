# Foundation vocabulary

These are the shared names and usage rules, not a fixed type scale or color ramp. Read the active theme and its generated [snapshot reference](themes.md) for actual values in each mode. Preserve fractional dimensions, authored weights, and the chosen theme’s character. Do not round it into a generic scale or copy a different preset’s treatments.

## Colors

The color groups are Palette, Neutrals, Status, and None. Palette supports `color-1` through `color-10`; not every theme defines all ten. Read the theme reference before referencing optional colors. Neutrals are `neutral-1` through `neutral-10`; status colors are `success`, `warning`, and `error`. `none` resolves to transparent.

Every real color supports a `-transparent` counterpart. It uses the solid token's channels/color space at **20% opacity by default** in both modes. An authored `theme.colorTranslucency[mode][baseColorKey]` percentage (0–100) overrides that default for the selected color and mode; both channels and opacity resolve live. It is not a separately tuned muted color and is not composited into Neutral 1 ahead of time. Preserve the alpha when layering surfaces. Do not fade an entire component to simulate a transparent border.

Use the chosen theme's values and contrast roles. Neutral ordering follows the theme/mode; do not assume Neutral 1 always means white. Primary foreground may be authored per mode; use the effective component assignments instead of hardcoding white text on accent colors. Explicit foreground assignments remain meaningful choices.

CSS names are `--color-1`, `--color-1-transparent`, `--neutral-4`, `--neutral-4-transparent`, `--success`, `--error-transparent`, etc. None is `--color-none`. The reference also includes resolved convenience roles such as `--cte-canvas`, `--cte-surface`, `--cte-text`, `--cte-text-muted`, and `--cte-accent`. Define these in the app’s theme scope using the generated tables.

## Typography

Font roles: `ui`, `brand`, `editorial`, `data`. Each role has a font-family string and weights `regular`, `medium`, `heavy`. Text steps: `xxs`, `xs`, `s`, `m`, `l`, `xl`, `xxl`. Each step has a font size, line height, and letter spacing in em.

```css
.screen-title {
  font-family: var(--font-brand);
  font-size: var(--size-xl);
  line-height: var(--line-xl);
  letter-spacing: var(--letter-spacing-xl);
  font-weight: var(--weight-brand-heavy);
}
```

Apply all parts of a text step. Do not select a size and invent a different line height. Use data typography for tabular content when appropriate. All theme-controlled styling in application markup must retain named token references, including font roles and weights, text size/line height/letter spacing, spacing, colors and transparent variants, corners, border widths, shadows, and motion. Never copy computed values such as `41.98px` or `15.29px` into source when they represent `--size-xxl` or `--space-m`; those values change with the theme. Structural layout constraints remain application decisions. Use the application theme variables throughout custom components.

Font files are never included. The user must license, download, and configure the named fonts in the receiving app. Preserve family names, weights, and fallback stacks as references; use the existing fallback until the user supplies the font. Do not download fonts or silently replace the requested family.

## Spacing and sizing

Spacing keys: `zero`, `xxs`, `xs`, `s`, `m`, `l`, `xl`, `xxl`, exposed as `--space-*`. Use them for padding, gaps, margins, and layout rhythms. Their values vary by theme; a key is not a globally fixed number of pixels.

Controls generally size from content plus padding. Checkbox/switch and other explicit control geometry use their `controlSize` token assignments. Border width does not contribute to layout or thumb geometry. Authored component assignments may use a local numeric `borderWidth` in pixels instead of a named width; keep it local and still draw the edge with a shadow. Optional `backgroundOpacity` and `opacity` values are percentages (0–100), while `backdropBlur` is pixels (0–100). Omitted opacities are 100 and omitted blurs are 0. Multiply fill opacity by the color’s existing alpha without fading text or borders; layer opacity includes children. Use `backdrop-filter` (plus its WebKit counterpart) for background blur; do not offer layer blur as a customization control. Zero blur resolves to `none`, not `blur(0px)`, and lifecycle opacity must still hide exiting popups. Keep modal backdrops separate from their popups. Responsive max widths and grid structure can be application layout decisions; theme-dependent internal spacing should stay token based.

## Radius, borders, shadows, and surfaces

Radius: `zero`, `xs`, `s`, `m`, `l`, `xl`, `full`, with `--radius-*`. Corner overrides exist for parts that support them. Border widths: `none`, `s`, `m`, `l`, with `--border-*`. Elevation: `none`, `s`, `m`, `l`, with `--shadow-*`. Shadow data includes geometry, opacity, and mode-dependent color references. Optional `type` (`realistic` or `box`) and `position` (`outside` or `inside`) default to realistic outside shadows. Realistic combines contact and ambient layers at the authored strength; Box uses a single layer. Resolve the complete value through `--shadow-*`, including inset layers when selected, rather than reconstructing a shadow from its geometry.

Visible component edges use box shadows, not CSS border strokes. Set native border width to zero. For a simple custom surface:

```css
.summary-card {
  border: 0;
  border-radius: var(--radius-m);
  padding: var(--space-l);
  background: var(--neutral-1);
  box-shadow: var(--border-shadow-s), var(--shadow-s);
}
```

Use the theme’s effective component assignments and appearance values for surface treatments in each mode and state. Apply the supplied border placement and color, including its opacity. Compose edges with all authored outer and inner shadows, focus, and any separate bevel treatment. Shadow stacks are ordered; each layer is a named shadow reference or a local definition with position, offsets, blur, spread, opacity, and color. An authored stack replaces the single legacy shadow choice, and an empty stack removes all shadows. Preserve inner highlights marked clipToBorder on an inset overlay so they do not wash out a translucent edge. Do not replace the complete shadow just to add one edge. Dividers use a one-sided inset shadow. SVG artwork strokes and keyboard focus outlines are separate from component borders.

Both solid and transparent border tokens are valid. Do not automatically turn `neutral-4` into `neutral-4-transparent`. Apply shared surface treatments in the app’s reusable component styles, using the supplied mode/state assignments.

## Icons

Theme icon family, style, and weight are authored choices. Use the app’s existing icon implementation with the theme’s intended treatment. Artwork is not included; the user must supply any required licensed artwork. Decorative icons should be hidden from assistive technology, and icon-only actions need an accessible name. Preserve the instance’s size, color, and accessibility bindings when changing its glyph.

## Motion and focus

Small motion uses `--motion-duration` and `--motion-easing`; Large uses the existing `--motion-large-duration` and `--motion-large-easing` variables and `animation.large` data. Popup scale and press distance are separate variables. Zero-duration curves are immediate: remove decorative anticipation and stop loading/progress loops instead of running infinite animations at zero duration. Derive any choreography delays from the selected role. Controls, menus, and small popovers use the small curve; dialogs, drawers, toast, navigation surfaces, and disclosure panels use the Large curve. Preserve each component's implementation rather than applying one generic transition to every element.

For authored React animation, use Motion for React (`motion/react`) with the theme’s motion values when the app supports it. Easing uses a tween with duration in seconds and the authored Bézier; springs use `visualDuration` in seconds and `bounce`. Theme easing duration is recorded in milliseconds. Avoid stiffness/damping/mass when preserving visual duration. Keep the receiving app’s dependency policy.

The reference includes resolved CSS duration/easing variables, including the spring’s settling tail, alongside the authored spring values. Use these for CSS-based primitives; keep mode and theme changes live. Preserve the primitive’s mounting and animation lifecycle, transition only the intended properties, and honor reduced motion. See [Base UI](base-ui.md) or [Custom components](custom-components.md) for integration guidance.

Keep real keyboard focus indicators even when adding selected, checked, hover, or pressed styles. Disabled, read-only, invalid, loading, and complete are distinct states, not interchangeable opacity treatments.
