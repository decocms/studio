# Theme ownership and resolution

The [theme reference](themes.md) supplies the project’s foundations, light/dark CSS values, and effective component assignments. The receiving app owns their implementation. Read [GUI.md](../GUI.md) first.

## Define the theme once

Use the supplied values as named definitions in the app’s existing CSS variables, theme object, or token configuration. Keep both modes together and retain its current mode selection mechanism. Map existing aliases to the supplied values when they serve the same role. Literal values belong in these definitions; components consume named references.

The per-theme component reference includes effective assignments with defaults and shared references resolved. Choose the relevant component, variant, part, state, and mode. Translate token names through the foundations: for example, an `m` padding assignment uses the theme’s M spacing, while an `xl` radius uses its XL radius. Font roles have their own weight mappings. Match the property’s vocabulary rather than treating the same name as one universal measurement.

Authored component assignments record project edits for reference. They can be partial; use the effective assignment tables when implementing components. These tables describe styling, not an importable component API. Preserve the receiving primitive’s anatomy, accessibility behavior, and supported state selectors.

The user’s theme name identifies the design language. Use that name throughout the app and its documentation; starter-style names are not part of the exported theme. The effective component assignments describe its authored surface treatments. Apply the current mode and state when choosing fills, edge placement, typography, and shadows.

## Preserve local ownership

After adoption, intentional changes in the app’s theme definitions and shared components take precedence over the downloaded snapshot. Inspect those definitions before changing a screen. Do not restore original values merely because they appear in the reference.

During initial or incomplete conversion, use the agreed target theme and component mappings as the baseline. Existing library defaults or unconverted styles are not evidence of intentional customization. Record a preserved exception only when supported by the user’s direction or an established product requirement; distinguish it from a component that still needs conversion.

A shared token change can affect many screens. For a single element, prefer another existing token or the relevant component variant. When the user requests a theme change, edit its shared definition and explain the affected scope. Do not invent a parallel scale to work around it.

Reuse existing components and primitive libraries. Compose patterns from shared controls; retain focus, labels, keyboard interaction, values, mode behavior, and portalled theme scope. Use [Base UI](base-ui.md) for that library or [Custom components](custom-components.md) for another implementation.

## Updates

A new download is another reference snapshot. Compare it with intentional local theme and component changes before adopting it. Preserve local agent instructions and skills. Editing Markdown alone does not change the app’s runtime styling.

The guidance requires no Graphical package, provider, source directory, or installer. Preserve the receiving project’s dependencies and check any APIs against its installed versions. Fonts and artwork must be supplied with appropriate licenses by the user.
