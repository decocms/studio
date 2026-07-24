# Studio Documentation

Publishes current and legacy deco Studio documentation with Astro.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/docs` (`apps/docs`) |
| Kind | Astro documentation site |
| Runtime | Node.js 22+ |
| Distribution | Static site on Cloudflare Pages |

## Overview

This workspace builds the public Studio documentation as a static Astro site.
It supports versioned product content, English and Brazilian Portuguese
locales, MDX pages, React-enhanced components, and redirects for historical
URLs.

Documentation under `apps/docs` describes the intended system design and
behavior. It is both product documentation and a target specification. When the
implementation and documentation differ, do not weaken the documentation to
match an incomplete implementation.

## Responsibilities

- Publish current Studio guides, concepts, self-hosting instructions, and API
  reference content.
- Preserve the legacy `deco-chat` documentation set alongside the current
  `deco-studio` set.
- Generate versioned and localized routes for `en` and `pt-br`.
- Render MDX through the shared documentation layouts and components.
- Maintain navigation, product metadata, locale strings, syntax highlighting,
  styles, and static assets.
- Redirect legacy and `latest` URLs to stable versioned destinations.
- Produce the static `dist/client` bundle deployed to Cloudflare Pages.

## Usage

Install dependencies and start the documentation server from the repository
root:

```bash
bun install
bun run --cwd=apps/docs dev
```

The site runs at `http://localhost:4000`.

Validate and build the static site with:

```bash
bun run --cwd=apps/docs check
bun run --cwd=apps/docs build
```

The build output is `apps/docs/dist/client`.

Deploy with Wrangler after authenticating to the Cloudflare account that owns
the `decocms-docs` Pages project:

```bash
bun run --cwd=apps/docs deploy
```

## Architecture

Astro uses `client` as its source root. The content collection loads every MDX
file under `client/src/content`, and the route layer interprets the first two
path segments as product version and locale.

```text
client/src/content/<version>/<locale>/<slug>.mdx
                         |
                         v
              Astro content collection
                         |
                         v
            versioned and localized routes
                         |
                         v
                  dist/client
```

Key paths:

| Path | Purpose |
| --- | --- |
| `astro.config.mjs` | Astro root, output, Markdown, React, Tailwind, and port configuration |
| `client/src/content/` | Versioned MDX source content |
| `client/src/content.config.ts` | Content loader and frontmatter schema |
| `client/src/pages/` | Static route generation and compatibility redirects |
| `client/src/config/versions.ts` | Product versions, labels, roots, and latest-version selection |
| `client/src/i18n/` | Supported locales and translated interface strings |
| `client/src/layouts/` | Page-level documentation layouts |
| `client/src/components/` | Astro and React rendering components |
| `client/src/styles/` | Site and Markdown presentation |
| `client/public/` | Static assets and hosting redirects |

The current version ID is `deco-studio`. `deco-chat` remains available as the
legacy documentation version. `/latest/...` and unversioned locale URLs redirect
to the configured current version.

## Development

Create content at:

```text
apps/docs/client/src/content/<version>/<locale>/<slug>.mdx
```

Every document must satisfy the content schema:

```yaml
---
title: Page title
description: A concise page description
icon: optional-icon-name
---
```

Use `bun run --cwd=apps/docs check` while editing. It runs `astro sync` before
TypeScript so generated content types stay current. Run
`bun run --cwd=apps/docs build` before review to catch route generation,
frontmatter, and rendering failures. This workspace does not define a separate
test script; type checking and the production build are its focused validation
steps.

When adding a product documentation version, update
`client/src/config/versions.ts` and add matching content roots. When adding
locale-aware interface text, update `client/src/i18n/ui.ts`.

## Boundaries

- `apps/docs` owns documentation content and the documentation site's
  presentation; it does not own Studio API or web runtime behavior.
- Treat current documentation as the intended contract, even when application
  work is still converging on it.
- Do not import implementation from `apps/api/src` or `apps/web/src`. Link to
  source or public contracts when implementation context is useful.
- Keep product-version compatibility in the route layer. Do not copy stale
  content into the current version solely to preserve an old URL.
- Update English and Brazilian Portuguese counterparts together when a page
  exists in both locales.
- Keep commands executable from the repository root and identify the workspace
  explicitly.

## Content conventions

- Use clear Studio terminology and present tense.
- Put the current product documentation under `deco-studio`.
- Keep historical product behavior under `deco-chat` and label it as legacy.
- Store reusable presentation in `client/src/components` or
  `client/src/layouts`, not inside repeated MDX markup.
- Put files that must retain their public name in `client/public`.
- Add redirects in the route files only when an existing public URL needs
  compatibility.

## Related documentation

- [Studio API](../api/README.md)
- [Studio web app](../web/README.md)
- [Repository guidelines and documentation philosophy](../../AGENTS.md)
- [Project overview](../../README.md)
- [Astro documentation](https://docs.astro.build/)
- [Cloudflare Pages deployment documentation](https://developers.cloudflare.com/pages/)
