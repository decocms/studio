# Mapping an existing interface

Use the receiving project’s actual names and definitions. The examples below describe decisions, not universal equivalences between values.

| Existing treatment | Inspect first | Conversion decision |
| --- | --- | --- |
| `padding: 20px` on several cards | Is this the shared content-inset role? What does the target card use? | Replace it with the verified spacing token for that role, even if the target resolves to a different number. |
| `text-gray-500` on metadata | Does the utility already map to Graphical? Which foreground/background pair is intended? | Preserve a valid alias; otherwise use the app’s established muted-text role and verify it in supported modes. |
| A red delete action | Its action meaning and all states | Use the target’s destructive component treatment, preserving accessible text and behavior. Do not treat any similar red as equivalent. |
| A page heading with separate size/leading/weight overrides | Existing heading role and target typography | Map its font role, weight, size, line height, and letter spacing together. |
| A styled select from another primitive library | Form contract, keyboard behavior, state selectors, styling hooks, portal container | Adapt the shared wrapper using supported hooks, or identify a deliberate replacement migration. Similar token names alone are insufficient. |
| A static provider nested in a feature | Whether this is intentional theme isolation | Reuse the active scope if accidental; preserve deliberate independently themed regions. |
| `max-width: 72rem` or a two-column grid | Whether it is structure or an internal component measurement | Preserve structural constraints unless the conversion requires a layout change. |
| Five category colors in a chart | Stable category meaning, existing mappings, target palette capacity | Preserve meaning and use verified available colors; report a palette gap if the distinctions cannot be retained. |

## Mapping record

For a substantial conversion, keep a concise table with component/role, owning source, target assignment, affected consumers, states/modes, and progress. During discovery, mark pending mappings and questions explicitly. At completion, account for each component as **converted**, **already matches**, **intentionally preserved**, or **blocked**, with evidence or a reason. A small conversion can express the same information in a few sentences. An unchanged default is not an intentional exception, and an uninspected component is not verified coverage.

When a component cannot be adapted faithfully, state what its API prevents and what would need to change. Continue independent mappings. Do not make a theme change or package upgrade an unstated workaround.

## Existing shadcn projects

Use this workflow when the receiving app owns shadcn-style component source. Installing guidance or changing global CSS variables can leave the original component treatments intact.

1. **Locate the real definitions.** Inspect `components.json` when present, import aliases, stylesheet entry points, Tailwind configuration or CSS theme definitions, and imports from representative screens. Do not assume `components/ui` is the actual directory. Identify the package versions and primitive imports used by each component; shadcn alone does not identify its primitive library or installed APIs.
2. **Trace the styling layers.** Read each shared component’s base classes, variant and size definitions (including CVA when used), class merge utilities, state selectors, and consumer `className` or inline overrides. Record defaults as well as named variants; a global `--primary` change does not update fixed heights, padding, typography, radii, border placement, or shadows. Find local copies used by screens in scope instead of assuming all consumers share one implementation.
3. **Map the exported assignments.** Follow `gui/themes.md` to the selected theme’s effective component tables. Map parts, variants, sizes, and states by purpose rather than assuming matching names mean matching treatments. Resolve spacing and typography roles through that theme’s foundations. Translate assignments into the project’s existing CSS variables, utilities, or shared definitions; preserve valid aliases. Missing mappings remain explicit gaps.
4. **Update components and callers.** Adapt the owned definitions and remove conflicting legacy utilities or local overrides where the chosen scope permits. Preserve public props, handlers, refs, form behavior, accessibility, and existing primitives. Validate state selectors and composition against the installed APIs instead of replacing components with another library or regenerating them from the latest shadcn registry. Preserve dependency versions, ranges, overrides, and lockfile choices; add only genuinely missing packages under the project’s package-manager and version policy.
5. **Cover states and popups.** Inspect the applicable hover, active, focus-visible, disabled, selected/checked, open, and validation states in supported light/dark modes. Trace popup content and overlay styling separately from triggers. Ensure dialogs, selects, menus, tooltips, and other portals receive the active tokens, typography, mode, and any scoped conversion theme even when mounted outside the edited screen.
6. **Check the agreed reach.** For selected areas, inspect all consumers of changed shared components and global tokens before editing. Use supported scopes or variants without changing their defaults for unrelated consumers. If the app cannot isolate a shared change, identify that conflict instead of silently converting more of the app. Complete the scoped audit and report component coverage against the target assignments.

For example, a button may adopt the exported primary color through `bg-primary` while retaining its original `h-9`, `px-4`, `rounded-md`, `text-sm`, and focus utilities. Inspect what those classes resolve to in this app, then update the shared button’s appropriate size, variant, and state definitions from the effective assignments. A changed accent color alone does not establish that the button matches the supplied theme.
