# Project State

## Project Reference

See: .planning/PROJECT.md (updated 2026-02-25)

**Core value:** E-commerce teams get an instant storefront diagnostic and guided onboarding into a team of AI agents that optimize their store.
**Current focus:** Milestone v1.4 — Storefront Onboarding (Phase 22 complete: full onboarding flow done)

## Current Position

Phase: 22 of 22 in v1.4 (Interview + Recommendations) — Complete
Plan: 3 of 3 done
Status: Phase Complete
Last activity: 2026-02-26 — completed quick task 001 (onboarding redesign — hire modal, blog workspace, task proposals)

Progress: [██████████] 100% (v1.4, 10/10 plans done)

## Performance Metrics

**Velocity:**
- Total plans completed: 7
- Average duration: 5 min
- Total execution time: 30 min

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
| Phase 22 P01 | 1 | 7 min | 7 min |
| Phase 22 P02 | 1 | 3 min | 3 min |

**Recent Trend:** 2 min/plan

*Updated after each plan completion*
| Phase 22 P03 | 1 | 2 min | 2 min |

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
- [Phase 22-interview 22-01]: Interview chat uses DefaultChatTransport directly (not ChatProvider) — avoids Virtual MCP selection, thread management, and model selection UI complexity
- [Phase 22-interview 22-01]: INTERVIEW_COMPLETE marker + JSON payload in assistant response for reliable structured data extraction without function calling
- [Phase 22-interview 22-01]: interviewResults stored in diagnostic session via updateResults() with 'interviewResults' key — extends DiagnosticResult without DB migration
- [Phase 22-interview 22-01]: ChatOnFinishCallback receives { message, messages, ... } object not just message — destructure { message } from callback parameter
- [Phase 22-recommendations 22-02]: Virtual MCPs stored as connections with connection_type=VIRTUAL — no separate virtual_mcp table, query connections table with type filter
- [Phase 22-recommendations 22-02]: Decopilot filtered in recommendations by id.startsWith('decopilot_') — avoids importing mesh-sdk constants into onboarding factory module
- [Phase 22-recommendations 22-02]: JsonObject<T> Kysely column has SELECT type T (Record, not string) — dual-parse guard (typeof check) required before JSON.parse on metadata column
- [Phase 22]: Navigate to connections via window.location.href (not router) — interview page outside shell layout requires full page reload for cross-layout navigation
- [Phase 22]: Connect action uses ?add=true without type pre-population — connection type not available in AgentRecommendation metadata

### Pending Todos

None yet.

### Blockers/Concerns

- RESOLVED: Phase 19 SSRF validation blocker — SSRF validator implemented and tested (48 tests pass)
- RESOLVED: Phase 19 @ai-sdk/openai availability — using dynamic any-cast imports for optional runtime deps
- RESOLVED: Phase 22 Virtual MCP capability metadata — requiredConnections built from child connections of each Virtual MCP, no new schema fields needed

### Quick Tasks Completed

| # | Description | Date | Commit | Directory |
|---|-------------|------|--------|-----------|
| 001 | Onboarding redesign — hire modal, blog workspace, task proposals | 2026-02-26 | 7f4ffa8b2 | [001-onboarding-redesign](./quick/001-onboarding-redesign/) |

## Session Continuity

Last session: 2026-02-26
Stopped at: Quick task 001 — onboarding redesign with Blog Post Generator hire flow, blog workspace, task proposal cards
Resume file: None
