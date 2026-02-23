# Requirements: MCP Mesh

**Defined:** 2026-02-20
**Amended:** 2026-02-20 — lead engineer feedback: bash over git tools, deco-cli as entry point, projects as virtual MCPs
**Core Value:** Developers can connect any MCP server to Mesh and get auth, routing, observability, and a polished admin UI — including a full visual site editor for Deco-compatible sites.

## v1.3 Requirements

### Local Dev Daemon (`packages/local-dev/`)

- [ ] **LDV-01**: Developer can start the local-dev MCP daemon pointing at a folder with a single command
- [ ] **LDV-02**: local-dev exposes full filesystem tools (read, write, edit, list, tree, search, delete, copy) scoped to the target folder
- [ ] **LDV-03**: local-dev exposes OBJECT_STORAGE_BINDING tools (LIST_OBJECTS, GET/PUT_PRESIGNED_URL, DELETE_OBJECT, GET_ROOT) backed by local filesystem with embedded HTTP server for presigned URLs
- [ ] **LDV-04**: local-dev exposes an unrestricted bash execution tool scoped to the project folder (covers git, dev server, build commands, etc. — like Claude Code's bash)
- [ ] **LDV-05**: local-dev exposes a readiness endpoint (`/_ready`) that Mesh polls before marking the project online
- [ ] **LDV-06**: local-dev forwards SIGTERM to any spawned processes for clean shutdown
- [ ] **LDV-07**: local-dev exposes SSE `/watch` stream for filesystem change events (real-time file edits visible in Mesh UI)

> **Note:** Git-specific tools (GIT_STATUS, GIT_DIFF, etc.) were removed — all git operations go through **LDV-04** (bash). Dev server management is also covered by bash (e.g. `bash("bun dev")`).

### Deco Blocks Plugin (`packages/mesh-plugin-deco-blocks/`)

- [ ] **BLK-01**: plugin-deco-blocks scans a folder and returns all block definitions (name, props schema, file path)
- [ ] **BLK-02**: plugin-deco-blocks scans a folder and returns all loader definitions (name, props schema, return type)
- [ ] **BLK-03**: plugin-deco-blocks defines DECO_BLOCKS_BINDING — the binding a connection must implement to be treated as a deco site
- [ ] **BLK-04**: plugin-deco-blocks provides `isDecoSite(connection)` binding checker usable by other plugins and flows
- [ ] **BLK-05**: plugin-deco-blocks ships with the canonical BLOCKS_FRAMEWORK.md spec as a package asset
- [ ] **BLK-06**: plugin-deco-blocks includes the Claude skill for implementing deco blocks (`.claude/commands/deco/blocks-framework.md`)

### Site Editor Plugin (`packages/mesh-plugin-site-editor/`)

- [ ] **EDT-01**: User can view and navigate all pages in a deco site project
- [ ] **EDT-02**: User can create, rename, and delete pages
- [ ] **EDT-03**: User can view all available blocks and their prop schemas
- [ ] **EDT-04**: User can view all available loaders and their prop schemas
- [ ] **EDT-05**: User can open the visual composer for any page
- [ ] **EDT-06**: User can add, remove, and reorder sections on a page via drag-and-drop
- [ ] **EDT-07**: User can edit section props via auto-generated form (RJSF)
- [ ] **EDT-08**: User can bind a loader to a section prop
- [ ] **EDT-09**: User can preview the page live in an iframe with edit/interact mode toggle
- [ ] **EDT-10**: User can undo and redo changes in the composer
- [ ] **EDT-11**: User sees pending changes (sections added/modified/deleted vs git HEAD) with diff badges — powered by bash git calls via local-dev
- [ ] **EDT-12**: User can commit pending changes from Mesh UI with a Claude-generated commit message — via bash git commit
- [ ] **EDT-13**: User can view git history for the current page with commit list and diff preview — via bash git log/show
- [ ] **EDT-14**: User can revert to a previous commit with a confirmation dialog — via bash git checkout
- [ ] **EDT-15**: Site editor activates automatically when the project connection implements DECO_BLOCKS_BINDING

> **Note:** EDT-11 through EDT-14 (git UX) activate only when the connection also exposes the bash tool. No direct dependency on local-dev package — capability-checked at runtime.

### `deco link` command (`packages/cli/`)

- [ ] **LNK-01**: Developer can run `deco link ./my-folder` to register a local project folder with a running Mesh instance
- [ ] **LNK-02**: `deco link` starts a local-dev daemon for the given folder (or connects to an already-running one)
- [ ] **LNK-03**: `deco link` creates (or reuses) a Connection in Mesh pointing at the local-dev daemon
- [ ] **LNK-04**: `deco link` creates (or reuses) a Project in Mesh wired to that Connection
- [ ] **LNK-05**: If the folder is a deco site (`.deco/` present), `deco link` auto-enables the site-editor plugin on the project
- [ ] **LNK-06**: `deco link` opens the browser to the project URL in Mesh, already logged in
- [ ] **LNK-07**: `deco link` keeps running as a daemon — when Ctrl+C is pressed, local-dev shuts down cleanly
- [ ] **LNK-08**: `deco link` is designed for both local Mesh (v1.3) and remote Mesh via tunnel (v1.4) — the Mesh URL is configurable

> **Note:** deco-cli (`packages/cli`) already exists with login support. `deco link` is a new command added to it. The CLI is the portable piece; Mesh can be local or remote.

## v2 Requirements

### Projects as Virtual MCPs (v1.4)

- **PRJ-01**: Projects expose themselves as MCP servers (virtual MCP with all project tools)
- **PRJ-02**: `deco link` creates a local proxy so developer can call the project's virtual MCP tools from their local machine
- **PRJ-03**: Developer can write local code that calls project tools via the CLI proxy

### Remote & Collaboration (v1.4)

- **RMT-01**: `deco link` can connect local folder to a remote Mesh instance via tunnel
- **RMT-02**: Project can be linked to a GitHub repository
- **RMT-03**: User can switch between "local" and "branch on GitHub" views in a project

## Out of Scope

| Feature | Reason |
|---------|--------|
| Kubernetes / remote daemon | Local-first only for this milestone |
| GitHub integration | Deferred to v1.4 |
| Tunnel / remote Mesh | Deferred to v1.4 |
| Projects as virtual MCPs (local proxy) | Deferred to v1.4 |
| Multi-user local setup | Single developer workflow only |
| Mobile / responsive site editor | Desktop workflow only |
| `npx @decocms/mesh` as entry point | Replaced by `deco link` via packages/cli |

## Traceability

| Requirement | Phase | Status |
|-------------|-------|--------|
| LDV-01 | Phase 15 | Pending |
| LDV-02 | Phase 15 | Pending |
| LDV-03 | Phase 15 | Pending |
| LDV-04 | Phase 15 | Pending |
| LDV-05 | Phase 15 | Pending |
| LDV-06 | Phase 15 | Pending |
| LDV-07 | Phase 15 | Pending |
| BLK-01 | Phase 16 | Pending |
| BLK-02 | Phase 16 | Pending |
| BLK-03 | Phase 16 | Pending |
| BLK-04 | Phase 16 | Pending |
| BLK-05 | Phase 16 | Pending |
| BLK-06 | Phase 16 | Pending |
| EDT-01 | Phase 17 | Pending |
| EDT-02 | Phase 17 | Pending |
| EDT-03 | Phase 17 | Pending |
| EDT-04 | Phase 17 | Pending |
| EDT-05 | Phase 17 | Pending |
| EDT-06 | Phase 17 | Pending |
| EDT-07 | Phase 17 | Pending |
| EDT-08 | Phase 17 | Pending |
| EDT-09 | Phase 17 | Pending |
| EDT-10 | Phase 17 | Pending |
| EDT-11 | Phase 17 | Pending |
| EDT-12 | Phase 17 | Pending |
| EDT-13 | Phase 17 | Pending |
| EDT-14 | Phase 17 | Pending |
| EDT-15 | Phase 17 | Pending |
| LNK-01 | Phase 18 | Pending |
| LNK-02 | Phase 18 | Pending |
| LNK-03 | Phase 18 | Pending |
| LNK-04 | Phase 18 | Pending |
| LNK-05 | Phase 18 | Pending |
| LNK-06 | Phase 18 | Pending |
| LNK-07 | Phase 18 | Pending |
| LNK-08 | Phase 18 | Pending |

**Coverage:**
- v1.3 requirements: 36 total (7 LDV + 6 BLK + 15 EDT + 8 LNK)
- Mapped to phases: 36
- Unmapped: 0 ✓

---
*Requirements defined: 2026-02-20*
*Last updated: 2026-02-20 — amended per lead engineer: bash replaces git tools, deco link in packages/cli replaces npx @decocms/mesh, projects-as-MCPs deferred to v1.4*
