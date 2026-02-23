# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-20)

**Core value:** Developers can connect any MCP server to Mesh and get auth, routing, observability, and a visual site editor for Deco sites.
**Current focus:** Milestone v1.3 — Phase 15: local-dev daemon (ready to plan)

## Current Position

Phase: 15 of 18 (local-dev daemon)
Plan: — of — (not yet planned)
Status: Ready to plan
Last activity: 2026-02-20 — Roadmap created, v1.3 phases 15–18 defined

Progress: [░░░░░░░░░░] 0%

## Performance Metrics

**Velocity:**
- Total plans completed: 0
- Average duration: —
- Total execution time: —

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| - | - | - | - |

**Recent Trend:** No data yet

*Updated after each plan completion*

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

### Pending Todos

None yet.

### Blockers/Concerns

- packages/mcp-local-object-storage/ must be deleted when Phase 15 lands (redundant)
- Phase 17 is a clean re-implementation from gui/site-builder — the branch has reference material but Phase 17 must be independently mergeable from main
- Phase 18 depends on both Phase 15 (local-dev) and Phase 17 (site-editor) being merged first

## Session Continuity

Last session: 2026-02-20
Stopped at: Roadmap written, all 35 v1.3 requirements mapped to phases 15–18
Resume file: None
