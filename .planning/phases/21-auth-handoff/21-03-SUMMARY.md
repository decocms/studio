---
phase: 21-auth-handoff
plan: "03"
subsystem: ui
tags: [react, tanstack-router, better-auth, onboarding, organizations, react-query]

# Dependency graph
requires:
  - phase: 21-auth-handoff
    provides: GET /api/onboarding/resolve and POST /api/onboarding/claim endpoints (plan 01)
  - phase: 21-auth-handoff
    provides: SignupCTA with sessionStorage token backup on report page (plan 02)
  - phase: 20-public-report-ui
    provides: Report page structure and routing patterns
provides:
  - /onboard-setup TanStack Router route with optional token search param
  - OnboardSetupPage component — post-login org setup with resolve + claim flow
  - Token recovery from URL params with sessionStorage OAuth fallback
  - CreateOrgCard — AI-suggested org name + create team mutation
  - JoinOrgCard — matching org + join mutation
  - onboardingResolve query key in KEYS
affects:
  - Phase 22 (Virtual MCP recommendations) — users land in org dashboard after setup
  - Full onboarding flow: /onboarding → /report/$token → /login → /onboard-setup → /$org/org-admin

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "Token recovery: URL param (primary) → sessionStorage.getItem (OAuth redirect fallback) — synchronous, no useEffect"
    - "Auth gate: !session.isPending && !session.data → <Navigate to={loginUrl} /> — declarative redirect without useEffect"
    - "Per-action isPending tracking: claimMutation.variables?.action comparison for granular button loading states"
    - "onMutationError stores error in useState, cleared on retry — avoids stale error state across actions"

key-files:
  created:
    - apps/mesh/src/web/routes/onboard-setup.tsx
  modified:
    - apps/mesh/src/web/lib/query-keys.ts
    - apps/mesh/src/web/index.tsx

key-decisions:
  - "Token recovery synchronous in render body (no useEffect) — same pattern established in plan 02 for sessionStorage writes"
  - "Navigate component used for auth redirects (not useNavigate hook) — avoids banned useEffect pattern"
  - "claimError tracked in useState, not inferred from mutation — supports reset on retry and per-action display"
  - "JoinOrgCard per-org isPending uses variables?.orgId comparison — prevents all join buttons showing loading simultaneously"
  - "onboardSetupRoute is a public route (outside shellLayout) — auth check is internal, consistent with /onboarding and /report/$token"

patterns-established:
  - "Pattern: Per-mutation-variable loading state — claimMutation.variables?.action === 'create' to target specific button"
  - "Pattern: Declarative auth guard using authClient.useSession() isPending + data — renders Navigate when not pending and no session"

requirements-completed: [AUTH-01, AUTH-02, AUTH-03, AUTH-04]

# Metrics
duration: 2min
completed: 2026-02-25
---

# Phase 21 Plan 03: Auth Handoff — Onboard Setup Page Summary

**Post-login /onboard-setup page with token recovery, org resolution UI, create/join org cards, and claim mutation that redirects to org dashboard on success**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-25T12:23:50Z
- **Completed:** 2026-02-25T12:26:13Z
- **Tasks:** 2
- **Files modified:** 3

## Accomplishments
- Created `OnboardSetupPage` with token recovery from URL params (primary) and sessionStorage (OAuth fallback)
- Auth guard redirects unauthenticated users to `/login?next=/onboard-setup?token=<token>` using `<Navigate>` (no useEffect)
- Resolve query calls `GET /api/onboarding/resolve?token=<token>` when authenticated + token present
- `CreateOrgCard` shows AI-extracted company name with create team mutation
- `JoinOrgCard` shows matching orgs by email domain with per-org loading state
- Claim mutation POSTs to `/api/onboarding/claim`, cleans sessionStorage, and redirects to `/${organizationSlug}`
- Registered `/onboard-setup` route in TanStack Router with optional `token` search param (public route, outside shellLayout)
- Added `KEYS.onboardingResolve(token)` query key for cache isolation

## Task Commits

Each task was committed atomically:

1. **Task 1: Create onboard-setup page with org resolution and claim flow** - `2f6aa8226` (feat)
2. **Task 2: Register onboard-setup route in TanStack Router** - `b36267209` (feat)

## Files Created/Modified
- `apps/mesh/src/web/routes/onboard-setup.tsx` - Complete post-login setup page: token recovery, auth guard, resolve query, CreateOrgCard, JoinOrgCard, SetupSkeleton, claim mutation with redirect
- `apps/mesh/src/web/lib/query-keys.ts` - Added `onboardingResolve: (token: string)` query key
- `apps/mesh/src/web/index.tsx` - Added `onboardSetupRoute` definition with validateSearch, added to rootRoute.addChildren

## Decisions Made
- Token recovery in synchronous render body (no useEffect) — consistent with sessionStorage write pattern established in plan 02
- Used `<Navigate>` component instead of `useNavigate()` hook for auth redirects — avoids banned useEffect, matches established project pattern
- `claimError` state is cleared on retry (`setClaimError(null)` before mutation) — prevents stale errors showing across different actions
- Per-action loading state uses `claimMutation.variables?.action` comparison — prevents all buttons showing "loading" when any mutation fires
- Route kept as public (outside shellLayout) — auth check is self-contained in the component, same pattern as `/onboarding` and `/report/$token`

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
- First `git add` attempted from the main repo root (`/repos/mesh`) instead of the worktree — fixed by running the commit from the correct worktree directory.

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Complete auth handoff flow: report page CTA → login → /onboard-setup → org dashboard
- All AUTH-01 through AUTH-04 requirements completed across plans 01, 02, and 03
- Phase 22 (Virtual MCP recommendations) can proceed — users now land in their org dashboard post-onboarding

## Self-Check: PASSED

- FOUND: apps/mesh/src/web/routes/onboard-setup.tsx (400 lines, exceeds 150 min_lines)
- FOUND: apps/mesh/src/web/lib/query-keys.ts with onboardingResolve key
- FOUND: apps/mesh/src/web/index.tsx with onboardSetupRoute (definition + route tree)
- FOUND: sessionStorage.getItem in onboard-setup.tsx (fallback token recovery)
- FOUND: /api/onboarding/resolve usage in onboard-setup.tsx
- FOUND: /api/onboarding/claim usage in onboard-setup.tsx
- FOUND: commit 2f6aa8226 (Task 1)
- FOUND: commit b36267209 (Task 2)
- TypeScript check: 0 errors
- Lint: 0 warnings, 0 errors
- Format: no fixes needed

---
*Phase: 21-auth-handoff*
*Completed: 2026-02-25*
