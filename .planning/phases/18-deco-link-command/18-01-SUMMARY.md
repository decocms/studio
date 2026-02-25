---
phase: 18-deco-link-command
plan: 01
subsystem: cli
tags: [cli, mcp, better-auth, oauth, keychain, child-process, streamable-http]

# Dependency graph
requires:
  - phase: 15-local-dev-daemon
    provides: mcp-local-dev binary with /_ready endpoint on port 3456
  - phase: 17-site-editor-plugin
    provides: Mesh instance with /mcp/self and /api/auth/* endpoints
provides:
  - mesh-url.ts: Mesh URL resolution (localhost probe + cloud fallback)
  - mesh-auth.ts: Better Auth browser OAuth flow + system keychain token storage per Mesh URL
  - mesh-client.ts: MCP Client factory for /mcp/self + organization ID retrieval
  - local-dev-manager.ts: local-dev daemon probe/spawn/stop lifecycle
affects:
  - 18-02-PLAN.md: link command imports all four modules from this plan

# Tech tracking
tech-stack:
  added: []
  patterns:
    - "System keychain storage via platform CLI (security/secret-tool) with ~/.deco_mesh_tokens.json fallback"
    - "Browser OAuth callback server pattern: listen(0) for random port, open browser to /login?cli&redirectTo=callback"
    - "StreamableHTTPClientTransport with Bearer auth header for /mcp/self"
    - "Probe-first pattern: check /_ready before spawning daemon, return null if already alive"

key-files:
  created:
    - packages/cli/src/lib/mesh-url.ts
    - packages/cli/src/lib/mesh-auth.ts
    - packages/cli/src/lib/mesh-client.ts
    - packages/cli/src/lib/local-dev-manager.ts
  modified: []

key-decisions:
  - "System keychain via execSync platform CLIs (security/secret-tool/cmdkey) — no native addon dependency"
  - "Windows uses file-based fallback for token storage since cmdkey read is limited"
  - "startLocalDev() returns null when daemon already running — null signals no child to manage"
  - "getOrganizationId() tries /api/auth/get-session activeOrganizationId first, falls back to /api/auth/organization/list"
  - "OAuth callback extracts session cookies or query token param — supports both Mesh callback strategies"

patterns-established:
  - "Pattern 1: Keychain-first storage — try execSync platform CLI, catch all errors, fall back to chmod-600 JSON file"
  - "Pattern 2: Probe-then-spawn — always check if daemon alive before spawning to support already-running state"
  - "Pattern 3: Random-port callback server — server.listen(0) assigns OS-chosen port for OAuth callback"

requirements-completed:
  - LNK-02
  - LNK-08

# Metrics
duration: 3min
completed: 2026-02-22
---

# Phase 18 Plan 01: deco link Foundation Modules Summary

**Four CLI lib modules for Mesh URL resolution, Better Auth browser OAuth with keychain storage, MCP /mcp/self client, and mcp-local-dev daemon lifecycle management**

## Performance

- **Duration:** 3 min
- **Started:** 2026-02-22T01:30:59Z
- **Completed:** 2026-02-22T01:33:38Z
- **Tasks:** 2
- **Files modified:** 4

## Accomplishments

- Mesh URL resolver probes localhost:3000/health with 1s timeout, falls back to studio.decocms.com, respects --mesh-url override — no caching per user decision
- Mesh auth module implements browser OAuth flow (local callback server on random port), creates persistent API key via /api/auth/api-key/create, stores per-Mesh-URL tokens in system keychain (security/secret-tool) with file fallback; 120s auth timeout
- MCP client factory creates StreamableHTTPClientTransport to /mcp/self with Bearer auth; callMeshTool() extracts and JSON-parses text content; getOrganizationId() resolves active org from session or org list
- local-dev manager: probeLocalDev() hits /_ready with 500ms AbortSignal timeout; startLocalDev() spawns mcp-local-dev and polls /_ready up to 10s; returns null if already running; stopLocalDev() sends SIGTERM

## Task Commits

Each task was committed atomically:

1. **Task 1: Mesh URL resolver and auth module** - `2ddd6f200` (feat)
2. **Task 2: MCP client factory and local-dev manager** - `eab3f95cc` (feat)

## Files Created/Modified

- `packages/cli/src/lib/mesh-url.ts` - resolveMeshUrl() with localhost probe and cloud fallback
- `packages/cli/src/lib/mesh-auth.ts` - ensureMeshAuth(), readMeshToken(), saveMeshToken() with browser OAuth flow
- `packages/cli/src/lib/mesh-client.ts` - createMeshSelfClient(), callMeshTool(), getOrganizationId()
- `packages/cli/src/lib/local-dev-manager.ts` - probeLocalDev(), startLocalDev(), stopLocalDev()

## Decisions Made

- System keychain via `execSync` with platform CLIs (security on macOS, secret-tool on Linux, file fallback on Windows) — no native addon, no new dependencies
- Windows uses `~/.deco_mesh_tokens.json` file fallback since `cmdkey` read is unreliable for secrets
- `startLocalDev()` returns `ChildProcess | null` where null means daemon was already running — caller (link command) treats null as "no child to manage on shutdown"
- `getOrganizationId()` tries both `/api/auth/get-session` (Better Auth standard) and `/api/auth/organization/list` to be resilient to API shape differences
- OAuth callback handles both cookie-based sessions (standard redirect) and token query param (alternative strategy) to be robust against Mesh login page implementation details

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

None.

## User Setup Required

None - no external service configuration required.

## Next Phase Readiness

All four foundation modules ready for Plan 02 (link command) to compose:
- `resolveMeshUrl` — URL detection with override support
- `ensureMeshAuth` — returns API key, handles first-run OAuth automatically
- `createMeshSelfClient` / `callMeshTool` — ready for COLLECTION_CONNECTIONS_CREATE, PROJECT_CREATE calls
- `probeLocalDev` / `startLocalDev` / `stopLocalDev` — daemon lifecycle ready

No blockers.

---
*Phase: 18-deco-link-command*
*Completed: 2026-02-22*
