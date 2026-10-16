---
name: decocms-ui
description: Build or style React UI with the decocms product design system (@decocms/ui). Use when creating interfaces, pages, or components in a project that should look like decocms products, when the user mentions "design system", "@decocms/ui", "decocms style", or asks to make UI consistent with Studio. Covers installation, Tailwind v4 token setup, component inventory, and usage conventions.
---

# decocms product design system (@decocms/ui)

React 19 components built on Radix primitives, styled with Tailwind CSS v4
semantic tokens. Light and dark themes work out of the box. Browse every
component and token at https://designsystem.decocms.com/

## Install (new project)

```bash
bun add @decocms/ui react react-dom
```

Requirements: React 19 and Tailwind CSS v4 (`bun add -d tailwindcss @tailwindcss/vite`
plus the `tailwindcss()` plugin in `vite.config.ts`).

Make the design-system stylesheet the FIRST import of the app's CSS entry point —
it pulls in Tailwind itself, all tokens, and the bundled fonts (Inter + Commit Mono).
Do NOT also `@import "tailwindcss"` yourself:

```css
@import "@decocms/ui/styles/global.css";
```

Tailwind only scans app source by default; if the app's classes come exclusively
from @decocms/ui components this already works — the package declares its own
`@source`.

Peers: install `react-hook-form` if you use the `form` component, and `sonner`
if you use toasts (`sonner` component). They are peers so the app and the design
system share one instance — never bundle a second copy.

## Imports

No barrel export. Import each component from its subpath, extensionless:

```tsx
import { Button } from "@decocms/ui/components/button";
import { Dialog, DialogContent, DialogTrigger } from "@decocms/ui/components/dialog";
import { cn } from "@decocms/ui/lib/utils";
import { useIsMobile } from "@decocms/ui/hooks/use-mobile";
```

Exception — inside the decocms/studio monorepo, workspace imports keep the
source extension: `@decocms/ui/components/button.tsx`.

## Rules

1. **Semantic tokens only, never raw palette.** `bg-primary`, `text-muted-foreground`,
   `bg-destructive`, `border-border` — never `bg-red-500` or `text-zinc-400`.
   Available color roles: `background`, `foreground`, `card`, `popover`, `primary`,
   `secondary`, `muted`, `accent`, `destructive`, `success`, `warning`, `special`
   (AI/highlight moments), `brand`, `border`, `input`, `ring`, `sidebar-*`
   (sidebar surfaces, also the app canvas), `chart-1..5` (data viz). Most roles
   pair with a `*-foreground` text token. `subtle-foreground` is meta and
   placeholder text. Brand tints: `brand-lime-tint`, `brand-purple-tint`,
   `brand-yellow-tint`, `brand-blue-tint` with their `-dark` inks; project
   colours: `project-blue|green|purple|red|amber`. Status tints are the status
   colour at 10% (`bg-success/10 text-success`).
2. **Dark mode is automatic** via the `.dark` class on a root element — never
   hardcode colors or write `dark:` overrides that bypass tokens.
3. **Compose, don't fork.** Extend components with `className` + `cn()`; add
   variants through the component's `cva` config rather than wrapping with
   custom styles.
4. **Inter only, at most Medium.** Body is 13px Regular (`text-sm`), meta 12px
   (`text-xs`), headlines use `font-display`. `font-semibold` renders at 500.
   Buttons, inputs in toolbars, selects, tabs, badges and chips are pills;
   form inputs are radius 10; cards and panels radius 16 (`surface`).
   Modals and floating panels are frosted (`glass`, over `bg-scrim`).
5. **User-facing copy comes from the app**, passed as props — components ship
   only overridable English defaults.

## Component inventory

- **Forms**: button, input, textarea, label, checkbox, radio-group, switch,
  slider, select, form (react-hook-form), input-otp, password-input,
  datetime-input, email-tags-input, multi-select, search-input, combobox,
  time-range-picker
- **Overlays**: dialog, alert-dialog, sheet, drawer, popover, hover-card,
  tooltip, command (palette), context-menu, dropdown-menu, menubar,
  responsive-dropdown, responsive-select (desktop/mobile adaptive)
- **Feedback**: alert, badge (tones + dot), progress (tones), stage-tracker,
  skeleton, spinner, sonner (toasts), empty-state, empty-state-illustrations
- **Layout & navigation**: card, separator, tabs, accordion, collapsible,
  breadcrumb, navigation-menu, pagination, scroll-area, aspect-ratio, table,
  sidebar (full app sidebar system), sidebar-footer-shell, app-topbar,
  topbar-switcher, user-menu, step-indicator
- **Agent & identity**: composer, agent-avatar, org-avatar, project-icon,
  chip (entities), button `variant="agent"`
- **Data & content**: avatar, metric-card, sparkline, list-row, calendar,
  carousel, chart (recharts + chart tokens),
  markdown, entity-card, entity-grid, filter-bar, collection-search,
  view-mode-toggle, button-group, toggle, toggle-group

Before using a component, read its source in `node_modules/@decocms/ui/src/components/<name>.tsx`
(shipped in the package) to see its exact exports and props, or check its page
in the Storybook.

## Icons

Components use `@untitledui/icons` (comes as a dependency). Prefer it in
consuming apps for visual consistency:

```tsx
import { Plus, SearchMd, Trash01 } from "@untitledui/icons";
```
