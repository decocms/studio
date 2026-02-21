---
phase: 17-site-editor-plugin
plan: 06
subsystem: ui
tags: [react, plugin, git-ux, footer, dialog, tanstack-query, claude-haiku]

# Dependency graph
requires:
  - phase: 17-site-editor-plugin
    plan: 02
    provides: page-api.ts (GenericToolCaller), query-keys.ts
  - phase: 17-site-editor-plugin
    plan: 03
    provides: git-api.ts (hasBashTool, gitStatus, gitLog, gitShow, gitCheckout, gitCommit)
  - phase: 17-site-editor-plugin
    plan: 05
    provides: page-composer.tsx (host for FooterBar), QUERY_KEYS
provides:
  - packages/mesh-plugin-site-editor/client/components/footer-bar.tsx (git UX footer: pending changes, history, commit, revert)
  - packages/mesh-plugin-site-editor/client/components/commit-dialog.tsx (commit message review/edit dialog)
  - packages/mesh-plugin-site-editor/client/components/revert-dialog.tsx (revert confirmation dialog)
  - packages/mesh-plugin-site-editor/server/index.ts (POST /commit-message route calling Claude Haiku)
  - apps/mesh/src/web/plugins.ts (siteEditorPlugin registered)
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "AlertDialog from @deco/ui for destructive confirmation (revert)"
    - "Dialog from @deco/ui for interactive commit message editing"
    - "hasBashTool() gates entire FooterBar render — early return null pattern"
    - "void asyncFn() pattern in onClick handlers to call async without await"
    - "Server-side Claude Haiku call via raw fetch to anthropic API — no SDK dependency"

key-files:
  created:
    - packages/mesh-plugin-site-editor/client/components/footer-bar.tsx
    - packages/mesh-plugin-site-editor/client/components/commit-dialog.tsx
    - packages/mesh-plugin-site-editor/client/components/revert-dialog.tsx
  modified:
    - packages/mesh-plugin-site-editor/server/index.ts
    - packages/mesh-plugin-site-editor/client/components/page-composer.tsx
    - apps/mesh/src/web/plugins.ts
    - apps/mesh/package.json
    - packages/mesh-plugin-site-editor/client/lib/use-undo-redo.ts

key-decisions:
  - "FooterBar uses early-return null pattern on hasBashTool() check — entire git UX absent for non-local-dev connections"
  - "CommitDialog syncs generatedMessage via render-time equality check (message==='' && generated!=='') — avoids useEffect for message sync"
  - "Server commit-message route falls back to empty string when ANTHROPIC_API_KEY missing — graceful degradation"

requirements-completed: [EDT-11, EDT-12, EDT-13, EDT-14, EDT-15]

# Metrics
duration: 3min
completed: 2026-02-21
---

# Phase 17 Plan 06: Git UX Footer and Plugin Registration Summary

**Git UX footer with pending changes badge, commit flow (Claude Haiku message generation), git history with inline diffs, file-level revert, and site-editor plugin registered in apps/mesh**

## Performance

- **Duration:** ~3 min
- **Started:** 2026-02-21T19:29:02Z
- **Completed:** 2026-02-21T19:31:47Z
- **Tasks:** 2
- **Files modified:** 8

## Accomplishments

- Built `footer-bar.tsx` — bottom bar with pending-changes badge (color-coded by M/A/D status), git history list, inline diff preview on commit click, commit button gated on pending changes, revert button per commit; entire component returns null when hasBashTool() is false
- Created `commit-dialog.tsx` — Dialog showing Claude-generated commit message (fetched from server); user can edit before confirming; "Generating message..." placeholder shown while fetching
- Created `revert-dialog.tsx` — AlertDialog confirmation before running `git checkout {hash} -- .deco/pages/{id}.json`; shows commit hash and message in description
- Updated `server/index.ts` with POST /commit-message route — calls Claude Haiku (claude-haiku-4-5-20251001) via raw fetch; falls back gracefully when ANTHROPIC_API_KEY is absent
- Wired `FooterBar` into `page-composer.tsx` as last child in the outer flex-col container, with onPageReverted callback invalidating the page query
- Registered `siteEditorPlugin` in `apps/mesh/src/web/plugins.ts` and added `mesh-plugin-site-editor: workspace:*` to apps/mesh/package.json; bun install links the workspace

## Task Commits

Each task was committed atomically:

1. **Task 1: Footer bar with git UX, commit dialog, revert dialog, updated server/index.ts** — `23e1d91fc` (feat)
2. **Task 2: Wire footer into page-composer and register plugin in apps/mesh** — `6334e3299` (feat)

## Files Created/Modified

- `packages/mesh-plugin-site-editor/client/components/footer-bar.tsx` — Git UX footer: pending changes badge, commit button, history list with inline diffs, revert per commit; gated on hasBashTool()
- `packages/mesh-plugin-site-editor/client/components/commit-dialog.tsx` — Dialog with generated message textarea, edit-before-commit flow, loading state
- `packages/mesh-plugin-site-editor/client/components/revert-dialog.tsx` — AlertDialog confirmation with commit hash + message displayed
- `packages/mesh-plugin-site-editor/server/index.ts` — POST /commit-message route calling Claude Haiku; graceful fallback when no API key
- `packages/mesh-plugin-site-editor/client/components/page-composer.tsx` — FooterBar mounted with all required props
- `apps/mesh/src/web/plugins.ts` — siteEditorPlugin imported and registered
- `apps/mesh/package.json` — mesh-plugin-site-editor: workspace:* added to devDependencies
- `packages/mesh-plugin-site-editor/client/lib/use-undo-redo.ts` — non-null assertions added for length-guarded array accesses (pre-existing TS strict error)

## Decisions Made

- **hasBashTool early return**: FooterBar returns `null` immediately if `hasBashTool(connectionTools)` is false — no DOM rendered at all for non-bash connections, consistent with the gates-at-runtime decision from Phase 17 planning
- **CommitDialog message sync**: Uses render-time equality check (`message === "" && generatedMessage !== ""`) to sync when dialog opens with new content — avoids useEffect ban
- **Server graceful degradation**: /commit-message returns `{ message: "" }` (not an error) when ANTHROPIC_API_KEY is absent — client shows empty textarea for manual entry

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed T|undefined TypeScript errors in use-undo-redo.ts**
- **Found during:** Task 2 (apps/mesh TypeScript check)
- **Issue:** `state.past[state.past.length - 1]` and `state.future[0]` typed as `T | undefined` by strict TS; both are safe (length already checked)
- **Fix:** Added non-null assertions (`!`) to both array accesses
- **Files modified:** `packages/mesh-plugin-site-editor/client/lib/use-undo-redo.ts`
- **Commit:** `6334e3299`

## Issues Encountered

None beyond the pre-existing type issue fixed above.

## User Setup Required

None — the plugin is registered and will activate automatically for connections implementing DECO_BLOCKS_BINDING. Git UX is gated on hasBashTool() at runtime.

## Next Phase Readiness

- Phase 17 (site-editor-plugin) is now complete — all 6 plans executed
- Phase 18 (deco link / local-dev integration) can proceed once Phase 15 lands
- No blockers

## Self-Check: PASSED

- FOUND: packages/mesh-plugin-site-editor/client/components/footer-bar.tsx
- FOUND: packages/mesh-plugin-site-editor/client/components/commit-dialog.tsx
- FOUND: packages/mesh-plugin-site-editor/client/components/revert-dialog.tsx
- FOUND commit: 23e1d91fc (Task 1)
- FOUND commit: 6334e3299 (Task 2)

---
*Phase: 17-site-editor-plugin*
*Completed: 2026-02-21*
