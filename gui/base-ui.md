# Base UI components

Use this guide when the receiving app uses Base UI. Keep existing shared wrappers and verify component APIs against the installed `@base-ui/react` declarations. The theme reference describes appearance; it does not provide React implementations.

## Apply the theme

Read the relevant component section linked from the [theme reference](themes.md). Map its part, variant, mode, and state assignments to the app’s shared component styles. Use named theme tokens and the full typography, fill, foreground, edge, elevation, and focus treatments. Preserve the primitive’s supported state selectors and anatomy.

Compose patterns from these shared controls and application content. Keep selection, focus management, dismissal, and form behavior in the primitive. Preserve the app’s existing dependencies; a theme change does not require replacing its primitive library.

## Composition and behavior

Use the documented `render` API when composing Base UI with custom components. Spread supplied props and retain refs; compose handlers deliberately. Preserve accessible labels, descriptions, native form values, and controlled/uncontrolled behavior. Avoid nested interactive elements.

Read the [composition handbook](https://base-ui.com/react/handbook/composition) and the relevant component page in the [documentation index](https://base-ui.com/llms.txt). Documentation may describe a newer version, so installed declarations remain the compatibility check.

## Portals and motion

DOM variables do not cross a portal automatically. Keep the portalled surface within the active theme scope or apply the same mode variables at its portal container. Preserve the primitive’s positioning, sizing constraints, transform origin, and dismissal behavior.

Use the theme’s motion values and retain reduced motion. Follow the specific primitive’s mounting and exit rules when introducing React animation; do not add a competing unmount timer. See the [animation handbook](https://base-ui.com/react/handbook/animation) and [Foundations](foundations.md).
