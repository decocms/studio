# MCP Mesh

## What This Is

MCP Mesh is an open-source control plane for Model Context Protocol (MCP) traffic. It provides a unified layer for authentication, routing, and observability between MCP clients (Cursor, Claude, VS Code) and MCP servers. The system is a monorepo using Bun workspaces with TypeScript, Hono (API), and React 19 (UI), with a plugin system where each plugin exposes sidebar navigation, server tools, and client UI.

## Core Value

Developers can connect any MCP server to Mesh and immediately get auth, routing, observability, and a polished admin UI — including a full visual site editor for Deco-compatible sites.

## Current Milestone: v1.3 — Local-First Development

**Goal:** Ship the site editor and local development experience as clean, reviewable PRs from a well-structured set of new packages.

**Target features:**
- `packages/local-dev/` — MCP daemon for local development (fs + object storage + git + dev server management)
- `packages/mesh-plugin-deco-blocks/` — Standalone blocks framework plugin (scanner, binding, Claude skill)
- `packages/mesh-plugin-site-editor/` — Full site editor UI with git UX, depends on deco-blocks
- Zero-config local setup: `npx mesh ./my-folder` → browser opens, project ready

## Requirements

### Validated

- ✓ Plugin system with `enabledPlugins` per project — v1.0
- ✓ Projects as first-class entities with their own sidebar and routes — v1.0
- ✓ Connections (MCP servers) scoped to organizations — v1.0
- ✓ Better Auth (OAuth 2.1, API keys, SSO) — v1.0
- ✓ Kysely ORM with SQLite/PostgreSQL support — v1.0
- ✓ OpenTelemetry tracing and metrics — v1.0
- ✓ Event bus (CloudEvents v1.0, pub/sub) — v1.0

### Active

- [ ] local-dev MCP daemon with filesystem, object storage, git, and dev server tools
- [ ] Deco blocks framework as a standalone plugin package (scanner, binding definition, Claude skill)
- [ ] Site editor plugin: pages CRUD, block/loader discovery, visual composer, preview bridge
- [ ] Site editor git UX: pending changes, commit dialog, history panel, revert
- [ ] Zero-config local setup: single command, auto-login, browser opens to project

### Out of Scope

- Remote hosting / Kubernetes daemon — local-first only for this milestone
- GitHub integration for projects — deferred to v1.4
- Tunnel / deco link for remote Mesh — deferred to v1.4
- Multi-user local setup — single developer workflow only

## Context

- The site editor work already exists on branch `gui/site-builder` (phases 1–14 of v1.1/v1.2 milestones) — this milestone re-delivers it as clean, mergeable PRs
- `mcps/local-fs` in the companion `mcps` repo is the source for `local-dev` — to be moved into this monorepo
- `admin-cx` repo has a reference daemon implementation with well-thought-out patterns: readiness polling, SSE file watch, SIGTERM forwarding, patch-based file updates
- Projects already have `enabledPlugins` — plugins activate automatically when enabled on a project
- The plugin router supports sidebar groups with sub-paths

## Constraints

- **Tech stack**: Bun + TypeScript + Hono + React 19 — no new runtimes
- **Formatting**: Biome, always run `bun run fmt` — enforced by pre-commit hook
- **React**: No `useEffect`, no `useMemo`/`useCallback`/`memo` — React 19 compiler handles it
- **Packages**: kebab-case filenames in shared packages
- **Scope**: Each phase = one PR, must be independently reviewable and mergeable

## Key Decisions

| Decision | Rationale | Outcome |
|----------|-----------|------------|
| local-dev in mesh repo (not mcps/) | Core to mesh DX, should ship with mesh | — Pending |
| plugin-deco-blocks separate from site-editor | site-editor depends on it; other tools can too | — Pending |
| Git UX activates based on connection capabilities | site-editor doesn't depend on local-dev directly | — Pending |
| Dev server management in local-dev v1 | User confirmed: spawn + stream logs from day one | — Pending |
| Zero-config auto-opens browser | Best DX: run one command, see result | — Pending |

---
*Last updated: 2026-02-20 — Milestone v1.3 started*
