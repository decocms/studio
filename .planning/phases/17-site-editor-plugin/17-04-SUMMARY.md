---
phase: 17-site-editor-plugin
plan: 04
subsystem: ui
tags: [react, plugin, routing, tanstack-router, tanstack-query, pages-list, modal]

# Dependency graph
requires:
  - phase: 17-site-editor-plugin
    plan: 02
    provides: page-api.ts (listPages/createPage/updatePage/deletePage), query-keys.ts
  - phase: 17-site-editor-plugin
    plan: 03
    provides: useUndoRedo, useIframeBridge hooks
provides:
  - packages/mesh-plugin-site-editor/client/lib/router.ts (siteEditorRouter with / and /pages/$pageId)
  - packages/mesh-plugin-site-editor/client/components/pages-list.tsx (page list with CRUD actions)
  - packages/mesh-plugin-site-editor/client/components/page-modal.tsx (create/rename modal)
  - packages/mesh-plugin-site-editor/client/components/page-composer.tsx (stub for plan 17-05)
  - packages/mesh-plugin-site-editor/client/index.tsx (updated with siteEditorRouter wiring)
affects: [17-05]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "createPluginRouter pattern from @decocms/bindings/plugins — returns [pagesListRoute, pageComposerRoute]"
    - "usePluginContext<typeof DECO_BLOCKS_BINDING>() for typed toolCaller and connection"
    - "GenericToolCaller cast (toolCaller as unknown as GenericToolCaller) for filesystem tool calls"
    - "TanStack Query useQuery + useMutation for page CRUD with QUERY_KEYS constants"
    - "@deco/ui imports require .tsx extension (bundler moduleResolution)"

key-files:
  created:
    - packages/mesh-plugin-site-editor/client/lib/router.ts
    - packages/mesh-plugin-site-editor/client/components/pages-list.tsx
    - packages/mesh-plugin-site-editor/client/components/page-modal.tsx
    - packages/mesh-plugin-site-editor/client/components/page-composer.tsx
  modified:
    - packages/mesh-plugin-site-editor/client/index.tsx

key-decisions:
  - "@deco/ui imports require .tsx extension — bundler moduleResolution doesn't infer extensions for workspace packages"
  - "usePluginContext uses typeof DECO_BLOCKS_BINDING (runtime value) not DecoBlocksBinding (type alias) as the generic"
  - "page-composer.tsx stub created now so router.ts lazy import resolves without TS error in plan 17-04"
  - "Delete confirmation uses window.confirm — acceptable for phase 17 per plan spec"

# Metrics
duration: 3min
completed: 2026-02-21
---

# Phase 17 Plan 04: Pages List UI and Routing Layer Summary

**Plugin router with pages list route and page composer route, plus full CRUD UI using TanStack Query, modal dialogs, and dropdown menus**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-02-21T19:18:29Z
- **Completed:** 2026-02-21T19:20:52Z
- **Tasks:** 2
- **Files modified:** 5

## Accomplishments

- Created `client/lib/router.ts` with `siteEditorRouter` (two routes: `/` pages list and `/pages/$pageId` composer)
- Created stub `client/components/page-composer.tsx` so the lazy import compiles without TypeScript errors (full implementation in plan 17-05)
- Updated `client/index.tsx` setup() to wire `siteEditorRouter.createRoutes(context)` and `registerPluginRoutes(routes)` (replacing the `registerPluginRoutes([])` placeholder)
- Created `client/components/page-modal.tsx` — reusable Dialog for create (title + path) and rename (title only) operations
- Created `client/components/pages-list.tsx` — full page list UI with:
  - TanStack Query `useQuery` for listing pages via `listPages(genericCaller)`
  - Create/rename via `PageModal` with `useMutation`
  - Delete via `window.confirm` + `deleteMutation`
  - DropdownMenu per row with Rename and Delete items
  - Empty state with "Create your first page" CTA
  - Click-to-navigate to `/$org/$project/$pluginId/pages/$pageId` route
  - QUERY_KEYS constants used throughout (no inline query key strings)
  - No useEffect, useMemo, or useCallback (ban-compliant)

## Task Commits

Each task was committed atomically:

1. **Task 1: Plugin router and client/index.tsx wiring** - `f57d5ea49` (feat)
2. **Task 2: pages-list.tsx and page-modal.tsx** - `855c1cb2f` (feat)

## Files Created/Modified

- `packages/mesh-plugin-site-editor/client/lib/router.ts` - siteEditorRouter with / and /pages/$pageId routes
- `packages/mesh-plugin-site-editor/client/components/page-composer.tsx` - stub for plan 17-05
- `packages/mesh-plugin-site-editor/client/index.tsx` - setup() now calls siteEditorRouter.createRoutes(context)
- `packages/mesh-plugin-site-editor/client/components/page-modal.tsx` - Dialog-based create/rename modal
- `packages/mesh-plugin-site-editor/client/components/pages-list.tsx` - full page list component

## Decisions Made

- **@deco/ui .tsx extension required**: `bundler` moduleResolution doesn't auto-resolve extensions for workspace packages — discovered during TypeScript check, fixed by appending `.tsx` to all `@deco/ui/components/*` imports (matches pattern established in mesh-plugin-object-storage)
- **typeof DECO_BLOCKS_BINDING not DecoBlocksBinding**: `usePluginContext<typeof DECO_BLOCKS_BINDING>()` uses the runtime constant as type param, not the `DecoBlocksBinding` type alias which is only a type
- **Stub page-composer.tsx in plan 17-04**: Even though lazy imports are not evaluated at runtime, TypeScript still resolves the import path for `lazyRouteComponent(...)` — creating the stub now avoids TS2307 errors from router.ts

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed @deco/ui import paths missing .tsx extension**
- **Found during:** Task 2 TypeScript check
- **Issue:** `Cannot find module '@deco/ui/components/dialog'` — bundler moduleResolution requires explicit .tsx extension for workspace packages
- **Fix:** Added `.tsx` extension to all `@deco/ui/components/*` imports (dialog.tsx, button.tsx, input.tsx, label.tsx, dropdown-menu.tsx)
- **Files modified:** page-modal.tsx, pages-list.tsx
- **Pattern match:** Same pattern used in packages/mesh-plugin-object-storage

**2. [Rule 1 - Bug] Fixed usePluginContext generic from type to value**
- **Found during:** Task 2 TypeScript check
- **Issue:** `'DecoBlocksBinding' only refers to a type, but is being used as a value here` — imported DecoBlocksBinding (type alias) instead of the DECO_BLOCKS_BINDING binding object
- **Fix:** Changed `usePluginContext<DecoBlocksBinding>()` to `usePluginContext<typeof DECO_BLOCKS_BINDING>()` and imported `DECO_BLOCKS_BINDING` from `@decocms/bindings`

**3. [Rule 1 - Bug] Added explicit event handler types for strict mode**
- **Found during:** Task 2 TypeScript check
- **Issue:** `Parameter 'v' implicitly has an 'any' type` and `Parameter 'e' implicitly has an 'any' type` in page-modal.tsx
- **Fix:** Added explicit `React.FormEvent<HTMLFormElement>`, `React.ChangeEvent<HTMLInputElement>`, and `boolean` types to event handler parameters

## Issues Encountered

None beyond the auto-fixed issues above.

## User Setup Required

None.

## Next Phase Readiness

- Router registered and both routes compile — plan 17-05 can import `siteEditorRouter` and implement the full composer replacing the stub
- pages-list.tsx uses QUERY_KEYS, listPages, createPage, updatePage, deletePage from plan 17-02 data access layer — integration complete
- No blockers for plan 17-05 (page composer with sections, props, and preview)

## Self-Check: PASSED

- FOUND: packages/mesh-plugin-site-editor/client/lib/router.ts
- FOUND: packages/mesh-plugin-site-editor/client/components/pages-list.tsx
- FOUND: packages/mesh-plugin-site-editor/client/components/page-modal.tsx
- FOUND: packages/mesh-plugin-site-editor/client/components/page-composer.tsx
- FOUND commit: f57d5ea49 (Task 1)
- FOUND commit: 855c1cb2f (Task 2)

---
*Phase: 17-site-editor-plugin*
*Completed: 2026-02-21*
