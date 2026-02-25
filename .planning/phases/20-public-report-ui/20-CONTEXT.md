# Phase 20: Public Report UI - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Public React pages for the onboarding flow: URL input at `/onboarding`, loading state with agent checklist, and full diagnostic report at `/report/<token>`. No auth required. Includes real data sections from Phase 19 agents + mocked "Pro" sections.

</domain>

<decisions>
## Implementation Decisions

### Design & Feel
- The report should feel like a **paper being built** — agents running, then a polished document assembles
- Think **markdown with components** — clean typography, structured sections, data visualizations inline
- Good design is critical — this is the first impression of the product, the "wow moment"
- The loading state shows a **parallel checklist** with individual agent names checking off (from Phase 19 context)
- Results **reveal all at once** after pipeline completes — loading checklist transitions to the full report

### URL Input Page (`/onboarding`)
- Clean, minimal page — just a URL input field and a submit button
- No login required, public page
- Submitting triggers POST to `/api/diagnostic/scan` and transitions to loading state

### Loading State
- Shows the parallel agent checklist: Web Performance, SEO, Tech Stack, Company Context
- Each agent checks off as it completes (poll `/api/diagnostic/session/:token`)
- When all complete → transition to the full report

### Report Page (`/report/<token>`)
- Structured document feel — like a professional diagnostic report
- **Real data sections** (from Phase 19 agents):
  - Performance: Core Web Vitals (LCP, INP, CLS) with color-coded scores, mobile/desktop scores
  - SEO: title, meta description, OG tags, heading structure, robots, sitemap, structured data
  - Tech Stack: platform badge, analytics, CDN, payment providers, chat tools
  - Company Context: AI-generated two paragraphs, editable affordance (edit requires login but affordance visible)
- **Mocked "Pro" sections** (realistic data + "Pro" badge/upgrade indicator):
  - Traffic volume & competitor comparison
  - SEO rankings & backlinks
  - Brand/visual identity
  - Percentile comparison vs other storefronts
- Share button copies report URL to clipboard

### Architecture
- Public Hono routes serve the React pages (same `shouldSkipMeshContext` pattern as Phase 19)
- TanStack Router for `/onboarding` and `/report/$token` routes
- React 19 patterns — no useEffect, no useMemo/useCallback/memo
- Tailwind v4 design system tokens
- These are NEW public routes outside the normal authenticated app shell

### Claude's Discretion
- Exact component library choices for data visualization (score gauges, etc.)
- Animation/transition details for the loading → report reveal
- Responsive design breakpoints
- Exact color coding for CWV thresholds (good/needs-improvement/poor)
- Layout of mocked sections

</decisions>

<specifics>
## Specific Ideas

- "Agents running, then a paper being built" — the transition from loading to report should feel like the document is assembling
- Report should feel like reading a well-formatted markdown document with embedded components (score widgets, tech badges, etc.)
- The user wants to iterate on design after seeing it — ship something solid, not perfect

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 20-public-report-ui*
*Context gathered: 2026-02-25*
