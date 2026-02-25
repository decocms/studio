---
phase: 18-deco-link-command
plan: 02
subsystem: cli
tags: [cli, mcp, chalk, commander, deco-link, local-dev, site-editor]

# Dependency graph
requires:
  - phase: 18-01
    provides: mesh-url.ts, mesh-auth.ts, mesh-client.ts, local-dev-manager.ts
affects: []
provides:
  - packages/cli/src/commands/mesh/link.ts: deco link command orchestration
  - packages/cli/src/commands.ts: Updated CLI with folder-aware link command

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Folder argument branching: [folder] present -> Mesh mode, absent -> tunnel mode"
    - "LinkStateSchema Zod v4 schema with safeParse for idempotency reads"
    - "SIGINT/SIGTERM cleanup handler with shuttingDown guard to prevent double-exit"
    - "isDecoSite() checks existsSync(.deco) before spawning to detect Deco site for site-editor auto-enable"

key-files:
  created:
    - packages/cli/src/commands/mesh/link.ts
  modified:
    - packages/cli/src/commands.ts

key-decisions:
  - "Browser opens to plain project URL — no auto-login token per CONTEXT.md locked decision"
  - "callMeshTool result cast to concrete types (connResult.item.id, projResult.project.id) to satisfy TypeScript strict mode"
  - "isDecoSite() checks .deco dir existence BEFORE writeLinkState creates .deco/link.json — detection is pre-create so no false positive on new Deco sites"
  - "slugify imported from ../../lib/slugify.js — no local copy per plan instruction"
  - "chalk imported in commands.ts for consistent error formatting in folder-mode error handler"

# Metrics
duration: 3min
completed: 2026-02-22
---

# Phase 18 Plan 02: deco link Command Summary

**`deco link ./my-folder` command that orchestrates Mesh URL resolution, Better Auth, local-dev daemon, Connection + Project creation, site-editor auto-enable, idempotency via `.deco/link.json`, browser open, and clean Ctrl+C teardown**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-22T01:35:55Z
- **Completed:** 2026-02-22T01:38:47Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Created `packages/cli/src/commands/mesh/link.ts` with full `meshLinkCommand` implementation
- Vercel-style CLI output: `step()` (green checkmark), `fail()` (red X), `info()` (cyan arrow) chalk helpers
- Full orchestration: Mesh URL resolution → Better Auth → local-dev startup → Connection creation → Project creation → site-editor binding → browser open → stay-alive loop
- Idempotency: reads `.deco/link.json` via LinkStateSchema.safeParse; reuses existing connectionId/projectId/projectSlug if valid
- Site-editor auto-enable: `isDecoSite()` detects `.deco/` folder before writeLinkState; calls PROJECT_PLUGIN_CONFIG_UPDATE when detected
- Clean shutdown: SIGINT/SIGTERM handlers call `stopLocalDev()` with `shuttingDown` guard; logs teardown steps
- Updated `commands.ts`: added `chalk` import, added `meshLinkCommand` import, added `[folder]` positional arg + `--mesh-url` option to `linkCmd`, branches to mesh mode when folder provided

## Task Commits

Each task was committed atomically:

1. **Task 1: Implement deco link command** - `7af55a6f5` (feat)
2. **Task 2: Register link command in CLI** - `f7cfa329b` (feat)

## Files Created/Modified

- `packages/cli/src/commands/mesh/link.ts` — meshLinkCommand full orchestration (new)
- `packages/cli/src/commands.ts` — Updated linkCmd with [folder] arg, --mesh-url option, meshLinkCommand branch (modified)

## Decisions Made

- Browser opens to plain project URL — no auto-login URL token (per CONTEXT.md locked decision that overrides roadmap "already logged in" wording)
- `isDecoSite()` uses `existsSync(path.join(folder, ".deco"))` — evaluated before `writeLinkState` creates `.deco/link.json` to avoid false positives on new link operations
- `slugify` imported from existing `../../lib/slugify.js` — no local copy created per plan instruction
- TypeScript cast pattern: `callMeshTool` returns `unknown` so results cast to `{ item: { id: string } }` and `{ project: { id: string } }` for type safety
- `chalk` added to `commands.ts` to maintain consistent error output in the new folder-mode error handler

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## Verification Checklist

- [x] Full compilation: `bun run check` passes for all workspaces (deco-cli exits code 0)
- [x] meshLinkCommand imports and calls all four foundation libs from plan 01 (mesh-url, mesh-auth, mesh-client, local-dev-manager)
- [x] Idempotency: readLinkState/writeLinkState use `.deco/link.json` with Zod safeParse
- [x] Site-editor auto-enable: isDecoSite check + PROJECT_PLUGIN_CONFIG_UPDATE call present
- [x] Clean shutdown: SIGINT handler calls stopLocalDev
- [x] Vercel-style output: step/fail/info helpers with chalk, branded banner
- [x] `deco link ./folder` routes to meshLinkCommand, `deco link -p 8787` routes to existing tunnel

---
*Phase: 18-deco-link-command*
*Completed: 2026-02-22*
