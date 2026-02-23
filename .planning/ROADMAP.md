# Roadmap: MCP Mesh

## Milestones

- ✅ **v1.0 — Core Mesh** - Phases 1–5 (shipped, on main)
- ✅ **v1.1 — Site Editor Foundation** - Phases 6–9 (shipped, on gui/site-builder)
- ✅ **v1.2 — Git-Native Editing** - Phases 11–14 (shipped, on gui/site-builder)
- 🚧 **v1.3 — Local-First Development** - Phases 15–18 (current)

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

### 🚧 v1.3 — Local-First Development (Current)

**Milestone Goal:** Ship the site editor and local development experience as clean, reviewable PRs from a well-structured set of new packages. Four packages, four PRs, each independently mergeable.

## Phases

- [ ] **Phase 15: local-dev daemon** - MCP server for local filesystem, object storage, git, and dev server management
- [ ] **Phase 16: plugin-deco-blocks** - Standalone deco blocks framework: scanners, DECO_BLOCKS_BINDING, Claude skill
- [ ] **Phase 17: site-editor plugin** - Full site editor UI with visual composer and git UX
- [ ] **Phase 18: deco link command** - `deco link ./folder` in packages/cli connects local project to Mesh

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

## Progress

**Execution Order:** 15 → 16 → 17 → 18

| Phase | Milestone | Plans Complete | Status | Completed |
|-------|-----------|----------------|--------|-----------|
| 15. local-dev daemon | v1.3 | 0/? | Not started | - |
| 16. plugin-deco-blocks | v1.3 | 0/? | Not started | - |
| 17. site-editor plugin | v1.3 | 0/? | Not started | - |
| 18. deco link command | v1.3 | 0/? | Not started | - |
