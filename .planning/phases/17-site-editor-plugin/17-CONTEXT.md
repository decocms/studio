# Phase 17: site-editor plugin - Context

**Gathered:** 2026-02-21
**Status:** Ready for planning

<domain>
## Phase Boundary

A full visual site editor plugin for the Mesh admin UI. Activates automatically when `DECO_BLOCKS_BINDING` is detected on the project's connection. Covers: page navigation, visual composer (sections + props), git UX, and a live preview panel that points at the dev server local-dev is running.

The plugin does NOT own the dev server or preview URL — those are local-dev concerns. The plugin reads whatever URL the agent/connection exposes and iframes it.

</domain>

<decisions>
## Implementation Decisions

### Plugin shell & navigation
- Site editor appears as a **dedicated tab** in the project nav (alongside Connections, Settings, etc.)
- Tab is **hidden entirely** for projects that don't implement DECO_BLOCKS_BINDING — no greyed-out state, no noise
- Inside the tab: **left sidebar for the page list, right area for the composer**
- Creating or renaming a page uses a **modal dialog** (not inline rename)

### Composer layout
- **Two-panel split:** left panel (sections + props), right panel (preview iframe)
- Left panel uses **slide/replace navigation:** section list → click section → panel slides to props form with a back button to return to list
- No permanent three-column layout — sections and props share the same left panel
- Loader binding (EDT-08) uses a **separate binding drawer/panel** triggered from a "Bind loader" button in the props form, not a dropdown inline in the field
- Undo/redo (EDT-10) operates at **per-action granularity** — each discrete action (add section, reorder, change a prop field value) is one undo step, not per-keystroke

### Preview integration
- Right panel is an **iframe pointed at the local-dev server port** — the full dev server is navigable, not locked to a single page
- The preview URL comes from the connection/agent context (the port local-dev registered with) — the site editor reads it, does not manage it
- **Edit mode:** pointer events blocked on the iframe; the left sections panel is the active editing surface
- **Interact mode:** pointer events pass through to the iframe; user can click links, scroll, interact with the live site
- The "chat to edit" experience is the **global Mesh chat**, aware of the current connection/agent context — not a separate panel owned by the site editor

### Git UX placement
- Pending changes and git history surface in a **bottom bar / footer** in the composer
- Footer shows pending change count; clicking expands the footer panel with diff details, commit button, and history list
- **Commit flow:** click commit → Claude auto-generates message → user reviews/edits in a confirmation dialog before committing
- **Git history:** clicking a commit in the footer list **expands a diff panel inline** below the commit list (not replacing the preview)
- **Revert:** runs via `git checkout <hash> -- <file>` (file-level, scoped to the current page's file) via bash; composer refreshes sections after revert

### Claude's Discretion
- Exact drag-and-drop library for section reordering
- RJSF configuration and widget overrides for props forms
- Loading states and skeleton design
- Footer panel animation and collapse behavior
- Error state handling (e.g., local-dev offline, git command failure)
- Specific icon choices and spacing

</decisions>

<specifics>
## Specific Ideas

- The preview is "like a mini browser" — the user can navigate all routes of the running dev server, not just the current page
- The agent-first mental model: `deco link` → MCP Connection → Mesh Agent → agent has full filesystem + bash access → agent runs dev server via bash → site editor plugin is the special deco UI layered on top of that agent experience
- "Like magic" — the agent should figure out how to run the project on its own by reading package.json (this is a local-dev + deco link concern, not Phase 17's job, but the site editor design should assume the dev server URL is already available when the plugin renders)

</specifics>

<deferred>
## Deferred Ideas

- **Dev server auto-discovery** — Agent reads package.json, runs `bun dev` via bash, discovers the port automatically. This is a Phase 15 (local-dev) + Phase 18 (deco link) concern. Phase 17 just consumes the URL.
- **Chat-alongside-preview panel** — User mentioned "chat to edit" as a side panel next to the preview. Deferred: the global Mesh chat is sufficient for Phase 17. A dedicated split-pane chat+preview layout could be a future phase.
- **Agent auto-creation on local-dev registration** — When `deco link` registers local-dev as a connection, Mesh auto-creates an Agent for it. This is Phase 18 scope.
- **Framework-agnostic preview** — "Even if a site is not using our framework, we should be able to preview it and run agents on it." The preview iframe in Phase 17 is already framework-agnostic (just an iframe). The agent-powered experience for non-deco sites is a broader capability worth its own phase.

</deferred>

---

*Phase: 17-site-editor-plugin*
*Context gathered: 2026-02-21*
