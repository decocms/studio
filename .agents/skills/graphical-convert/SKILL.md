---
name: graphical-convert
description: Apply a supplied Graphical theme to an existing app or interface. Inventory current styling, map tokens and components, and plan or implement a scoped conversion while preserving application behavior. Use for adopting Graphical or migrating legacy UI to its theme.
---

# Convert an interface to Graphical

Use this for theme adoption, including partially converted apps. Follow a planning-only request without editing source; a request to implement conversion already authorizes the requested implementation. Do not add a mandatory approval round for routine mappings.

## Establish scope and target

Identify the requested app, feature, or screen and the supplied target theme. Read the project root `GUI.md`, `gui/theme-contract.md`, `gui/foundations.md`, and the relevant theme in `gui/themes.md`. Follow its links to effective component assignments; global values alone do not describe the component conversion. Locate these from the app root; if the guidance has not been added yet, follow the project setup steps in `GUI.md`. Do not invent a theme, registry URL, or package source when the required artifact is missing.

Inspect the framework, styling system, shared components and their consumers, theme/mode wiring, and existing customizations before changing styles. Use an explicit scope already supplied by the user. Otherwise ask once how to apply the theme, explaining the reach of shared changes:

- **Convert the whole app** — update existing shared components and their usage across screens.
- **Convert selected areas** — identify pages or components to convert, accounting for shared definitions used elsewhere.
- **Keep the current UI for now** — retain the guidance for future work without changing existing runtime styles.

Carry the answer forward into conversion and audit without asking again. If selected areas are not yet named, resolve them before editing. For guidance-only setup, finish with where the guidance lives and stop without applying global tokens or component changes.

Preserve dependencies and application behavior. Define the referenced values as named tokens in the app’s existing theme system. The download contains guidance, not application code or an installer; a style migration does not require rebuilding the host app.

## Map before editing

Read [mapping examples](references/mapping-examples.md), including the shadcn workflow when applicable. Inventory the components and theme-controlled styles in the requested scope, including existing tokens/aliases, utility configuration, shared primitives, local overrides, states, and portals. Inspect representative consumers to understand each shared style’s meaning and reach.

Build a mapping from each current role to a verified target token, component, or adapter. Match semantic purpose, hierarchy, density, and state rather than the nearest numeric value. Distinguish confirmed mappings, intentional exceptions, and unresolved gaps. Unchanged library defaults are not evidence of intentional customization; preserve an exception when user direction or project evidence supports it. Never map a required distinction to an indistinguishable treatment just to complete the table.

For a planning request, deliver the mappings, shared dependencies, implementation order, and affected checks, then stop. For implementation, use that map as the work plan and continue; ask only about missing decisions that materially affect the result.

## Convert in dependency order

1. Connect the target theme and styles at the existing application boundary. Keep mode ownership in the app. Avoid nested static providers and competing global resets.
2. Adapt shared style/token boundaries and component definitions before leaf overrides. Apply the effective assignments for each relevant variant, size, part, state, and mode, including typography, spacing, radii, fills, borders, shadows, and motion. Global token changes alone do not complete a component conversion.
3. Convert the requested screens and relevant states, including typography bundles, surfaces, icons, responsive spacing, and portal scopes. For a limited-scope conversion, isolate both token and component changes with the app’s supported scoping or variant mechanisms. Do not unintentionally retheme unrelated screens through shared definitions. If isolation is unavailable, resolve that scope conflict with the user before the broader change. Delete superseded styles only after confirming their consumers are covered.
4. Preserve routing, data, handlers, refs, form values, keyboard interactions, accessible names, and state distinctions. Replacing the app’s primitive library is not an incidental conversion step. Read `gui/base-ui.md` for Base UI primitives or `gui/custom-components.md` for adaptations.

Keep the target theme’s existing vocabulary. Report unmapped roles or incompatible APIs rather than inventing tokens, silently changing dependencies, or flattening meaningful differences. Existing artwork, domain color encodings, and third-party widgets need contextual decisions, not blind replacement.

## Verify and report

Finish an implemented conversion with the included `graphical-audit` skill: find and fix remaining gaps within the agreed conversion scope. Pass it the target theme, component mapping, and supported intentional exceptions so it can distinguish incomplete adoption from deliberate local changes. This repair pass is part of the requested conversion; do not ask for approval again or expand it to unrelated areas.

Follow `gui/verification.md` and the host’s review policy. Reinspect the converted scope for remaining overrides and broken theme/mode propagation. Check affected behavior when component wiring changed. Do not describe source checks as visual review.

Report actual component coverage with a reason or evidence for each status: **converted**, **already matches**, **intentionally preserved**, or **blocked**. Use **already matches** only after comparing the relevant assignments, modes, and states. Name any uninspected scope; do not claim completion while components remain blocked or unreviewed. Include important mappings and actual verification, grouping gaps by their owning component or style source so a later pass can continue without repeating discovery.
