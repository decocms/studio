# Custom markup and other component libraries

Read this when composing ordinary HTML/React markup or adapting an existing component library. Read [Foundations](foundations.md) for the shared vocabulary and [Theme contract](theme-contract.md) for resolution. The reference describes design tokens and component treatments; adapt them through the receiving library’s supported styling API.

## Choose the integration boundary

Prefer the app’s existing shared components and patterns. A card, report, toolbar, or chart can compose them with application markup without becoming an editable catalog component.

When an app uses another component library, inspect its installed APIs, styling hooks, state selectors, and portal behavior. Preserve working interaction and accessibility behavior. Use a small adapter at its existing shared component boundary when possible. Replacing the primitive library is a separate migration decision, not a prerequisite for consuming theme variables.

Do not pass Base UI-specific props, state attributes, or mounting recipes to unrelated components. Do not assume matching variable names produce the same appearance: a component’s dimensions, state treatments, and shadow composition may need explicit adaptation. Report unsupported styling or behavioral differences rather than silently claiming complete theme fidelity.

## Style from the active scope

Use the existing application theme scope. Within it, custom CSS can consume named variables directly:

```css
.report-heading {
  font-family: var(--font-brand);
  font-weight: var(--weight-brand-heavy);
  font-size: var(--size-xl);
  line-height: var(--line-xl);
  letter-spacing: var(--letter-spacing-xl);
  color: var(--cte-text);
  margin-block: var(--space-zero) var(--space-l);
}

.report-grid {
  display: grid;
  grid-template-columns: minmax(0, 2fr) minmax(0, 1fr);
  gap: var(--space-l);
}
```

Verify these names and their intended role in the receiving theme. The grid ratio is structure; the gap and typography are theme-controlled. A known snapshot value such as `20px` is still a hardcoded override when it substitutes for a live spacing token.

Retain existing CSS modules, utility classes, or CSS-in-JS conventions. A utility or app alias is valid when it resolves to the active Graphical theme. Trace that mapping before replacing it. Do not add a parallel utility palette or new aliases that conceal arbitrary values. Use a direct token reference where an alias adds no useful application meaning.

For component parts, map the effective token assignments from the theme reference to the app’s shared styles, preserving state, mode, and theme-specific treatments. For new markup, use existing foundations without inventing catalog identifiers. Avoid copying only a resolved background while dropping the associated foreground, edge placement, elevation, or focus treatment.

## Carry the scope into portals

A portal outside the themed DOM subtree cannot inherit its CSS variables. Reuse the app’s supported theme/portal adapter, or apply the same active-mode CSS variables to the portalled scope. Keep theme and mode changes live. Where supported, placing the portal inside an existing themed container is another option; check clipping and stacking behavior.

React context alone does not supply DOM inheritance. Reuse the app’s theme and mode ownership rather than adding a second static theme that can diverge from it.

## Preserve meaning and behavior

Keep native semantics, accessible names, refs, callbacks, form participation, controlled/uncontrolled behavior, and keyboard interactions. Map hover, focus, selected, checked, disabled, read-only, invalid, and loading treatments separately where they exist. Preserve the host library’s positioning and exit lifecycle.

For charts, reuse current series conventions and theme colors when suitable. Preserve distinctions encoded in color, units, legend labels, and static cues. A categorical series is not a success/error state merely because its hue resembles a status color. If the existing theme cannot support the required distinctions, report the gap without adding a palette under an unrelated UI task.

Check the affected component and its portal in supported modes and states using the project’s review policy. Follow [Verification](verification.md); source inspection alone cannot establish rendered contrast or visual fidelity.
