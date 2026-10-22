---
name: decocms-ui
description: Build or style React UI with the decocms product design system (@decocms/ui). Use when creating a new screen, page, or component that should look like decocms products, when the user mentions "design system", "@decocms/ui", "decocms style", or asks to make UI consistent with Studio. Covers screen layout (width, titles, copy, which card), installation, tokens, and the component inventory.
---

# decocms product design system (@decocms/ui)

React 19 components on Radix primitives, styled with Tailwind CSS v4 semantic
tokens. Light and dark themes work out of the box. Every component and token:
https://designsystem.decocms.com/

## Building a screen

Make these decisions in order. Each has one right answer for most screens.

### 1. Width: pick by content, not by taste

| Content | Width |
| --- | --- |
| A form, one column of settings, a feed, a first-run or empty page | `reading`, 720px |
| Sections of settings, tables, or forms mixed with tables | `standard`, 1024px |
| Grids of cards, dashboards, multi-column lists | `wide`, 1200px (the default) |
| Boards, editors, canvases, tables that need every column | `fluid` |

Center the column and keep one width for the whole page. Don't put a narrow
search field above a full-width list. Make the list narrow too.

### 2. Title: usually none

The header breadcrumb already names the page. Don't render an `h1` or a big
heading that repeats the route, tab, or breadcrumb label. Add a heading only
when the page shows something the breadcrumb can't, like an entity's name.

- Don't add a subtitle or description under the page name.
- Section headings (`h2`, `text-base font-medium`) are only for pages with two
  or more sections. A page with one card doesn't need one.
- Don't add a "Settings" label above the settings.

### 3. Copy: say only what the UI doesn't

Write a description only when it tells the user something the controls don't:
a consequence ("Members lose access immediately"), a constraint ("Up to 10
domains"), or a unit. Don't restate the label ("Name: the name of the project"),
don't explain obvious actions, and don't add marketing lines. Labels are short
nouns and buttons are verbs ("Create project", not "Click here to create").
Empty states get a title and one action. Add a description only when the next
step isn't obvious.

### 4. Container: pick by what the content is

| What it is | Use | Not |
| --- | --- | --- |
| A titled group of settings or fields | `Card` (default size) | a bordered `div` |
| One thing you open, among many | `EntityCard` in an `EntityGrid` | `Card` with custom layout |
| A number and its trend | `MetricCard` (+ `Sparkline`) | `Card` with a big text |
| A list of things | `ListRow variant="divided"` in a `Card size="flush"` | a card per row |
| A status, warning, or error | `Alert` | a tinted card |
| Something nested inside a card (code, a preview, a sub-list) | `CardInset` | a card in a card |
| Nothing yet, nothing matched, or it failed | `EmptyState` (`size="page"` or `"inline"`) | a centered paragraph |
| Loading | `Skeleton` shaped like the content, `EntityGrid.Skeleton`, `EntityCard.Skeleton` | a lone spinner for a whole page |

A card or row that opens something gets `interactive` (`Card`, `ListRow`),
plus `asChild` around the link. Never nest cards. One surface per level:
page → card → inset.

### 5. Actions

- Put page actions in the header's right slot, not inside the content.
- Exactly one primary (`Button`, default variant), e.g. "New task". Every other
  action in the header is `variant="outline"`.
- Destructive actions go last and confirm through `AlertDialog`.
- An icon-only button is an `IconButton` with a `label`. The label becomes its
  tooltip and accessible name. Never put a bare icon in a `Button`.

### 6. Spacing

Stack page sections with `gap-10` and leave `gap-3` between a section heading
and its card. Cards already space their own children. Don't add margins or
padding on top of `Page.Container`; it owns the page padding.

### Inside Studio (`apps/web`)

Compose screens with `Page` from `@/components/page`. It owns scrolling,
padding, width, and the header:

```tsx
<Page>
  <Page.Actions secondary={<Button variant="outline">Import</Button>}>
    <Button>New project</Button>
  </Page.Actions>
  <Page.Content>
    <Page.Container width="reading">{/* sections */}</Page.Container>
  </Page.Content>
</Page>
```

- `Page.Title` doesn't render a heading under a route header. It renames the
  breadcrumb's last item, so use it only for a dynamic label like an entity's
  name.
- Settings screens use `SettingsPage`, `SettingsSection`, `SettingsCard`, and
  `SettingsCardItem` from `@/components/settings/settings-section`, inside
  `SettingsGroupPage` for tabbed groups.
- Views of one page go in `Page.Tabs` / `Page.Tab` in the header toolbar, not
  as tabs in the content.
- Read `apps/web/docs/component-architecture.md` before changing headers,
  tabs, or scrolling.

## Rules

1. **Semantic tokens only, never raw palette.** `bg-primary`, `text-muted-foreground`,
   `bg-destructive`, `border-border` — never `bg-red-500` or `text-zinc-400`.
   Color roles: `background`, `foreground`, `card`, `popover`, `primary`,
   `secondary`, `muted`, `accent`, `destructive`, `success`, `warning`, `special`
   (AI/highlight moments), `brand`, `border`, `input`, `ring`, `sidebar-*`
   (sidebar surfaces, also the app canvas), `chart-1..5` (data viz). Most roles
   pair with a `*-foreground` text token. `subtle-foreground` is for placeholders
   and decorative meta only; it fails contrast for anything users must read.
   Brand tints: `brand-lime-tint`, `brand-purple-tint`, `brand-yellow-tint`,
   `brand-blue-tint` with their `-dark` inks. Project colours:
   `project-blue|green|purple|red|amber`. Status tints are the status colour at
   10% (`bg-success/10 text-success`).
2. **Dark mode is automatic** via the `.dark` class on a root element. Never
   hardcode colors or write `dark:` overrides that bypass tokens.
3. **Compose, don't fork.** Extend components with `className` + `cn()`. Add
   variants through the component's `cva` config instead of wrapping it with
   custom styles.
4. **Inter only, Medium at most.** Body is 13px Regular (`text-sm`), meta is
   12px (`text-xs`, `text-muted-foreground`), and headlines use `font-display`.
   Use `font-medium` for labels and titles. `font-semibold` is an alias of 500,
   and `font-bold` (600) is for emphasis in prose only.
5. **Shapes come from the components.** Buttons, selects, tabs, badges, and
   chips are pills. Inputs use radius 10. Cards and panels use radius 16 (`surface`).
   Modals and floating panels are frosted (`glass`, over `bg-scrim`). Don't
   override radii or shadows; the `surface`, `surface-interactive`, `shadow-edge`,
   and `shadow-lift` utilities own them.
6. **User-facing copy comes from the app**, passed as props. Components ship
   only English defaults that the app can override.

## Install (new project)

```bash
bun add @decocms/ui react react-dom
```

Requires React 19 and Tailwind CSS v4 (`bun add -d tailwindcss @tailwindcss/vite`
plus the `tailwindcss()` plugin in `vite.config.ts`). Make the design-system
stylesheet the FIRST import of the app's CSS entry point. It brings Tailwind,
the tokens, and the fonts (Inter + Commit Mono), so don't also
`@import "tailwindcss"`:

```css
@import "@decocms/ui/styles/global.css";
```

Peers: install `react-hook-form` for `form` and `sonner` for toasts, so the app
and the design system share one instance.

## Imports

There is no barrel export. Import each component from its own subpath,
without the file extension:

```tsx
import { Button } from "@decocms/ui/components/button";
import { cn } from "@decocms/ui/lib/utils";
```

Inside the decocms/studio monorepo, keep the extension:
`@decocms/ui/components/button.tsx`.

## Component inventory

- **Forms**: button, icon-button, input (+ input-group), textarea, label, checkbox,
  radio-group, switch, slider, select, form (react-hook-form), password-input,
  datetime-input, tags-input, multi-select, search-input, combobox,
  time-range-picker
- **Overlays**: dialog, alert-dialog, sheet, drawer, popover, tooltip,
  command (palette), context-menu, dropdown-menu
- **Feedback**: alert, badge (tones + dot), progress (tones), stage-tracker,
  skeleton, spinner, sonner (toasts), empty-state
- **Layout & navigation**: card (`size` default / tile / flush, `interactive`,
  CardInset), separator, tabs, accordion, collapsible, breadcrumb, pagination,
  scroll-area, aspect-ratio, table, sidebar
- **Collections**: entity-card, entity-grid, metric-card, list-row
  (`variant` default / divided, `interactive`, `selected`), filter-bar
- **Agent & identity**: composer, agent-avatar, avatar, project-icon, chip,
  button `variant="agent"`
- **Data & content**: sparkline, calendar, carousel, chart (recharts + chart
  tokens), markdown, button-group, split-button, toggle, toggle-group (icon
  items take `tooltip`)

Before using a component, read its source in
`node_modules/@decocms/ui/src/components/<name>.tsx` (in the monorepo:
`packages/ui/src/components/<name>.tsx`) for its exact exports and props.

## Icons

Use `@untitledui/icons`, which the components use too:

```tsx
import { Plus, SearchMd, Trash01 } from "@untitledui/icons";
```
