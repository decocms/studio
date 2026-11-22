---
name: graphical-ui
description: Build and edit frontend UI in apps using a Graphical theme, including new screens, custom markup, component composition, charts, and responsive states. Use the current theme and existing components. Theme conversion and codebase drift audits have separate workflows.
---

# Build with Graphical

Use this for ordinary interface work in an app that already uses Graphical. Read the project root `GUI.md`, then `gui/interface-judgment.md` and `gui/foundations.md`. Those files own the shared design rules. Locate them from the project root, not relative to this installed skill.

## Establish the local vocabulary

Locate the active theme factory/document, mode wiring, component imports, and a nearby example of the requested UI. Read actual declarations and token definitions before using an unfamiliar name. The generated `gui/themes.md` links to exported values; customized local source takes precedence.

Read `gui/base-ui.md` for Base UI components or `gui/custom-components.md` for custom markup and other primitive libraries. Read `gui/theme-contract.md` when changing assignments or resolving a shared part. For initial adoption, follow `GUI.md` and graphical-convert to define the supplied theme in the app’s existing styling system.

## Implement the requested interface

1. Reuse existing navigation, layout patterns, and shared components. Give peer headings, metadata, and controls consistent visual roles. Preserve the app’s content, behavior, and intentional customizations.
2. Choose existing tokens by role. Keep named references for colors, complete typography, spacing, surfaces, icons, and motion. Verify optional colors, component variants, and part/state identifiers instead of guessing them.
3. Compose new patterns from existing controls. Use custom markup for application structure; preserve the underlying primitive’s behavior. Carry theme variables into portals and keep mode/state changes live.
4. Use Motion for React (`motion/react`) for authored React animation, with the active theme’s authored motion values. Springs use `visualDuration` and `bounce`; retain the primitive’s mount lifecycle and reduced-motion behavior described in `gui/foundations.md` and `gui/base-ui.md`.
5. Cover the relevant responsive, empty, loading, error, disabled, and interaction states. Reuse their current treatments rather than inventing another visual vocabulary per state.

New compositions are allowed. New theme values or parallel scales are not part of ordinary UI work. If no existing choice meets the requirement, identify the missing capability and continue independent work; do not hide the gap behind a new CSS variable or literal fallback. When the user explicitly requests a theme change, make that change at its owning source and explain its shared impact.

Structural layout values and verified project aliases are valid under `GUI.md`. A request to add a screen is not authorization to audit or normalize the entire application.

## Finish

Review the changed code for invented tokens, copied snapshot values, redundant elements, and unnecessary overrides. Use `gui/verification.md` and the project’s policy for affected checks. Keep the result concise: what changed, which existing patterns or tokens it uses, what was verified, and any unresolved theme gap or unreviewed visual behavior.
