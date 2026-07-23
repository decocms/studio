# @deco/ui

Provides Studio's reusable React primitives, design tokens, hooks, and generic
interaction patterns.

| Attribute | Value |
| --- | --- |
| Workspace | `@deco/ui` (`packages/ui`) |
| Kind | Private React design-system package |
| Runtime | React 19; browser |
| Distribution | Private workspace package |

## Overview

`@deco/ui` is Studio's private UI foundation. It contains React components built
on Radix primitives, Tailwind CSS design tokens, generic browser hooks, providers,
assets, and small presentation utilities used by `apps/web`.

The package exports source files through explicit wildcard namespaces rather than
a root barrel. Consumers import the component, hook, provider, style, or utility
they need.

## Responsibilities

- Provide accessible, composable interface primitives.
- Define Studio's shared visual tokens and global Tailwind styles.
- Encapsulate generic browser interaction patterns.
- Supply presentation helpers, icons, sound assets, and fonts.
- Keep common component variants and styling behavior consistent.
- Expose reusable providers only when they remain independent of an application
  route or server implementation.

## Usage

Import source modules through their declared namespaces:

```tsx
import { Button } from "@deco/ui/components/button.tsx";
import { cn } from "@deco/ui/lib/utils.ts";

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
@import "@deco/ui/styles/global.css";
```

User-facing copy belongs to the application translation layer:

```tsx
import { Button } from "@deco/ui/components/button.tsx";
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
- `lib` contains pure class, formatting, sound, and interaction helpers.
- `providers` contains reusable React context boundaries.
- `styles` contains global Tailwind v4 tokens, themes, and base styling.
- `assets` contains fonts and other design-system assets.

Most files are direct package entry points. There is no `@deco/ui` root export,
and components do not need registration in a central barrel.

`cn()` combines `clsx` and `tailwind-merge` for conditional class composition.
Component variants use design-system tokens such as `primary`, `destructive`,
`success`, and `muted` so theme changes remain centralized in `global.css`.

## Development

`packages/ui` has no package-local scripts. Run focused tests and consumer type
checks from the repository root:

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
| `@deco/ui/components/*` | React components and component variants |
| `@deco/ui/hooks/*` | Generic React/browser hooks |
| `@deco/ui/lib/*` | Presentation and interaction utilities |
| `@deco/ui/styles/*` | Tailwind theme and global styles |
| `@deco/ui/assets/*` | Fonts and other static design assets |
| `@deco/ui/providers/*` | Reusable React context providers |

The wildcard includes the source filename extension in current workspace imports,
for example `@deco/ui/components/button.tsx` and `@deco/ui/lib/utils.ts`.

## Internationalization ownership

This package does not select a locale and does not contain Studio translation
dictionaries. Product-facing strings, including labels, placeholders, tooltips,
toasts, empty states, and ARIA text, are translated in `apps/web` and passed to
reusable components.

A primitive may provide a generic English default only when the public props allow
the application to override it. If content must interpolate links or styled
elements, keep that composition in `apps/web`, where the feature owns both the
translation key and the rendered structure.

## Related documentation

- [Bundled fonts](./src/assets/fonts/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
