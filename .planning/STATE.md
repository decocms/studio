# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-20)

**Core value:** Developers can connect any MCP server to Mesh and get auth, routing, observability, and a visual site editor for Deco sites.
**Current focus:** Milestone v1.3 — Phase 17: site-editor-plugin (executing)

## Current Position

Phase: 17 of 18 (site-editor-plugin)
Plan: 6 of 6 complete
Status: Complete
Last activity: 2026-02-21 — Plan 17-06 complete: git UX footer (footer-bar, commit-dialog, revert-dialog), server commit-message route, plugin registered in apps/mesh

Progress: [████░░░░░░] 40%

## Performance Metrics

**Velocity:**
- Total plans completed: 2
- Average duration: 2 min
- Total execution time: 4 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| 16-plugin-deco-blocks | 2 | 4 min | 2 min |

**Recent Trend:** Phase 16 plans 1-2 each executed in 2 min

*Updated after each plan completion*
| Phase 16 P03 | 2 | 2 tasks | 3 files |
| Phase 16-plugin-deco-blocks P04 | 4 | 2 tasks | 4 files |
| Phase 17-site-editor-plugin P01 | 2 | 2 tasks | 7 files |
| Phase 17-site-editor-plugin P02 | 3 | 2 tasks | 4 files |
| Phase 17-site-editor-plugin P03 | 2 | 2 tasks | 3 files |
| Phase 17-site-editor-plugin P04 | 3 | 2 tasks | 5 files |
| Phase 17-site-editor-plugin P05 | 3 | 2 tasks | 8 files |
| Phase 17-site-editor-plugin P06 | 3 | 2 tasks | 8 files |

## Accumulated Context

### Decisions

Decisions are logged in PROJECT.md Key Decisions table.
Recent decisions affecting current work:

- local-dev lives in mesh monorepo as packages/local-dev/ (not in mcps/ companion repo)
- plugin-deco-blocks is separate from site-editor so other tools can consume it too
- site-editor checks connection capabilities at runtime — does not directly depend on local-dev package
- **AMENDED**: Git tools removed from local-dev — bash tool (unrestricted) covers git + dev server + everything
- **AMENDED**: Entry point is `deco link` in packages/cli (deco-cli), not `npx @decocms/mesh`
- **AMENDED**: CLI is portable/separate from Mesh — Mesh can be local or remote (tunnel = v1.4)
- **AMENDED**: Projects as virtual MCPs with local proxy deferred to v1.4
- Bash tool is unrestricted, scoped to project folder — like Claude Code's bash
- deco-cli (packages/cli) already exists with login; `deco link` is a new command added to it
- Browser auto-opens on `deco link` (best DX, confirmed)
- z.record(z.string(), z.unknown()) required for Zod v4 — two-arg form, single-arg deprecated
- DECO_BLOCKS_BINDING lives in packages/bindings/ not in the plugin — enables site-editor import without plugin dependency
- [Phase 16-plugin-deco-blocks]: Skills placed at packages/mesh-plugin-deco-blocks/.claude/commands/deco/ satisfying BLK-06 in-package requirement
- [Phase 16-plugin-deco-blocks]: RootlessError (not NoRootTypeError) is the actual error class in ts-json-schema-generator — caught for Props-not-named-Props fallback
- [Phase 16-plugin-deco-blocks]: index.ts re-exports DECO_BLOCKS_BINDING for consumers who don't want to import @decocms/bindings directly
- [Phase 16-plugin-deco-blocks]: extractReturnTypeSchema handles T[] return types by stripping suffix, generating element schema, wrapping in array schema
- [Phase 17-site-editor-plugin]: Plugin uses ClientPlugin<typeof DECO_BLOCKS_BINDING> for binding-filtered activation — tab hides automatically for projects without the binding
- [Phase 17-site-editor-plugin]: server/index.ts stub with empty routes() — extended in plan 17-06 with commit-message route
- [Phase 17-site-editor-plugin]: registerPluginRoutes([]) in plan 01 setup — routes wired in plan 17-04 when TanStack Router setup exists
- [Phase 17-site-editor-plugin]: GenericToolCaller separate from TypedToolCaller — filesystem/bash tools not in DECO_BLOCKS_BINDING
- [Phase 17-site-editor-plugin]: listPages handles both { entries: [...] } and bare array response shapes defensively
- [Phase 17-site-editor-plugin]: hasBashTool gates git UI at runtime by checking connection.tools array for bash
- [Phase 17-site-editor-plugin]: Page/BlockInstance types defined inline in use-iframe-bridge.ts pending plan 17-02 page-api.ts completion
- [Phase 17-site-editor-plugin]: undoRedoReducer exported as named export to enable direct (non-renderHook) testing
- [Phase 17-site-editor-plugin]: @deco/ui imports require .tsx extension — bundler moduleResolution doesn't auto-resolve for workspace packages
- [Phase 17-site-editor-plugin]: usePluginContext uses typeof DECO_BLOCKS_BINDING (runtime value) as generic, not DecoBlocksBinding type alias
- [Phase 17-site-editor-plugin]: page-composer.tsx stub created in plan 17-04 to satisfy TS lazy import resolution in router.ts
- [Phase 17-site-editor-plugin]: Module-level keyboard store (_undoFn/_redoFn + kbStore singleton) with useSyncExternalStore — avoids useEffect ban for Cmd+Z/Cmd+Shift+Z keyboard shortcuts
- [Phase 17-site-editor-plugin]: typedCaller cast pattern — toolCaller cast to TypedToolCaller<DecoBlocksBinding> for block/loader tools and GenericToolCaller for filesystem tools
- [Phase 17-site-editor-plugin]: resetTrackerRef inline ref pattern — { current: '' } created in render body to detect pageId changes and call useUndoRedo.reset() without useEffect
- [Phase 17-site-editor-plugin]: FooterBar returns null when hasBashTool() is false — entire git UX absent for non-bash connections
- [Phase 17-site-editor-plugin]: Server /commit-message returns { message: "" } (not error) when ANTHROPIC_API_KEY is absent — graceful degradation to manual entry

### Pending Todos

None yet.

### Blockers/Concerns

- packages/mcp-local-object-storage/ must be deleted when Phase 15 lands (redundant)
- Phase 17 is a clean re-implementation from gui/site-builder — the branch has reference material but Phase 17 must be independently mergeable from main
- Phase 18 depends on both Phase 15 (local-dev) and Phase 17 (site-editor) being merged first

## Session Continuity

Last session: 2026-02-21
Stopped at: Completed 17-06-PLAN.md — git UX footer (footer-bar, commit-dialog, revert-dialog), server commit-message route, plugin registered in apps/mesh
Resume file: None
