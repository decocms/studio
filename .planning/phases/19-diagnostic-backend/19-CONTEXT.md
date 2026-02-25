# Phase 19: Diagnostic Backend - Context

**Gathered:** 2026-02-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Public API that accepts a storefront URL, runs 5+ diagnostic agents in parallel (PSI, CrUX, HTML/SEO extraction, tech stack detection, AI company context), and returns progressive results via a pollable session token. No UI in this phase — that's Phase 20. No auth — that's Phase 21.

</domain>

<decisions>
## Implementation Decisions

### Progressive status updates
- Status updates expose **individual agent names** (e.g. "Running PageSpeed analysis...", "Detecting tech stack...") — transparent, not abstracted
- Display as a **parallel checklist** — each agent shows as a line item that checks off independently as it completes. User sees all agents at once
- Results **reveal all at once** after the full pipeline finishes — not progressively. Loading screen with the checklist, then a polished reveal of the complete report
- Polling interval is Claude's discretion — pick a sensible balance between responsiveness and server load

### Failure & partial results
- When an agent fails or has no data, show a **"Not available" placeholder** in that section — don't omit sections silently
- **No distinction** between "agent error" and "no data exists" — both show as "Not available" to the user. Keep it simple
- **Always produce a report** even if the most critical agent (PSI) fails — tech stack, SEO, company context still have value
- **Generous timeouts** — don't rush the agents. Set high per-agent limits (Claude picks appropriate values per agent based on expected response times)

### Session lifecycle
- **Cache with re-scan option** — if a recent diagnostic exists for the same URL (e.g. <24h), show the cached result with a "Re-scan" button instead of triggering a new pipeline
- Results persist for **7 days** before cleanup — keeps the database lean
- Rate limiting is Claude's discretion — determine what's appropriate for a public pre-auth endpoint
- **Retroactive association** — when a user logs in (Phase 21), their pre-auth diagnostic gets linked to the org. The session schema must support this (nullable org_id that gets filled post-login)

### AI company context generation
- **Conversational/friendly tone** — "Acme is an online fashion store that sells trendy clothes for young adults..." not a formal market brief
- **Two paragraphs** — first: what the store sells, who it targets. Second: competitive positioning, market category
- Extract **product + audience + competitive angle** from crawled data — what they sell, who buys it, how they position, likely competitors and market category
- **Crawl beyond the homepage** — the user gives the main URL, and we proactively follow navigation links to About/Company pages and other relevant pages to build richer context. Claude has discretion on which pages to fetch

### Claude's Discretion
- Polling interval for client status checks
- Rate limiting strategy for the public endpoint
- Per-agent timeout values (generous, but specific numbers per agent type)
- Which additional pages beyond homepage to crawl for company context
- Database schema design and cleanup job implementation

</decisions>

<specifics>
## Specific Ideas

- The loading experience should feel like a parallel checklist with individual agent names checking off — similar to how CI/CD pipelines show parallel job status
- The "reveal" moment when all agents complete should feel polished — loading checklist transitions to the full report
- Company context should read like a friendly briefing, not a corporate report — imagine explaining the business to a colleague

</specifics>

<deferred>
## Deferred Ideas

None — discussion stayed within phase scope

</deferred>

---

*Phase: 19-diagnostic-backend*
*Context gathered: 2026-02-25*
