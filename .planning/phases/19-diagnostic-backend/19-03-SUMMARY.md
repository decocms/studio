---
phase: 19-diagnostic-backend
plan: "03"
subsystem: api
tags: [hono, orchestrator, parallel-agents, rate-limiting, ssrf, public-routes, diagnostic]

# Dependency graph
requires:
  - phase: 19-diagnostic-backend
    provides: diagnostic session schema, SSRF validator, DiagnosticSessionStorage (from plan 01)
  - phase: 19-diagnostic-backend
    provides: all 4 diagnostic agents + DIAGNOSTIC_AGENTS registry (from plan 02)
provides:
  - "runDiagnostic() orchestrator: SSRF validation, 24h cache check, session creation, fire-and-forget parallel execution"
  - "checkRateLimit() in-memory per-IP rate limiter (10s window, 10k max entries)"
  - "Public Hono routes: POST /api/diagnostic/scan and GET /api/diagnostic/session/:token"
  - "shouldSkipMeshContext updated to exclude /api/diagnostic/* from MeshContext injection"
  - "Diagnostic routes mounted in app.ts before MeshContext middleware"
affects:
  - "20-diagnostic-ui: UI calls POST /scan, polls GET /session/:token for progressive updates"
  - "21: associateOrg called post-login to link session token to organization"

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Fire-and-forget orchestration pattern: return token before agents start (Promise.resolve().then())"
    - "Progressive status updates: pending → running → completed/failed per-agent via updateAgentStatus"
    - "Partial failure policy: session always reaches 'completed' even if all agents fail"
    - "Public route factory pattern: createDiagnosticRoutes(db) injects database without MeshContext"

key-files:
  created:
    - apps/mesh/src/diagnostic/orchestrator.ts
    - apps/mesh/src/api/routes/diagnostic.ts
  modified:
    - apps/mesh/src/api/utils/paths.ts
    - apps/mesh/src/api/app.ts

key-decisions:
  - "agentIdToResultKey maps snake_case agent IDs to camelCase DiagnosticResult keys (web_performance → webPerformance)"
  - "Homepage crawl failure marks all agents failed immediately and exits — no point running agents without HTML"
  - "Route factory pattern (createDiagnosticRoutes(db)) over Hono context variables — cleaner DI for pre-auth code"
  - "SSRF validation errors classified by message content to distinguish 400 vs 500 responses"

patterns-established:
  - "Per-agent timeout protection via Promise.race with a delayed rejection — preserves partial results"
  - "In-memory rate limiter with periodic eviction at 10k entries — no external dependency needed"

requirements-completed:
  - DIAG-01
  - DIAG-12

# Metrics
duration: 2min
completed: "2026-02-25"
---

# Phase 19 Plan 03: Diagnostic Orchestrator and Public API Routes Summary

**Parallel orchestrator with fire-and-forget agent execution, per-agent timeout/status tracking, and public Hono routes at POST /api/diagnostic/scan + GET /api/diagnostic/session/:token**

## Performance

- **Duration:** ~2 min
- **Started:** 2026-02-25T11:01:08Z
- **Completed:** 2026-02-25T11:03:00Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- `runDiagnostic()` validates URL (SSRF), checks 24h cache, creates session, returns token immediately before any agent starts
- All 4 agents run in parallel via `Promise.allSettled` with individual timeouts (90s/60s/30s/30s) and status tracking
- `checkRateLimit()` provides in-memory per-IP abuse prevention (10s window, evicts at 10k entries)
- Public routes created as a factory function `createDiagnosticRoutes(db)` — no MeshContext needed
- `shouldSkipMeshContext` updated to skip `/api/diagnostic/*` paths; routes mounted before MeshContext middleware in app.ts
- Session always reaches "completed" status (partial results policy) — crawl failure is the only "failed" path

## Task Commits

Each task was committed atomically:

1. **Task 1: Create diagnostic orchestrator with parallel agent execution** - `e67c07562` (feat)
2. **Task 2: Create public API routes and wire into Hono app** - `5b90dcdc0` (feat)

## Files Created/Modified

- `apps/mesh/src/diagnostic/orchestrator.ts` - runDiagnostic(), checkRateLimit(), executeAgents() fire-and-forget, runAgentWithTracking()
- `apps/mesh/src/api/routes/diagnostic.ts` - POST /scan and GET /session/:token via createDiagnosticRoutes(db) factory
- `apps/mesh/src/api/utils/paths.ts` - Added API_DIAGNOSTIC to PATH_PREFIXES; shouldSkipMeshContext returns true for /api/diagnostic/*
- `apps/mesh/src/api/app.ts` - Import and mount createDiagnosticRoutes before MeshContext middleware

## Decisions Made

- `agentIdToResultKey()` function maps snake_case agent IDs (`web_performance`) to camelCase DiagnosticResult keys (`webPerformance`) — the type system uses camelCase but agent IDs use snake_case
- Homepage crawl failure marks all agents as failed with a descriptive error message then returns early — no agents can run without crawl data
- Used a factory function `createDiagnosticRoutes(db)` rather than reading from Hono context variables — cleaner dependency injection for pre-auth code that has no MeshContext
- SSRF/URL validation errors distinguished from unexpected 500 errors by checking known error message substrings, so user-friendly messages reach the caller

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None — orchestrator and routes have no external service dependencies. LLM provider env vars documented in plan 02 still apply for company context agent.

## Next Phase Readiness

- Phase 19 complete — full diagnostic backend is operational
- POST /api/diagnostic/scan: SSRF-guarded, cached, rate-limited, returns token immediately
- GET /api/diagnostic/session/:token: returns progressive agent status + partial results
- Phase 20 (Diagnostic UI) can begin immediately — all API contracts are stable
- Phase 21 can call `storage.associateOrg(token, orgId)` post-login to claim pre-auth sessions

## Self-Check: PASSED

All artifacts verified:
- apps/mesh/src/diagnostic/orchestrator.ts - FOUND
- apps/mesh/src/api/routes/diagnostic.ts - FOUND
- apps/mesh/src/api/utils/paths.ts (modified) - FOUND
- apps/mesh/src/api/app.ts (modified) - FOUND
- Commit e67c07562 (Task 1) - FOUND
- Commit 5b90dcdc0 (Task 2) - FOUND

---
*Phase: 19-diagnostic-backend*
*Completed: 2026-02-25*
