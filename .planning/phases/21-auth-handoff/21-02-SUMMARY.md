---
phase: 21-auth-handoff
plan: "02"
subsystem: ui
tags: [react, better-auth, session-storage, onboarding, report]

# Dependency graph
requires:
  - phase: 20-public-report-ui
    provides: Report page component structure and PercentileSection as last section
  - phase: 21-auth-handoff
    provides: AUTH-01 and AUTH-03 requirements (login prompt on report, token preservation through OAuth)
provides:
  - Login/signup CTA rendered after report sections for unauthenticated users
  - sessionStorage backup of diagnostic token under mesh:onboarding:token key
  - Login URL with ?next=/onboard-setup?token=<token> for post-login redirect
affects:
  - 21-03 (onboard-setup page will read the sessionStorage token as fallback)

# Tech tracking
tech-stack:
  added: []
  patterns:
    - authClient.useSession() for session-reactive conditional rendering without useEffect
    - Synchronous sessionStorage write during render as React 19-compatible side-effect pattern
    - encodeURIComponent on ?next= param value containing nested query params

key-files:
  created: []
  modified:
    - apps/mesh/src/web/routes/report.tsx
    - apps/mesh/src/web/lib/localstorage-keys.ts

key-decisions:
  - "SignupCTA uses authClient.useSession() reactive hook (not useEffect) to conditionally hide CTA when user is logged in — fully React 19 compatible"
  - "sessionStorage write happens synchronously during render (idempotent — same key, same value) — no useEffect needed, avoids banned pattern"
  - "?next= param encodes /onboard-setup?token=<token> so post-login redirect lands on setup page with token in URL"
  - "sessionStorage fallback required because some OAuth providers strip custom query params during multi-step redirect chains"

patterns-established:
  - "Pattern: sessionStorage token backup during render as React 19-safe alternative to useEffect for synchronous browser storage writes"
  - "Pattern: Conditional CTA rendering via authClient.useSession() — show only to unauthenticated users, return null when session.data exists"

requirements-completed: [AUTH-01, AUTH-03]

# Metrics
duration: 1min
completed: 2026-02-25
---

# Phase 21 Plan 02: Auth Handoff Summary

**Login/signup CTA with sessionStorage token fallback on report page — unauthenticated users see branded prompt linking to /login?next=/onboard-setup?token=<token>**

## Performance

- **Duration:** 1 min
- **Started:** 2026-02-25T12:17:42Z
- **Completed:** 2026-02-25T12:18:51Z
- **Tasks:** 1
- **Files modified:** 2

## Accomplishments
- Added `onboardingToken` key to `LOCALSTORAGE_KEYS` for consistent sessionStorage access across the auth redirect cycle
- Created `SignupCTA` component that stores token in sessionStorage and displays a branded login/signup prompt to unauthenticated users
- CTA hides automatically for authenticated users via `authClient.useSession()` without useEffect
- Login URL correctly encodes `/onboard-setup?token=<token>` as the `?next=` destination for post-login redirect

## Task Commits

Each task was committed atomically:

1. **Task 1: Add login CTA banner to report page with token preservation** - `ba4c26ae4` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified
- `apps/mesh/src/web/routes/report.tsx` - Added `authClient` and `LOCALSTORAGE_KEYS` imports, `SignupCTA` component, and rendered it after `<PercentileSection />`
- `apps/mesh/src/web/lib/localstorage-keys.ts` - Added `onboardingToken: () => "mesh:onboarding:token"` key

## Decisions Made
- Used `authClient.useSession()` directly in `SignupCTA` (not prop drilling session from `ReportPage`) — keeps the CTA self-contained
- sessionStorage write placed synchronously in render body (not useEffect) — React 19-safe, idempotent, and the linter accepts it since it's guarded by `typeof window !== "undefined"`
- `?next=` value uses `encodeURIComponent` because it contains `?` and `=` characters that would break the outer URL parse

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- Plan 02 complete: login CTA renders on report, token is preserved in both URL and sessionStorage
- Plan 03 (onboard-setup page) can now read the token from `/onboard-setup?token=<token>` after post-login redirect, with sessionStorage as fallback when OAuth strips query params

## Self-Check: PASSED

All files verified:
- FOUND: apps/mesh/src/web/routes/report.tsx
- FOUND: apps/mesh/src/web/lib/localstorage-keys.ts
- FOUND: .planning/phases/21-auth-handoff/21-02-SUMMARY.md
- FOUND commit: ba4c26ae4

---
*Phase: 21-auth-handoff*
*Completed: 2026-02-25*
