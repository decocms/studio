# Phase 19: Diagnostic Backend - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Public API that accepts a storefront URL, runs 4 diagnostic agents in parallel, and returns progressive results via a pollable session token. No UI in this phase — that's Phase 20. No auth — that's Phase 21.

This is the **first step of the product onboarding flow**: user enters a storefront URL at `/onboarding`, gets a diagnostic report showing real value before ever logging in.

</domain>

<decisions>
## Implementation Decisions

### End-to-End Onboarding Flow (cross-phase context)
The diagnostic backend is step 1 of this full flow — understanding the big picture matters:
1. `/onboarding` — public URL input, no login (Phase 19 backend + Phase 20 UI)
2. Diagnostic runs → report renders (wow moment) — real data + mocked "Pro" sections
3. CTA to sign up → auth flow preserves report token (Phase 21)
4. Post-login: **Org created** (name from crawled company name, NOT email domain), **Project created** (one project = one storefront URL), diagnostic report attached to project
5. If user's email domain matches existing org → ask "Join existing team or start fresh?"
6. Decopilot chat opens with onboarding system prompt → 3-question interview about goals (Phase 22)
7. Based on diagnostic results + goals → recommend agents to **hire** for this project
8. User approves → agents assigned to project, visible in existing Agents sidebar
9. User lands on project dashboard — diagnostic visible, agents working, no manual config needed

### Diagnostic Agent Architecture
Skills belong to agents, not the other way around. 4 diagnostic agents, each running multiple checks:

**Agent 1: Web Performance**
- Image audit: preload tags (too many? none?), lazy-load on below-fold images, fetchpriority on LCP candidate, AVIF/WebP format detection, srcset/sizes responsive checks
- HTML size analysis: total HTML size, framework JSON payload bloat (NEXT_DATA, FRSH_STATE), structured data size, duplicate responsive blocks
- Cache header analysis
- Core Web Vitals from PSI API: LCP, INP, CLS
- Mobile + desktop performance scores
- CrUX real-user data (fallback to PSI field data for low-traffic sites)
- Data sources: HTML crawl + PSI API + CrUX API

**Agent 2: SEO**
- Heading structure (h1/h2 hierarchy)
- Index/robots (meta robots tag, robots.txt)
- Sitemap detection
- Structured data (schema.org validation)
- Title tag, meta description
- OG tags (Open Graph)
- Canonical URL
- Data source: HTML crawl

**Agent 3: Tech Stack**
- Platform detection (VTEX, Shopify, WooCommerce, etc.)
- Analytics (GA4, GTM, etc.)
- CDN (Cloudflare, Fastly, etc.)
- Payment providers
- Chat tools, review widgets
- Data source: HTML crawl + HTTP headers

**Agent 4: Company Context**
- Crawl homepage + navigation links (About/Company pages, other relevant pages)
- Generate AI company description: conversational/friendly tone, two paragraphs
- First paragraph: what the store sells, who it targets
- Second paragraph: competitive positioning, market category
- Extract: product catalog signals, target audience, competitive angle
- Data source: multi-page crawl + LLM call

**These diagnostic agents preview what the full platform agents do** — the recommendation in Phase 22 is essentially "hire the Web Performance Agent to keep monitoring this."

### Mocked Sections (Phase 20 report UI, NOT this phase)
- Traffic volume and competitor comparison
- SEO rankings and backlinks
- Brand/visual identity extraction
- Percentile comparison vs other storefronts
All mocked with realistic data + "Pro" badge in the report UI

### Progressive status updates
- Status updates expose **individual agent names** (e.g. "Running Web Performance analysis...", "Detecting tech stack...") — transparent, not abstracted
- Display as a **parallel checklist** — each agent shows as a line item that checks off independently as it completes
- Results **reveal all at once** after the full pipeline finishes — loading checklist, then polished reveal
- Polling interval is Claude's discretion

### Failure & partial results
- When an agent fails or has no data, show a **"Not available" placeholder** — don't omit sections
- **No distinction** between "agent error" and "no data exists" — both show as "Not available"
- **Always produce a report** even if the most critical agent (PSI) fails
- **Generous timeouts** — don't rush agents

### Session lifecycle
- **Cache with re-scan option** — if recent diagnostic exists for same URL (<24h), show cached result with "Re-scan" button
- Results persist for **7 days** before cleanup
- Rate limiting is Claude's discretion
- **Retroactive org association** — session schema has nullable org_id, filled post-login (Phase 21)
- Session must also support nullable project_id for when the project gets created post-login

### AI company context generation
- **Conversational/friendly tone** — not a formal market brief
- **Two paragraphs** — what + who, then competitive positioning
- **Crawl beyond the homepage** — follow navigation to About/Company pages
- This company context becomes the org's company context after login — editable by the user

### Claude's Discretion
- Polling interval for client status checks
- Rate limiting strategy for the public endpoint
- Per-agent timeout values (generous)
- Which additional pages beyond homepage to crawl for company context
- Database schema design and cleanup job implementation
- Whether to share HTML crawl data between agents or have each agent crawl independently (sharing is preferred for efficiency)

</decisions>

<specifics>
## Specific Ideas

- Use existing storefront skills (Images Skill, HTML Size Skill) as the checks within the Web Performance diagnostic agent — these already encode best practices
- The loading checklist should feel like CI/CD parallel job status
- Company context should read like explaining the business to a colleague
- Diagnostic agents are standalone async functions, NOT MCP tools (MeshContext requires auth, and this is pre-auth)
- Public Hono routes registered before MeshContext middleware via `shouldSkipMeshContext()`
- SSRF validation must be in place before the public endpoint goes live (BLOCKER from STATE.md)
- The diagnostic is a PREVIEW of the agents — it demonstrates value, then the recommendation is to hire the full agent

</specifics>

<deferred>
## Deferred Ideas

- Real traffic data via SimilarWeb/SEMrush API — future phase when paid APIs are integrated
- Real SEO rankings via Ahrefs/DataForSEO — same
- Brand/visual identity extraction (color analysis, logo detection) — heavy, defer
- Percentile benchmarking database — needs data collection across many storefronts
- Full page-by-page crawl (product pages, collection pages) — homepage scan is sufficient for onboarding wow moment

</deferred>

---

*Phase: 19-diagnostic-backend*
*Context gathered: 2026-02-25*
