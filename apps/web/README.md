# Studio Web

Provides the Vite-powered React 19 single-page application for deco Studio.

| Attribute | Value |
| --- | --- |
| Workspace | `@decocms/studio-web` (`apps/web`) |
| Kind | React single-page application |
| Runtime | Browser; Vite runs on Node.js |
| Distribution | Private static bundle; GHCR `studio-nginx` image |

## Overview

Studio Web is the browser interface for the Studio control plane. It renders
organization-scoped chats, agents, connections, files, reports, monitoring,
settings, and deployment administration while consuming the API over same-origin
HTTP, MCP, and streaming routes.

The workspace builds independently to `apps/web/dist`. The combined Studio build
copies that directory into `apps/api/dist/client`; the release pipeline also
packages the same assets in the `studio-nginx` image.

## Responsibilities

- Define public, authenticated, organization-scoped, and instance-admin routes.
- Render the Studio shell, chats, projects, agents, connections, tools,
  monitoring, files, reports, onboarding, and settings.
- Manage browser authentication, organization selection, query state, and
  streaming interactions.
- Provide the app-local browser SDK under `src/sdk`.
- Render MCP app resources and embedded application views.
- Own web localization, preferences, themes, design-system composition, and
  static assets.
- Proxy development traffic to the API without changing production request
  paths.
- Produce the static production bundle consumed by the combined distribution
  and nginx image.

## Usage

Install dependencies and start the complete Studio development environment from
the repository root:

```bash
bun install
bun run dev
```

To run only Vite, start the API separately and then run:

```bash
bun run --cwd=apps/web dev
```

Vite listens on `http://localhost:4000` and proxies server routes to
`http://localhost:3000` by default.

Build only the static client with:

```bash
bun run --cwd=apps/web build
```

Build the released API and web artifact together with:

```bash
bun run build:studio
```

## Architecture

`src/index.tsx` creates the TanStack Router tree and mounts the top-level
providers. Route components load lazily, TanStack Query manages remote state,
and shared UI primitives come from `@deco/ui`.

```text
TanStack Router
      |
      v
providers and layouts
      |
      +----> views and feature components
      |
      +----> browser SDK and API clients
                         |
                         v
                 Vite same-origin proxy
                         |
                         v
                     Studio API
```

Key paths:

| Path | Purpose |
| --- | --- |
| `src/index.tsx` | Application entry point and route tree |
| `src/routes/` | Route components and route-specific logic |
| `src/layouts/` | Authenticated shell and shared page layouts |
| `src/views/` | Domain-oriented application views |
| `src/components/` | Reusable Studio components |
| `src/providers/` | Authentication, theme, analytics, and root providers |
| `src/hooks/` and `src/lib/` | Browser hooks, API clients, and utilities |
| `src/sdk/` | App-local browser-facing Studio client APIs |
| `src/i18n/` | English and Brazilian Portuguese dictionaries and `useT()` |
| `public/` | Static assets copied unchanged to the build |
| `test/` and `playwright-ct.config.ts` | Test setup and component-test configuration |
| `vite.config.ts` | Build, React Compiler, Tailwind, aliases, and development proxy |

The build injects the version from `apps/api/package.json` as
`__STUDIO_VERSION__`, keeping API and web release metadata aligned.

## Development

Run focused checks from the repository root:

```bash
bun run --cwd=apps/web check
bun run --cwd=apps/web test
bun run --cwd=apps/web test:ct
bun run --cwd=apps/web build
```

Use `test:ct:ui` for Playwright's interactive component-test runner:

```bash
bun run --cwd=apps/web test:ct:ui
```

Unit tests cover pure browser logic. Component tests run through Playwright.
Cross-process user flows belong in `packages/e2e`. Run `bun run fmt` from the
repository root after code changes.

Vite development must run on Node.js through the manifest's `vite dev` command.
Do not change it to `bun --bun vite dev`: the proxy depends on Node's
`ServerResponse` close event to cancel aborted streaming and long-poll requests.

## Boundaries

- `apps/web` owns browser behavior and user-facing copy. It does not own Hono
  routes, database access, migrations, secrets, or server infrastructure.
- Never import from `apps/api/src`. Communicate through HTTP/MCP routes and put
  isomorphic contracts in explicit `@decocms/shared/*` exports.
- Keep React hooks, contexts, and other browser runtime code in `apps/web`,
  including `src/sdk`; do not move them into the shared package.
- Consume design-system primitives from `@deco/ui` and use design tokens rather
  than raw palette values.
- Route every user-facing string through `useT()`. Add matching English and
  Brazilian Portuguese dictionary entries.
- Keep backend identifiers and wire contracts named `thread`; render the concept
  as a chat in user-facing copy.
- React Compiler handles memoization. Do not add `useMemo`, `useCallback`, or
  `memo`, and use the repository-approved alternatives to `useEffect`.

## Development proxy

`vite.config.ts` proxies `/api`, `/mcp`, `/oauth-proxy`, `/.well-known`, `/org`,
`/health`, and `/metrics` to the API.

| Setting | Purpose | Default |
| --- | --- | --- |
| `VITE_PORT` | Vite listener and HMR client port | `4000` |
| `PORT` | API port used to construct the proxy target | `3000` |
| `HOST=0.0.0.0` | Bind Vite on all interfaces for sandbox previews | Disabled |

The client deliberately uses relative server URLs. Do not add a separate
browser API origin when the same-origin proxy or production front door can route
the request.

## Related documentation

- [Studio API](../api/README.md)
- [Studio documentation site](../docs/README.md)
- [Repository guidelines](../../AGENTS.md)
- [Testing strategy](../../TESTING.md)
- [Project overview](../../README.md)
