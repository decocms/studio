# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-25)

**Core value:** E-commerce teams get an instant storefront diagnostic and guided onboarding into a team of AI agents that optimize their store.
**Current focus:** Milestone v1.4 — Storefront Onboarding (Phase 19 ready to plan)

## Current Position

Phase: 19 of 22 in v1.4 (Diagnostic Backend)
Plan: —
Status: Ready to plan
Last activity: 2026-02-25 — v1.4 roadmap created, phases 19–22 defined

Progress: [░░░░░░░░░░] 0% (v1.4)

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

- Pre-auth diagnostic before login — show value first (PageSpeed Insights pattern)
- Diagnostic agents as standalone async functions, NOT MCP tools (MeshContext requires auth)
- Public Hono routes registered before MeshContext middleware via `shouldSkipMeshContext()`
- DIAG-07 through DIAG-10 (traffic, SEO rankings, brand, percentile) are mocked sections in the report UI — same phase as the report, not separate backend work
- Pre-auth state preserved via `?next=` URL param + `sessionStorage` fallback through OAuth redirect
- Agent recommendations are rule-based scoring against live Virtual MCP registry — no hardcoded agent IDs

### Pending Todos

None yet.

### Blockers/Concerns

- Phase 19: SSRF validation must be in place before the public diagnose endpoint goes live (BLOCKER)
- Phase 19: Verify `@ai-sdk/openai` transitive availability before implementing company context agent
- Phase 22: Virtual MCP capability metadata schema unknown — may need new tags/requiredConnections field added before recommendation scoring can be implemented

## Session Continuity

Last session: 2026-02-25
Stopped at: Roadmap created — phases 19–22 defined, ready to plan Phase 19
Resume file: None
