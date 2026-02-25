# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-25)

**Core value:** E-commerce teams get an instant storefront diagnostic and guided onboarding into a team of AI agents that optimize their store.
**Current focus:** Milestone v1.4 — Storefront Onboarding (Phase 21 in progress: auth handoff)

## Current Position

Phase: 21 of 22 in v1.4 (Auth Handoff) — In Progress
Plan: 3 of 3 done
Status: Complete
Last activity: 2026-02-25 — completed 21-03 (post-login onboard-setup page with org resolution and claim flow)

Progress: [█████░░░░░] 21% (v1.4, 7/? plans done)

## Performance Metrics

**Velocity:**
- Total plans completed: 6
- Average duration: 5 min
- Total execution time: 27 min

**By Phase:**

| Phase | Plans | Total | Avg/Plan |
|-------|-------|-------|----------|
| Phase 19 P01 | 1 | 6 min | 6 min |
| Phase 19 P02 | 1 | 7 min | 7 min |
| Phase 19 P03 | 1 | 2 min | 2 min |
| Phase 20 P01 | 1 | 5 min | 5 min |
| Phase 20 P02 | 1 | 4 min | 4 min |
| Phase 20 P03 | 1 | 3 min | 3 min |
| Phase 21 P01 | 1 | 3 min | 3 min |
| Phase 21 P02 | 1 | 1 min | 1 min |
| Phase 21 P03 | 1 | 2 min | 2 min |

**Recent Trend:** 2 min/plan

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
- [Phase 20-public-report-ui]: No refetchInterval on report page — session is already completed when navigated to, single fetch is correct
- [Phase 20-public-report-ui]: CompanyContextSection reads token via useParams rather than prop drilling
- [Phase 20-public-report-ui]: Edit affordance uses plain <a href> not router Link — preserves full ?next= URL construction
- [Phase 20]: All mocked Pro section data is static constants at top of each file — no props needed, sections are self-contained
- [Phase 20]: opacity-70 on mocked data content hints at locked content while ProBadge is the primary upgrade indicator
- [Phase 20]: violet-100 border accent on mocked sections provides subtle visual distinction from real data sections
- [Phase 21-auth-handoff 21-01]: slugify duplicated locally in onboarding.ts — importing from auth/index.ts triggers complex initialization side effects (Better Auth config, plugins)
- [Phase 21-auth-handoff 21-01]: createOnboardingRoutes(db, auth) factory pattern for auth-aware pre-MeshContext routes — user may not have active org yet
- [Phase 21-auth-handoff 21-01]: Project creation on claim is non-fatal — session associated with org even if project slug conflicts
- [Phase 21-auth-handoff]: SignupCTA uses authClient.useSession() and synchronous sessionStorage write during render — no useEffect, fully React 19 compatible
- [Phase 21-auth-handoff]: ?next= param encodes /onboard-setup?token=<token> — post-login redirect lands on setup page with token in URL, sessionStorage serves as OAuth redirect fallback
- [Phase 21-auth-handoff 21-03]: Per-mutation-variable loading state pattern — claimMutation.variables?.action comparison targets specific buttons without shared loading state
- [Phase 21-auth-handoff 21-03]: onboardSetupRoute is a public route outside shellLayout — auth check is internal in the component, consistent with /onboarding and /report/$token

### Pending Todos

None yet.

### Blockers/Concerns

- RESOLVED: Phase 19 SSRF validation blocker — SSRF validator implemented and tested (48 tests pass)
- RESOLVED: Phase 19 @ai-sdk/openai availability — using dynamic any-cast imports for optional runtime deps
- Phase 22: Virtual MCP capability metadata schema unknown — may need new tags/requiredConnections field added before recommendation scoring can be implemented

## Session Continuity

Last session: 2026-02-25
Stopped at: Completed 21-03-PLAN.md — post-login onboard-setup page completing the full auth handoff flow (AUTH-01 through AUTH-04)
Resume file: None
