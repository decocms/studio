# @decocms/ui

The decocms product design system: reusable React primitives, design tokens,
hooks, and generic interaction patterns.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/ui` (`packages/ui`) |
| Kind | Open-source React design-system package |
| Runtime | React 19; browser |
| Distribution | Public npm package (`@decocms/ui`, MIT) |

## Overview

`@decocms/ui` is the UI foundation for Studio and other decocms apps. It contains
React components built on Radix primitives, Tailwind CSS v4 design tokens, generic
browser hooks, assets, and small presentation utilities.

The package exports files through explicit wildcard namespaces rather than a root
barrel. Consumers import the component, hook, style, or utility they need.

## Installation (external apps)

```bash
bun add @decocms/ui react react-dom
```

Requirements: React 19 and Tailwind CSS v4 (e.g. `@tailwindcss/vite`). Then make
the design-system stylesheet your CSS entry point (it pulls in Tailwind, the
tokens, and the bundled fonts):

```css
@import "@decocms/ui/styles/global.css";
```

External consumers import extensionless subpaths, which resolve to compiled ESM
with type declarations:

```tsx
import { Button } from "@decocms/ui/components/button";
```

If your form uses this package's `form.tsx` or toasts use `sonner.tsx`, install
the matching peers (`react-hook-form`, `sonner`) so app and design system share
one instance.

## Responsibilities

- Provide accessible, composable interface primitives.
- Define Studio's shared visual tokens and global Tailwind styles.
- Encapsulate generic browser interaction patterns.
- Supply presentation helpers, icons, and fonts.
- Keep common component variants and styling behavior consistent.

## Usage

Import source modules through their declared namespaces:

```tsx
import { Button } from "@decocms/ui/components/button.tsx";
import { cn } from "@decocms/ui/lib/utils.ts";

export function SaveButton() {
  return (
    <Button className={cn("w-full")} type="submit">
      Save
    </Button>
  );
}
```

Load the design-system stylesheet from the web application's CSS entry point:

```css
@import "@decocms/ui/styles/global.css";
```

User-facing copy belongs to the application translation layer:

```tsx
import { Button } from "@decocms/ui/components/button.tsx";
import { useT } from "@/i18n/use-t.ts";

export function CreateOrganizationButton() {
  const t = useT();
  return <Button>{t("common.createOrganizationDialog.createButton")}</Button>;
}
```

## Architecture

The package is organized by public namespace:

- `components` contains Radix-based primitives and composed, application-neutral
  controls.
- `hooks` contains reusable browser state and interaction hooks.
- `lib` contains pure class, formatting, and interaction helpers.
- `styles` contains global Tailwind v4 tokens, themes, and base styling.
- `assets` contains fonts and other design-system assets.

Most files are direct package entry points. There is no `@decocms/ui` root export,
and components do not need registration in a central barrel.

`cn()` combines `clsx` and `tailwind-merge` for conditional class composition.
Component variants use design-system tokens such as `primary`, `destructive`,
`success`, and `muted` so theme changes remain centralized in `global.css`.

## Development

Compile dist (ESM + type declarations — runs automatically before publish), and
launch the component workshop:

```bash
bun run --cwd=packages/ui build
bun run --cwd=packages/ui storybook
```

Run focused tests and consumer type checks from the repository root:

```bash
bun test packages/ui/src
bun run --cwd=apps/web check
```

For broader repository validation:

```bash
bun run lint
bun run fmt
```

UI behavior that depends on a real browser belongs in the web component or E2E
suite rather than a mocked unit test:

```bash
bun run --cwd=apps/web test:ct
```

## Boundaries

- `apps/web` owns product features, routes, data fetching, authentication,
  organization state, and Studio-specific orchestration. This package owns
  reusable presentation and generic interaction behavior.
- `apps/web` also owns internationalization dictionaries and locale selection.
  Components that render product copy accept that copy through props; callers
  translate it with `useT()`.
- `packages/ui` must not import from `apps/web` or `apps/api`. Application code may
  depend on the design system, never the reverse.
- Use semantic design-system tokens instead of raw Tailwind palette colors. Add or
  revise a token centrally when a reusable visual role is missing.
- Keep components composable and controlled where practical. Do not hide network
  requests, server mutations, or route navigation inside a primitive.
- Browser-dependent hooks and audio helpers stay in browser call paths. Do not
  assume this package can execute in an API or other server-only process.
- Preserve accessibility labels, keyboard behavior, focus management, and
  reduced-motion behavior when extending a primitive.
- Follow the repository's React 19 rules for new or modified code; application
  optimization belongs to the React compiler.

## Export surface

| Import | Purpose |
| --- | --- |
| `@decocms/ui/components/*` | React components and component variants |
| `@decocms/ui/hooks/*` | Generic React/browser hooks |
| `@decocms/ui/lib/*` | Presentation and interaction utilities |
| `@decocms/ui/styles/*` | Tailwind theme and global styles |
| `@decocms/ui/assets/*` | Fonts and other static design assets |

Workspace imports inside this monorepo keep the source filename extension and
resolve to TypeScript source (`@decocms/ui/components/button.tsx`). External
consumers use extensionless subpaths that resolve to compiled output
(`@decocms/ui/components/button`).

## Internationalization ownership

This package does not select a locale and does not contain Studio translation
dictionaries. Product-facing strings, including labels, placeholders, tooltips,
toasts, empty states, and ARIA text, are translated in `apps/web` and passed to
reusable components.

A primitive may provide a generic English default only when the public props allow
the application to override it. If content must interpolate links or styled
elements, keep that composition in `apps/web`, where the feature owns both the
translation key and the rendered structure.

## Claude Code skill

This package ships a Claude Code plugin (`decocms-ui`) with a skill that teaches
agents how to install and use the design system. In any repo:

```
/plugin marketplace add decocms/studio
/plugin install decocms-ui@decocms
```

The skill lives in `skills/decocms-ui/SKILL.md`; keep it in sync when component
APIs or tokens change.

## Related documentation

- [Bundled fonts](./src/assets/fonts/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
