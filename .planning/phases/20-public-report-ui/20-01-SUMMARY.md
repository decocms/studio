---
phase: 20-public-report-ui
plan: "01"
subsystem: ui
tags: [react, tanstack-router, react-query, tailwind, diagnostic, onboarding]

# Dependency graph
requires:
  - phase: 19-diagnostic-backend
    provides: POST /api/diagnostic/scan and GET /api/diagnostic/session/:token API routes
provides:
  - Public /onboarding route with URL input form and agent loading checklist
  - Public /report/$token route stub registered in TanStack Router
  - KEYS.diagnosticSession(token) query key for polling
affects: [20-public-report-ui, 21-post-login-onboarding]

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "useQuery refetchInterval as function — stops polling when session status is completed/failed"
    - "<Navigate> component for declarative redirect during render (avoids useEffect)"
    - "cn() from @deco/ui/lib/utils.ts for conditional classNames (lint compliant)"

key-files:
  created:
    - apps/mesh/src/web/routes/onboarding.tsx
  modified:
    - apps/mesh/src/web/index.tsx
    - apps/mesh/src/web/lib/query-keys.ts

key-decisions:
  - "Use <Navigate> component (not useNavigate hook) for report redirect — safe to call during render without useEffect"
  - "refetchInterval as callback function stops polling declaratively when session completes/fails"
  - "AgentChecklist uses Navigate rather than useNavigate + inline call — avoids banned useEffect pattern"

patterns-established:
  - "Polling pattern: useQuery refetchInterval as (query) => query.state.data?.status === 'completed' ? false : 1500"
  - "Public route registration: add to rootRoute.addChildren alongside loginRoute/connectRoute, NOT inside shellLayout"

requirements-completed:
  - RPT-02
  - RPT-06

# Metrics
duration: 5min
completed: 2026-02-25
---

# Phase 20 Plan 01: Public Onboarding UI Summary

**Public /onboarding page with URL input form, TanStack-polled agent checklist, and automatic redirect to /report/$token on session completion**

## Performance

- **Duration:** ~5 min
- **Started:** 2026-02-25T11:50:31Z
- **Completed:** 2026-02-25T11:54:53Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments

- Registered two new public routes in TanStack Router: `/onboarding` (lazy loads onboarding.tsx) and `/report/$token` (lazy loads report.tsx, created in Plan 02)
- Created onboarding page with URL input form that POSTs to `/api/diagnostic/scan` and transitions to loading state on success
- Built agent checklist with per-agent status icons (spinner, checkmark, X) polled from `/api/diagnostic/session/:token` every 1.5 seconds
- Added `KEYS.diagnosticSession(token)` query key constant for consistent cache management

## Task Commits

Each task was committed atomically:

1. **Task 1: Register TanStack Router routes and add query keys** - `d7c0ee12e` (feat)
2. **Task 2: Create onboarding page with URL input and loading state** - `4f78d76b0` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `apps/mesh/src/web/routes/onboarding.tsx` - Public onboarding page with URL input form and agent loading checklist (330 lines)
- `apps/mesh/src/web/index.tsx` - Added onboardingRoute + reportRoute as public routes in routeTree
- `apps/mesh/src/web/lib/query-keys.ts` - Added KEYS.diagnosticSession(token) for session polling

## Decisions Made

- Used `<Navigate>` component instead of `useNavigate()` hook for the redirect to `/report/$token`. This avoids needing `useEffect` (banned by lint plugin) — `<Navigate>` renders a declarative redirect during the render phase when session status is `completed`/`failed`.
- Used `refetchInterval` as a callback function `(query) => ...` instead of a static number, so polling automatically stops when the session reaches a terminal state without needing additional state management.
- Imported `cn()` from `@deco/ui/lib/utils.ts` for conditional classNames after discovering the `require-cn-classname` lint rule requires it for template literal interpolation.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Removed unused `useNavigate` import and hook call**
- **Found during:** Task 2 verification (TypeScript check)
- **Issue:** `useNavigate` was imported and `navigate` was declared but never read — TypeScript error TS6133
- **Fix:** Removed `useNavigate` from imports and the unused `const navigate = useNavigate()` call; kept `<Navigate>` component which handles the redirect declaratively
- **Files modified:** apps/mesh/src/web/routes/onboarding.tsx
- **Verification:** `bun run check` passes with no errors in onboarding.tsx
- **Committed in:** 4f78d76b0 (Task 2 commit)

**2. [Rule 2 - Missing Critical] Added cn() for conditional className**
- **Found during:** Task 2 lint check
- **Issue:** `require-cn-classname` lint rule requires `cn()` for template literal className interpolation — lint error
- **Fix:** Imported `cn` from `@deco/ui/lib/utils.ts` and replaced template literal className with `cn(...)` calls
- **Files modified:** apps/mesh/src/web/routes/onboarding.tsx
- **Verification:** `bun run lint` passes with 0 errors
- **Committed in:** 4f78d76b0 (Task 2 commit)

---

**Total deviations:** 2 auto-fixed (1 unused import cleanup, 1 lint compliance fix)
**Impact on plan:** Both auto-fixes required for correctness. No scope creep.

## Issues Encountered

None - lint and TypeScript checks passed cleanly after fixes.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

- `/onboarding` public route is live and fully functional
- `/report/$token` route registered — needs the report component from Plan 02
- Agent checklist correctly polls and navigates on completion
- TypeScript, lint, and format checks all pass

---
*Phase: 20-public-report-ui*
*Completed: 2026-02-25*
