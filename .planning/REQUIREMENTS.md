# Requirements: MCP Mesh

**Defined:** 2026-02-20
**Amended:** 2026-02-25 — v1.4 Storefront Onboarding milestone added
**Core Value:** E-commerce teams get an instant storefront diagnostic and guided onboarding into a team of AI agents that optimize their store.

## v1.4 Requirements

### Diagnostic Backend (DIAG)

- [x] **DIAG-01**: User can enter a storefront URL on a public page (no login required) and trigger a diagnostic scan
- [x] **DIAG-02**: System crawls the homepage HTML and extracts platform (VTEX, Shopify, etc.), SEO signals (title, meta, OG, schema markup), and page content
- [x] **DIAG-03**: System calls PageSpeed Insights API for Core Web Vitals (LCP, INP, CLS) and performance scores (mobile + desktop)
- [x] **DIAG-04**: System calls CrUX API for real user experience data, with fallback to PSI field data for low-traffic sites
- [x] **DIAG-05**: System detects tech stack from HTML/headers: analytics (GA4, GTM), CDN (Cloudflare), payment providers, review widgets, chat tools
- [x] **DIAG-06**: System generates AI company context from crawled data — what the store sells, who it targets, positioning (one paragraph via LLM)
- [x] **DIAG-07**: System shows traffic volume and competitor comparison sections (mocked data for v1.4, real API integration in future)
- [x] **DIAG-08**: System shows SEO ranking/backlink data sections (mocked data for v1.4)
- [x] **DIAG-09**: System shows brand/visual identity extraction section (mocked data for v1.4)
- [x] **DIAG-10**: System shows percentile comparison vs other storefronts (mocked data for v1.4)
- [x] **DIAG-11**: System validates URL input and prevents SSRF attacks (blocks private/internal IPs after DNS resolution)
- [x] **DIAG-12**: All diagnostic agents run in parallel with timeout handling; report renders with partial results if any agent fails

### Report (RPT)

- [x] **RPT-01**: Diagnostic results render as a structured report with sections: performance, SEO, tech stack, company context, traffic, competitors, brand
- [x] **RPT-02**: Report is accessible at a public URL without login (`/report/<token>`)
- [x] **RPT-03**: Mocked sections show data with a visual "Pro" or "upgrade" indicator
- [x] **RPT-04**: Report is shareable via link copy button
- [x] **RPT-05**: Company context section is editable after login
- [x] **RPT-06**: Report is stored and persisted (survives page refresh)

### Authentication Flow (AUTH)

- [x] **AUTH-01**: User sees a login/signup prompt after viewing the initial diagnostic report
- [x] **AUTH-02**: After login, system creates or joins an org derived from the user's email domain
- [x] **AUTH-03**: Pre-auth diagnostic state (URL + report token) is preserved through the login/signup flow
- [x] **AUTH-04**: After login, the diagnostic report is associated with the user's org and visible in the Reports plugin

### Interview + Goals (INTV)

- [x] **INTV-01**: Post-login user enters a chat-based interview (max 3 focused questions) about their goals and challenges
- [x] **INTV-02**: Interview uses existing decopilot chat infrastructure with a structured system prompt
- [x] **INTV-03**: Interview results (goals, challenges, priorities) are persisted to the org's company context

### Agent Recommendations (AGNT)

- [x] **AGNT-01**: After interview, system recommends 2-3 agents based on diagnostic results + declared goals
- [x] **AGNT-02**: Each recommendation shows the agent's purpose, why it's recommended, and what connections it needs
- [x] **AGNT-03**: User can initiate connection setup directly from an agent recommendation card
- [x] **AGNT-04**: Connection setup pre-populates the connection type from the agent's requirements

## v1.3 Requirements (previous milestone)

<details>
<summary>Local Dev Daemon, Deco Blocks Plugin, Site Editor Plugin, deco link</summary>

### Local Dev Daemon (`packages/local-dev/`)

- [ ] **LDV-01**: Developer can start the local-dev MCP daemon pointing at a folder with a single command
- [ ] **LDV-02**: local-dev exposes full filesystem tools scoped to the target folder
- [ ] **LDV-03**: local-dev exposes OBJECT_STORAGE_BINDING tools backed by local filesystem
- [ ] **LDV-04**: local-dev exposes an unrestricted bash execution tool scoped to the project folder
- [ ] **LDV-05**: local-dev exposes a readiness endpoint (`/_ready`)
- [ ] **LDV-06**: local-dev forwards SIGTERM to spawned processes for clean shutdown
- [ ] **LDV-07**: local-dev exposes SSE `/watch` stream for filesystem change events

### Deco Blocks Plugin (`packages/mesh-plugin-deco-blocks/`)

- [ ] **BLK-01** through **BLK-06**: Block/loader scanning, DECO_BLOCKS_BINDING, Claude skill

### Site Editor Plugin (`packages/mesh-plugin-site-editor/`)

- [ ] **EDT-01** through **EDT-15**: Pages CRUD, visual composer, preview, git UX

### `deco link` command (`packages/cli/`)

- [ ] **LNK-01** through **LNK-08**: Local project linking to Mesh

</details>

## Out of Scope (v1.4)

| Feature | Reason |
|---------|--------|
| SimilarWeb/DataForSEO/ReclameAqui real API integration | Paid APIs — mocked for now, real in future |
| Email nurture sequences | Marketing automation, not product onboarding |
| WhatsApp report sharing | Shareable URL is sufficient |
| VTEX Day booth/kiosk mode | Separate concern |
| Full page-by-page crawl (all product/collection pages) | Homepage scan is sufficient for wow moment |
| WCAG accessibility audit | Separate audit type, defer |
| Multi-step wizard with 10+ questions | Research shows max 3 questions for conversion |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| DIAG-01 | Phase 19 | Complete |
| DIAG-02 | Phase 19 | Complete |
| DIAG-03 | Phase 19 | Complete |
| DIAG-04 | Phase 19 | Complete |
| DIAG-05 | Phase 19 | Complete |
| DIAG-06 | Phase 19 | Complete |
| DIAG-07 | Phase 20 | Complete |
| DIAG-08 | Phase 20 | Complete |
| DIAG-09 | Phase 20 | Complete |
| DIAG-10 | Phase 20 | Complete |
| DIAG-11 | Phase 19 | Complete |
| DIAG-12 | Phase 19 | Complete |
| RPT-01 | Phase 20 | Complete |
| RPT-02 | Phase 20 | Complete |
| RPT-03 | Phase 20 | Complete |
| RPT-04 | Phase 20 | Complete |
| RPT-05 | Phase 20 | Complete |
| RPT-06 | Phase 20 | Complete |
| AUTH-01 | Phase 21 | Complete |
| AUTH-02 | Phase 21 | Complete |
| AUTH-03 | Phase 21 | Complete |
| AUTH-04 | Phase 21 | Complete |
| INTV-01 | Phase 22 | Complete |
| INTV-02 | Phase 22 | Complete |
| INTV-03 | Phase 22 | Complete |
| AGNT-01 | Phase 22 | Complete |
| AGNT-02 | Phase 22 | Complete |
| AGNT-03 | Phase 22 | Complete |
| AGNT-04 | Phase 22 | Complete |

**Coverage:**
- v1.4 requirements: 29 total (12 DIAG + 6 RPT + 4 AUTH + 3 INTV + 4 AGNT)
- Mapped to phases: 29
- Unmapped: 0

---
*Requirements defined: 2026-02-25*
*Last updated: 2026-02-25 — v1.4 traceability complete (phases 19–22)*
