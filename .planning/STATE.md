# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-25)

**Core value:** E-commerce teams get an instant storefront diagnostic and guided onboarding into a team of AI agents that optimize their store.
**Current focus:** Milestone v1.4 — Storefront Onboarding (Phase 20 in progress, plan 1/3 done)

## Current Position

Phase: 20 of 22 in v1.4 (Public Report UI) — In Progress
Plan: 1 of 3 done (plan 02 next)
Status: In Progress
Last activity: 2026-02-25 — completed 20-01 (/onboarding page with URL input, agent checklist, route registration)

Progress: [████░░░░░░] 15% (v1.4, 4/? plans done)

## Performance Metrics

**Velocity:**
- Total plans completed: 4
- Average duration: 5 min
- Total execution time: 20 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| Phase 19 P01 | 1 | 6 min | 6 min |
| Phase 19 P02 | 1 | 7 min | 7 min |
| Phase 19 P03 | 1 | 2 min | 2 min |
| Phase 20 P01 | 1 | 5 min | 5 min |

**Recent Trend:** 5 min/plan

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
- [Phase 19]: Built normalized URL string manually instead of URL.toString() to avoid trailing slash on root paths breaking cache key consistency
- [Phase 19]: SSRF validator performs early protocol detection before URL parsing to catch data:/javascript:/ftp: URIs with correct error messages
- [Phase 19]: PSI API embeds CrUX field data in loadingExperience — no separate CrUX API call needed for plan 02 agents
- [Phase 19]: LLM provider packages are optional runtime deps for company context agent — dynamic any-cast imports avoid TypeScript module resolution errors
- [Phase 19]: DIAGNOSTIC_AGENTS registry preserves per-agent typed signatures — seo/tech_stack take CrawlResult, web_performance/company_context take (url, CrawlResult)
- [Phase 19]: agentIdToResultKey maps snake_case agent IDs to camelCase DiagnosticResult keys (web_performance → webPerformance)
- [Phase 19]: createDiagnosticRoutes(db) factory pattern used for pre-auth public routes — avoids needing MeshContext entirely
- [Phase 19]: Session always reaches "completed" even if all agents fail — homepage crawl failure is the only "failed" path
- [Phase 20-public-report-ui]: Use <Navigate> component (not useNavigate hook) for report redirect — avoids banned useEffect pattern
- [Phase 20-public-report-ui]: refetchInterval as callback function stops polling declaratively when session completes/fails

### Pending Todos

None yet.

### Blockers/Concerns

- RESOLVED: Phase 19 SSRF validation blocker — SSRF validator implemented and tested (48 tests pass)
- RESOLVED: Phase 19 @ai-sdk/openai availability — using dynamic any-cast imports for optional runtime deps
- Phase 22: Virtual MCP capability metadata schema unknown — may need new tags/requiredConnections field added before recommendation scoring can be implemented

## Session Continuity

Last session: 2026-02-25
Stopped at: Completed 20-01-PLAN.md — /onboarding page with URL input, agent checklist, and route registration
Resume file: None
