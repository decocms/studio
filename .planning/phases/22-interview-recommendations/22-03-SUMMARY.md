---
phase: 22-interview-recommendations
plan: "03"
subsystem: ui
tags: [react, tanstack-router, recommendation-cards, onboarding, useQuery]

requires:
  - phase: 22-interview-recommendations
    plan: "02"
    provides: GET /api/onboarding/recommendations endpoint returning AgentRecommendation[]

provides:
  - Recommendation cards UI rendered at /onboard-interview?step=recommendations
  - AgentRecommendationCard component with icon, title, description, reason, connection status
  - RecommendationCardSkeleton for loading state
  - Empty state for no recommendations
  - onboardingRecommendations query key in KEYS object

affects:
  - onboard-interview.tsx (replaces placeholder recommendations view)

tech-stack:
  added: []
  patterns:
    - useQuery to fetch recommendations after interview completion
    - IntegrationIcon with custom fallback for agent icons
    - window.location.href for cross-layout navigation to connections page
    - Animated skeleton loading cards with animate-pulse

key-files:
  created: []
  modified:
    - apps/mesh/src/web/routes/onboard-interview.tsx
    - apps/mesh/src/web/lib/query-keys.ts

key-decisions:
  - "Navigate to connections via window.location.href (not router) — interview page is outside shell layout, cross-layout navigation requires full page reload"
  - "organizationId passed from activeOrgId (session.data.session.activeOrganizationId) to recommendations fetch — same as interview-results POST"
  - "RecommendationsView is a separate component extracted from main page — keeps main component focused on interview chat logic"
  - "Connect action always uses ?add=true on org-admin connections — no type pre-population since connection type is unknown from agent metadata alone"

requirements-completed: [AGNT-03, AGNT-04]

duration: 2min
completed: 2026-02-25
---

# Phase 22 Plan 03: Recommendation Cards UI Summary

**Recommendation cards view rendered at ?step=recommendations — AgentRecommendationCard components showing agent purpose, personalized reason, connection requirements, and one-click connect action**

## Performance

- **Duration:** 2 min
- **Started:** 2026-02-25T12:52:18Z
- **Completed:** 2026-02-25T12:55:01Z
- **Tasks:** 2
- **Files modified:** 2

## Accomplishments

- Added `onboardingRecommendations` query key to `KEYS` object for recommendation caching (scoped by diagnostic token)
- Built `AgentRecommendationCard` component with: `IntegrationIcon` with fallback SVG, agent title + description, lightbulb icon + personalized reason text, connection list with green/amber status dots + Connect links, "Hire this agent" CTA button
- Built `RecommendationCardSkeleton` for loading state — 3 pulsing placeholder cards with `animate-pulse`
- Built `RecommendationsView` component that fetches `/api/onboarding/recommendations` and renders cards, empty state, or skeleton
- Replaced placeholder `step === "recommendations"` block with full `RecommendationsView` component
- Empty state renders when recommendations array is empty — friendly message + "Go to dashboard" button
- "Skip for now" footer link always visible — users never feel trapped
- Connect action and "Hire this agent" button navigate to `/${org}/org-admin/connections?add=true`

## Task Commits

1. **Task 1: Add recommendations query key** - `e236a420d` (feat)
2. **Task 2: Build recommendation cards UI on interview page** - `c1a5a9db8` (feat)

**Plan metadata:** (docs commit follows)

## Files Created/Modified

- `apps/mesh/src/web/lib/query-keys.ts` - Added `onboardingRecommendations: (token: string)` key to KEYS constant
- `apps/mesh/src/web/routes/onboard-interview.tsx` - Added imports (IntegrationIcon, AgentRecommendation), 3 new components (RecommendationCardSkeleton, AgentRecommendationCard, RecommendationsView), replaced placeholder view with RecommendationsView

## Decisions Made

- Used `window.location.href` for navigation to connections page — the interview page is outside the shell layout, so TanStack Router navigation would not work correctly for cross-layout navigation.
- `organizationId` for the recommendations fetch comes from `activeOrgId` (session.data.session.activeOrganizationId) — the same field used by the interview-results POST mutation. No extra URL param needed.
- Extracted `RecommendationsView` as a separate component — keeps the main `OnboardInterviewPage` focused on chat logic, and avoids calling `useQuery` conditionally (React rules of hooks).
- Connect action uses `?add=true` without type pre-population — connection type is not available in `AgentRecommendation.requiredConnections` metadata, so we open the dialog and let the user pick the type.

## Deviations from Plan

None - plan executed exactly as written.

## Self-Check: PASSED

- `apps/mesh/src/web/routes/onboard-interview.tsx` — FOUND
- `apps/mesh/src/web/lib/query-keys.ts` — FOUND
- Commit `e236a420d` — FOUND
- Commit `c1a5a9db8` — FOUND
- `bun run check` — PASSED
- `bun run lint` — PASSED (0 warnings, 0 errors)
- `bun run fmt:check` — PASSED (no fixes needed)

---
*Phase: 22-interview-recommendations*
*Completed: 2026-02-25*
