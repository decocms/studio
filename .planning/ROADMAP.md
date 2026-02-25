# Roadmap: MCP Mesh

## Milestones

- ✅ **v1.0 — Core Mesh** - Phases 1–5 (shipped, on main)
- ✅ **v1.1 — Site Editor Foundation** - Phases 6–9 (shipped, on gui/site-builder)
- ✅ **v1.2 — Git-Native Editing** - Phases 11–14 (shipped, on gui/site-builder)
- 🚧 **v1.3 — Local-First Development** - Phases 15–18 (in progress)
- 📋 **v1.4 — Storefront Onboarding** - Phases 19–22 (planned)

<details>
<summary>✅ v1.0 — Core Mesh (Phases 1–5) — SHIPPED</summary>

Core platform: auth (Better Auth), connections, organizations, projects, plugin system, event bus, observability, Kysely storage. No site editor yet. Not tracked in GSD.

</details>

<details>
<summary>✅ v1.1 — Site Editor Foundation (Phases 6–9) — SHIPPED (gui/site-builder)</summary>

Pages CRUD, block/loader scanner, sections list, visual composer, preview bridge, multi-site support, tunnel detection. Tracked in branch .planning/.

</details>

<details>
<summary>✅ v1.2 — Git-Native Editing (Phases 11–14) — SHIPPED (gui/site-builder)</summary>

Git site binding tools, pending changes UI, commit dialog with Claude-generated messages, history panel, revert to commit. Tracked in branch .planning/.

</details>

---

### 🚧 v1.3 — Local-First Development (In Progress)

**Milestone Goal:** Ship the site editor and local development experience as clean, reviewable PRs from a well-structured set of new packages. Four packages, four PRs, each independently mergeable.

## Phases

- [ ] **Phase 15: local-dev daemon** - MCP server for local filesystem, object storage, git, and dev server management
- [ ] **Phase 16: plugin-deco-blocks** - Standalone deco blocks framework: scanners, DECO_BLOCKS_BINDING, Claude skill
- [ ] **Phase 17: site-editor plugin** - Full site editor UI with visual composer and git UX
- [ ] **Phase 18: deco link command** - `deco link ./folder` in packages/cli connects local project to Mesh
- [x] **Phase 19: Diagnostic Backend** - DB schema + parallel diagnostic service functions (real data: PSI, CrUX, HTML crawl, tech detection, AI context) (completed 2026-02-25)
- [x] **Phase 20: Public Report UI** - Public Hono routes + React report page with all sections (real + mocked) (completed 2026-02-25)
- [x] **Phase 21: Auth Handoff** - Login gate after report, token preservation through OAuth, org creation + report association (completed 2026-02-25)
- [ ] **Phase 22: Interview + Recommendations** - Post-login chat interview, agent recommendation engine, connection setup from recommendation cards

## Phase Details

### Phase 15: local-dev daemon
**Goal**: Developers can point local-dev at any folder and get a fully-featured MCP server covering filesystem, object storage, and unrestricted bash execution — all runnable as a daemon from a single command
**Depends on**: Nothing (standalone package, no mesh UI changes)
**Requirements**: LDV-01, LDV-02, LDV-03, LDV-04, LDV-05, LDV-06, LDV-07
**Success Criteria** (what must be TRUE):
  1. Developer runs a single command pointing at a folder and gets a running MCP daemon — no config files required
  2. Mesh (or any MCP client) can call filesystem tools: read, write, edit, list, tree, search, delete, copy — all scoped to the target folder
  3. Mesh can call OBJECT_STORAGE_BINDING tools (LIST_OBJECTS, GET/PUT_PRESIGNED_URL, DELETE_OBJECT, GET_ROOT) and they resolve to local files with an embedded HTTP server for presigned URLs
  4. Mesh can run any bash command scoped to the project folder (git, bun, deno, arbitrary scripts) — unrestricted, like Claude Code's bash tool
  5. Daemon responds to `/_ready`, forwards SIGTERM cleanly, and streams filesystem change events via SSE `/watch`
**Plans**: TBD

> **Amended 2026-02-20:** Removed git-specific tools (superseded by bash tool). Removed dev server management as separate feature (covered by bash). Added unrestricted bash execution.

### Phase 16: plugin-deco-blocks
**Goal**: A standalone package exports block/loader/section scanners, defines DECO_BLOCKS_BINDING, and ships the canonical framework documentation and Claude skill — ready to be consumed by site-editor and any future tool
**Depends on**: Nothing (pure infrastructure, no UI)
**Requirements**: BLK-01, BLK-02, BLK-03, BLK-04, BLK-05, BLK-06
**Success Criteria** (what must be TRUE):
  1. Calling the scanner against a deco project folder returns all block definitions with name, props schema, and file path
  2. Calling the scanner returns all loader definitions with name, props schema, and return type
  3. `isDecoSite(connection)` returns true for a connection that implements DECO_BLOCKS_BINDING, and false otherwise
  4. BLOCKS_FRAMEWORK.md is present as a package asset and the Claude skill is importable from the package
**Plans**: TBD

### Phase 17: site-editor plugin
**Goal**: Users with a deco site project can navigate pages, compose sections visually, edit props, preview live, and manage git history — all from the Mesh UI; the plugin activates automatically when DECO_BLOCKS_BINDING is detected
**Depends on**: Phase 16 (plugin-deco-blocks)
**Requirements**: EDT-01, EDT-02, EDT-03, EDT-04, EDT-05, EDT-06, EDT-07, EDT-08, EDT-09, EDT-10, EDT-11, EDT-12, EDT-13, EDT-14, EDT-15
**Success Criteria** (what must be TRUE):
  1. User can browse all pages, create/rename/delete pages, and open the visual composer for any page — the plugin tab appears automatically when the project connection implements DECO_BLOCKS_BINDING
  2. User can add, remove, and reorder sections via drag-and-drop, edit section props with an auto-generated form, bind a loader to a prop, and undo/redo any change
  3. User can preview the page live in an iframe and toggle between edit mode and interact mode
  4. User sees pending changes (additions, edits, deletions vs git HEAD) with diff badges, and can commit them from the UI with a Claude-generated commit message
  5. User can view the git history for a page, see a diff preview per commit, and revert to any previous commit with a confirmation dialog
**Plans**: TBD

### Phase 18: deco link command
**Goal**: A developer can run `deco link ./my-folder` (from the existing deco-cli) and immediately see their local project in a running Mesh instance — browser opens, project ready, no manual wiring
**Depends on**: Phase 15 (local-dev daemon), Phase 17 (site-editor plugin for auto-enable detection)
**Requirements**: LNK-01, LNK-02, LNK-03, LNK-04, LNK-05, LNK-06, LNK-07, LNK-08
**Success Criteria** (what must be TRUE):
  1. Running `deco link ./my-folder` starts local-dev, registers it as a Connection in Mesh, creates a Project, and opens the browser to the project — already logged in
  2. If the folder is a deco site (`.deco/` present), the site-editor plugin is automatically enabled and the user lands on the site editor
  3. Running the same command again on an existing setup reuses the existing Connection and Project — nothing is duplicated
  4. Pressing Ctrl+C shuts down local-dev cleanly — the project goes offline in Mesh
  5. The Mesh URL is configurable so the same `deco link` command can target a remote Mesh instance (tunnel wiring deferred to v1.4, but the config surface is ready)
**Plans**: TBD

> **Amended 2026-02-20:** Replaced `npx @decocms/mesh ./folder` with `deco link` in packages/cli (deco-cli). CLI is the portable piece — Mesh can be local or remote. Auto-setup (admin/admin) remains needed for local Mesh but lives in Mesh startup, not in the CLI.

---

### 📋 v1.4 — Storefront Onboarding (Planned)

**Milestone Goal:** Self-service onboarding for e-commerce users — enter a storefront URL, get an instant diagnostic with real data, then guided setup into the platform. Value delivered before login; login triggered after the "wow moment."

### Phase 19: Diagnostic Backend
**Goal**: A user can enter any storefront URL and trigger a diagnostic that runs real agents in parallel — PSI performance scores, CrUX real-user data, HTML/SEO extraction, tech stack detection, and AI company context — with results persisted to a session that survives page refresh
**Depends on**: Nothing (pure backend, no UI dependencies)
**Requirements**: DIAG-01, DIAG-02, DIAG-03, DIAG-04, DIAG-05, DIAG-06, DIAG-11, DIAG-12
**Success Criteria** (what must be TRUE):
  1. Submitting a valid storefront URL returns a session token immediately (no blocking on the 10–30 second pipeline)
  2. Polling the session token shows progressive status updates and eventually resolves to a complete result set with Core Web Vitals (LCP, INP, CLS), mobile/desktop performance scores, CrUX real-user data (or PSI field data fallback), detected platform, SEO signals, tech stack, and a one-paragraph AI company context
  3. If one diagnostic agent fails or times out, the session still resolves with partial results — no single agent failure blocks the report
  4. Submitting a private IP address, localhost, or non-HTTP URL is rejected with a clear error before any outbound fetch occurs
**Plans:** 3/3 plans complete
Plans:
- [x] 19-01-PLAN.md — DB schema (diagnostic_sessions), SSRF validator, storage operations
- [x] 19-02-PLAN.md — Diagnostic agents (HTML crawler, SEO, Tech Stack, Web Performance, Company Context)
- [x] 19-03-PLAN.md — Orchestrator (parallel execution, progressive status) + public API routes

### Phase 20: Public Report UI
**Goal**: Diagnostic results render as a structured, shareable public report page accessible without login — including real data sections and clearly-marked mocked sections — with the URL input page as the entry point
**Depends on**: Phase 19 (Diagnostic Backend)
**Requirements**: DIAG-07, DIAG-08, DIAG-09, DIAG-10, RPT-01, RPT-02, RPT-03, RPT-04, RPT-05, RPT-06
**Success Criteria** (what must be TRUE):
  1. Visiting `/onboard` shows a URL input page with no login required; submitting a URL transitions to a loading state with progressive status messages, then to the completed report
  2. The report renders at `/report/<token>` with sections for performance (CWV scores), SEO (title/meta/OG/schema), tech stack, and AI company context — all sourced from real diagnostic data
  3. Traffic, competitor comparison, SEO rankings/backlinks, and brand/visual identity sections are visible with realistic data, each marked with a "Pro" or upgrade indicator
  4. Clicking the share button copies the report URL to clipboard — the same URL loads the full report for anyone with the link, with no login required
  5. The AI company context section has an edit affordance visible on the report page (edit requires login, but the affordance is present pre-login)
**Plans:** 3/3 plans complete
Plans:
- [ ] 20-01-PLAN.md — Routes + URL input page + loading state with agent checklist + polling
- [ ] 20-02-PLAN.md — Report page scaffold + real data sections (performance, SEO, tech stack, company context) + share button + edit affordance
- [ ] 20-03-PLAN.md — Mocked Pro sections (traffic, SEO rankings, brand, percentile) + Pro badge component

### Phase 21: Auth Handoff
**Goal**: After viewing the report, the user is prompted to log in; the diagnostic state survives the full OAuth redirect cycle; after login the org is created from the email domain and the report is associated with it
**Depends on**: Phase 20 (Public Report UI)
**Requirements**: AUTH-01, AUTH-02, AUTH-03, AUTH-04
**Success Criteria** (what must be TRUE):
  1. After the report loads, the user sees a login/signup prompt — clicking it navigates to the login page without losing the diagnostic session token
  2. After completing login or OAuth (including multi-step redirects), the user lands on a page that still has access to their diagnostic report — the token is not lost
  3. After login, an org is automatically created or joined based on the user's email domain — no manual org setup required
  4. The diagnostic report appears in the org's Reports plugin view and the company context from the report is editable by the logged-in user
**Plans:** 3/3 plans complete
Plans:
- [ ] 21-01-PLAN.md — Onboarding claim API routes (resolve org options + claim session with org/project creation)
- [ ] 21-02-PLAN.md — Login CTA on report page + diagnostic token preservation through OAuth
- [ ] 21-03-PLAN.md — Post-login onboard-setup page (org resolution UI + claim flow + redirect)

### Phase 22: Interview + Recommendations
**Goal**: Post-login, the user completes a focused 3-question chat interview about their goals; the system recommends 2–3 relevant agents based on diagnostic results and declared goals; the user can start connection setup directly from a recommendation card
**Depends on**: Phase 21 (Auth Handoff)
**Requirements**: INTV-01, INTV-02, INTV-03, AGNT-01, AGNT-02, AGNT-03, AGNT-04
**Success Criteria** (what must be TRUE):
  1. After login, the user enters a chat-based interview that asks at most 3 focused questions about their goals and challenges — the interview completes in under 2 minutes
  2. The interview uses the existing decopilot chat UI and stores the declared goals and challenges to the org's company context
  3. After the interview, the user sees 2–3 agent recommendation cards, each showing the agent's purpose, a plain-English explanation of why it was recommended given their diagnostic results and goals, and what connections it needs
  4. Clicking "Connect" on a recommendation card opens the connection setup wizard with the connection type pre-populated from the agent's requirements

## Progress

**Execution Order:** 15 → 16 → 17 → 18 → 19 → 20 → 21 → 22

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 15. local-dev daemon | v1.3 | 0/? | Not started | - |
| 16. plugin-deco-blocks | v1.3 | 0/? | Not started | - |
| 17. site-editor plugin | v1.3 | 0/? | Not started | - |
| 18. deco link command | v1.3 | 0/? | Not started | - |
| 19. Diagnostic Backend | v1.4 | Complete    | 2026-02-25 | 2026-02-25 |
| 20. Public Report UI | 3/3 | Complete    | 2026-02-25 | - |
| 21. Auth Handoff | 3/3 | Complete   | 2026-02-25 | - |
| 22. Interview + Recommendations | v1.4 | 0/? | Not started | - |
