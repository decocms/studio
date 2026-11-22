# GUI — deco design language

Use this guide and the accompanying skills to build with the supplied theme. The download contains Markdown guidance and theme references. Implement the theme in the receiving app’s existing styling system and components.

## Add to a project

Keep `GUI.md` and `gui/` at the project root. The install command places the three skills in the project’s `.agents/skills/` directory. When using the ZIP instead, copy the three folders in `skills/` there, preserving any existing skills and local edits. Add a short pointer to the project’s active agent instructions: “For UI work, follow GUI.md and use graphical-ui, graphical-convert, or graphical-audit as appropriate.” Preserve the instructions already there. Agents with other conventions can follow this guide directly.

For initial setup, inspect the app’s styling system, shared components, and their consumers before changing styles. If the user has not specified a conversion scope, ask once: **“How would you like to apply this theme?”**

- **Convert the whole app** — update existing shared components and their usage across screens.
- **Convert selected areas** — identify the pages or components and account for shared changes that could affect other screens.
- **Keep the current UI for now** — install the guidance for future work without changing application styles, components, or runtime dependencies.

Wait for the choice before changing application styles. Honor an already specified scope without asking again; a request for one component does not authorize a whole-app conversion. For selected areas, resolve any missing scope and contain shared changes using the app’s existing mechanisms. For guidance-only setup, finish installing the Markdown and instruction pointer, then stop without applying global tokens. The supplied references do not authorize later conversion outside a requested UI task.

For conversion, use `graphical-convert`, including its shadcn mapping guidance when applicable. Read the [theme reference](gui/themes.md) and linked effective component assignments. Implement the chosen scope in the app’s current theme system and shared components, covering parts, variants, sizes, states, and modes. Global token changes alone do not complete conversion. Preserve framework, routing, behavior, dependencies, and intentional local customizations; unchanged library defaults are not automatically intentional exceptions. Add only missing packages required by the implementation using the project’s package manager and version policy.

Finish conversion with `graphical-audit` to find and fix remaining gaps against the agreed target within the chosen scope. Report each component as converted, already matches, intentionally preserved, or blocked, with evidence or a reason, plus actual verification and any gaps. Skill files can be read directly from `.agents/skills/` (or `skills/` in the ZIP) when the agent does not discover them automatically.

Fonts are references only. Users must license, download, and configure their own font files. Preserve the named families, weights, and fallback stacks; report unavailable fonts rather than downloading or substituting them silently.

## Find the actual theme values

The [theme index](gui/themes.md) links to the included project’s literal font families and weights, text sizes, line heights, letter spacing, spacing, radii, borders, shadows, motion, and resolved CSS variables for both modes. Each theme links to its effective component token assignments, including defaults, shared parts, variants, and states.

These references capture the project at download time. After deliberate local customization, the app’s active token definitions and components take precedence. Read only the theme and component sections needed by the task.

## Rules for UI work

- Locate the active theme, color mode, shared components, and nearby patterns before choosing styles. Preserve existing behavior and intentional customizations.
- Use the existing theme vocabulary. Do not introduce colors, text steps, spacing steps, radii, shadows, or motion values to finish a screen. Identify a gap when no suitable choice exists; change the theme when requested.
- Keep named references at use sites. Typography includes font role, weight, size, line height, and letter spacing. Literal values belong in token definitions.
- Reuse shared components and visual roles. Compose new patterns while keeping equivalent controls consistent. Give information a clear home and avoid redundant content.
- Grid tracks, breakpoints, content widths, aspect ratios, and positioning can be structural choices. Preserve verified aliases, meaningful data encodings, and external widgets in context.
- Preserve keyboard focus, accessible labels, form values, interaction states, and theme propagation into portals. Render edges with composed box shadows and zero native border width, retaining opacity and theme stroke placement.
- Preserve dependency versions, ranges, overrides, and lockfiles. Check APIs against installed versions and follow the project’s verification and browser-review policy.

## Read what the task needs

For interface creation or revision, read Interface judgment and Foundations, then the relevant component guide. A small edit does not trigger an application-wide audit.

| Need | Reference |
| --- | --- |
| Ownership, token definitions, shared assignments, and deliberate theme changes | [Theme contract](gui/theme-contract.md) |
| Hierarchy, composition, navigation, charts, and clear controls | [Interface judgment](gui/interface-judgment.md) |
| Color, typography, spacing, surfaces, icons, and motion | [Foundations](gui/foundations.md) |
| Working with Base UI primitives | [Base UI](gui/base-ui.md) |
| Custom markup and existing component libraries | [Custom components](gui/custom-components.md) |
| The downloaded project’s concrete values and assignments | [Theme reference](gui/themes.md) |
| Proportional checks and integration failures | [Verification](gui/verification.md) |

| Request | Skill |
| --- | --- |
| Build or edit UI using the current theme | `graphical-ui` |
| Apply the supplied theme to an existing interface | `graphical-convert` |
| Find theme drift and repair it when requested | `graphical-audit` |
