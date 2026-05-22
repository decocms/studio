# Sandbox/Link/Dispatch Naming Uniformization

**Status:** Draft for review
**Owner:** @tlgimenes
**Date:** 2026-05-22

## Summary

The sandbox subsystem has accumulated naming inconsistencies across four overlapping nouns (`sandbox`, `vm`, `runner`, `provider`), vendor-specific kind values (`docker`, `agent-sandbox`, `desktop`), and a dispatch-target taxonomy whose values mix execution location with transport (`local`, `remote-cli`). This spec uniformizes the surface around a single canonical taxonomy, renames the three provider kinds to a coherent location/role-flavored set, and cleans up downstream knock-on names (env var, error codes, daemon routes, MCP tool names, files).

The work is one pass; tolerant readers for legacy values are dropped in the same migration.

## Goals

1. One canonical noun for the resource (`Sandbox`), one for the abstraction (`SandboxProvider`). Eliminate `VM` and `Runner` as synonyms.
2. A coherent `SandboxProviderKind` enum with no vendor names.
3. A `DispatchTarget` shape whose discriminants describe *what they actually mean*, with errors split out.
4. Error codes that name the actor and the service (`user_desktop_link_*`).
5. Daemon protocol routes that aren't named after a harness.
6. Public MCP tool names matching the canonical noun (`SANDBOX_START`, `SANDBOX_DELETE`).
7. All persisted rows migrated to the new vocabulary in a single Kysely migration; legacy tolerant readers removed.

## Non-Goals

- **Env-var prefix normalization.** `STUDIO_*` vs `DECOCMS_*` vs `DECO_*` is a separate spec covering all env vars, helm charts, ops docs. This spec only renames `STUDIO_SANDBOX_RUNNER` → `STUDIO_SANDBOX_PROVIDER` (same prefix, fixes the offending noun).
- **`LinkRegistry`/`LinkEntry`/`deco link` rename.** `Link` is kept as the distinct noun for the active HMAC-tunneled connection between cluster and a user-desktop daemon. Only error codes reference the user-desktop link explicitly.
- **Cluster-side `apps/mesh/src/sandbox/lifecycle.ts` rename.** "Lifecycle" is fine; it doesn't claim to be a provider.
- **`packages/sandbox/daemon/` rename.** Within the `packages/sandbox/` package, `daemon` reads clearly.
- **Re-architecting dispatch.** Naming only; behavior unchanged.

## Canonical Taxonomy

Two anchor nouns:

| Noun | Meaning |
|---|---|
| `Sandbox` | The resource — a running container/pod/process executing user code. May be currently running or just a persisted record. |
| `SandboxProvider` | The interface that provisions and connects to sandboxes. Implementations live behind `SandboxProviderKind`. |

Sub-identifiers (kept):

| Name | Meaning |
|---|---|
| `SandboxId` | The `(userId, projectRef)` tuple. Unchanged. |
| `sandboxHandle` | Opaque per-`(SandboxId, branch, kind)` string returned by a provider's `ensure()`. Replaces all uses of `handle` and `vmId`. |

Eliminated synonyms:

| Old | New | Where |
|---|---|---|
| `VM` | `Sandbox` | All sites (types, files, functions, tool names, comments). |
| `Runner` | `SandboxProvider` (interface) or implementation-specific name | Env var, comments. |
| `vmId` | `sandboxHandle` | `setVmMapEntry`, `vmMap` keys, type fields. |
| `handle` (when used loosely) | `sandboxHandle` | Provider call sites where the noun was ambiguous. |

Retained distinct nouns (intentional):

- **`Link`** — the active, HMAC-authenticated, registered tunnel between cluster and a user-desktop daemon. A `user-desktop` provider call requires a live `Link`. `LinkRegistry`/`LinkEntry`/`deco link` stay.
- **`Harness`** — the agent runtime (`decopilot` / `claude-code` / `codex`). Orthogonal to sandbox kind. Unchanged.

## SandboxProviderKind

```ts
type SandboxProviderKind = "local-docker" | "cluster" | "user-desktop";
```

| Old value | New value | Rationale |
|---|---|---|
| `"docker"` | `"local-docker"` | Symmetry with `user-desktop`; clarifies it's the local-container backend. |
| `"agent-sandbox"` | `"cluster"` | Removes Anthropic vendor name; implementation-agnostic if the cluster swaps the underlying sandbox runtime. |
| `"desktop"` | `"user-desktop"` | Clarifies "the user's desktop," not e.g. a desktop pod in the cluster. |

The default resolution from env when `STUDIO_SANDBOX_PROVIDER` is unset becomes `"user-desktop"` (was `"desktop"`).

## DispatchTarget

Today:

```ts
type DispatchTarget =
  | { kind: "error"; reason: "link_offline" | "capability_missing"; activeCapabilities?: string[] }
  | { kind: "local"; sandbox: "default" | "desktop"; link?: LinkEntry }
  | { kind: "remote-cli"; link: LinkEntry };
```

After:

```ts
type DispatchTarget =
  | { runsIn: "cluster"; sandbox: SandboxProviderKind; link?: LinkEntry }
  | { runsIn: "user-desktop"; sandbox: "user-desktop"; link: LinkEntry };

type DispatchError =
  | { kind: "user_desktop_link_offline" }
  | { kind: "user_desktop_link_capability_missing"; activeCapabilities: Capability[] };

type ResolveDispatchTargetResult =
  | { ok: true; target: DispatchTarget }
  | { ok: false; error: DispatchError };
```

Key shape changes:

- Discriminant on the *success* shape is `runsIn` (not `kind`), avoiding overload with `Harness.kind` / `DispatchError.kind`.
- `sandbox` field uses the canonical `SandboxProviderKind` enum (no more `"default"`).
- Error is a separate return type — callers no longer discriminate three things at once.
- The previous `"local" + sandbox: "default"` collapses into `runsIn: "cluster"` with `sandbox` carrying the resolved kind.

Behavior is unchanged. `resolveDispatchTarget` still returns errors for offline/missing-capability cases; consumers (POST /messages, dispatch-run) update to the new shape but make the same decisions.

## Daemon Protocol Routes

Today the user-desktop daemon serves harness-named routes. They become harness-agnostic.

| Old | New |
|---|---|
| `POST /_decopilot_vm/dispatch` | `POST /_sandbox/dispatch` |
| `DELETE /_decopilot_vm/runs/<runId>` | `DELETE /_sandbox/runs/<runId>` |
| `POST /api/sandboxes` | unchanged |

**Compat strategy:** the daemon dual-serves both prefixes for one release. The cluster speaks only the new prefix from day one. The next-next release removes the old handlers from the daemon. This avoids breaking pinned/firewalled daemons during the transition.

## URL Fields

| Field | Carrier | Old name | New name | Meaning |
|---|---|---|---|---|
| Per-link daemon tunnel | `LinkEntry.tunnelUrl` | `tunnelUrl` | `tunnelUrl` (unchanged) | `https://<machineId>.deco.host` or `http://127.0.0.1:<port>` |
| Per-sandbox control plane | Daemon's `POST /api/sandboxes` response | `sandboxUrl` | `sandboxApiUrl` | Base URL where `/_sandbox/*` routes live (`https://<handle>.deco.host` in prod) |
| Per-sandbox preview | Sandbox provider record | `previewUrl` | `previewUrl` (unchanged) | Where the user's dev server serves their app |

Only `sandboxUrl` → `sandboxApiUrl` changes. The rename removes the ambiguity between "URL of the sandbox" (preview or API?) — `sandboxApiUrl` is unambiguously the control-plane URL.

## MCP Tool Surface

| Old | New |
|---|---|
| `VM_START` | `SANDBOX_START` |
| `VM_DELETE` | `SANDBOX_DELETE` |

**Hard cutover.** No deprecated alias tools. The studio UI is the dominant caller; any agent configurations that name `VM_START`/`VM_DELETE` directly are migrated by the DB migration (see below).

## Env Var

| Old | New |
|---|---|
| `STUDIO_SANDBOX_RUNNER` | `STUDIO_SANDBOX_PROVIDER` |

Cluster helm chart, dev defaults, `.env.example` files, README mentions, and the resolver in `packages/sandbox/server/provider/index.ts` all update. No deprecated-alias read of `STUDIO_SANDBOX_RUNNER` — the deploy bump is atomic with the code rollout.

## Error Codes

| Old | New |
|---|---|
| `"link_offline"` | `"user_desktop_link_offline"` |
| `"capability_missing"` | `"user_desktop_link_capability_missing"` |

Error-code consumers: `POST /messages` (translates to 409 status), `LinkOfflineError`, tests. All callsites updated.

## Data Migration

One Kysely migration sweeps three persisted surfaces in one transaction:

1. **`virtualmcp.metadata.vmMap` → `virtualmcp.metadata.sandboxMap`.** Key rename at the top level.
2. **Value rewrite inside each cell:**
   - `"docker"` → `"local-docker"`
   - `"agent-sandbox"` → `"cluster"`
   - `"desktop"` → `"user-desktop"`
   - Legacy `"remote-user"` → `"user-desktop"` (was already aliased)
   - Legacy `"host"`, `"freestyle"` → cell dropped (see note below)
3. **`sandbox_runner_state` table:** values in the `sandbox_provider_kind` column rewritten with the same mapping. Column name already correct (renamed in migration 085).
4. **Stored agent configurations** (e.g. tool allowlists, agent prompts) that reference the public MCP tool names: `"VM_START"` → `"SANDBOX_START"`, `"VM_DELETE"` → `"SANDBOX_DELETE"`. The migration enumerates the JSON columns that can hold tool-name strings (`virtualmcp.metadata`, `agent.config`, and any audit-log payloads with stored tool names) and rewrites them. Locations are verified during plan-writing.

Legacy `"host"` and `"freestyle"` map cells are dropped (the cell within a `sandboxMap` blob is removed); the surrounding `virtualmcp` row is preserved. These kinds have no live code path; any provisioning state they held was already unreachable.

Tolerant readers in the mesh-sdk (`packages/mesh-sdk/src/types/virtual-mcp.ts`) for `"remote-user"`, `"host"`, `"freestyle"`, and `runnerKind` are removed in the same PR — every row has been rewritten by the migration, so they're unreachable.

`runnerKind` SDK normalizer is removed (was already on TTL per migration 085 comment).

## File and Directory Renames

Mesh tools:

| Old | New |
|---|---|
| `apps/mesh/src/tools/vm/` | `apps/mesh/src/tools/sandbox/` |
| `apps/mesh/src/tools/vm/start.ts` | `apps/mesh/src/tools/sandbox/start.ts` |
| `apps/mesh/src/tools/vm/stop.ts` (file/tool name mismatch fixed) | `apps/mesh/src/tools/sandbox/delete.ts` |
| `apps/mesh/src/tools/vm/vm-map.ts` | `apps/mesh/src/tools/sandbox/sandbox-map.ts` |
| `apps/mesh/src/tools/vm/vm-map.test.ts` | `apps/mesh/src/tools/sandbox/sandbox-map.test.ts` |
| `apps/mesh/src/tools/vm/start.test.ts` | `apps/mesh/src/tools/sandbox/start.test.ts` |
| `apps/mesh/src/tools/vm/stop.test.ts` | `apps/mesh/src/tools/sandbox/delete.test.ts` |

Link daemon:

| Old | New |
|---|---|
| `apps/mesh/src/link-daemon/sandbox-provider.ts` | `apps/mesh/src/link-daemon/user-desktop-provider.ts` |
| `apps/mesh/src/link-daemon/sandbox-provider.test.ts` | `apps/mesh/src/link-daemon/user-desktop-provider.test.ts` |

Web UI:

| Old | New |
|---|---|
| `apps/mesh/src/web/components/vm/` | `apps/mesh/src/web/components/sandbox/` (full subtree) |
| `apps/mesh/src/api/routes/vm-proxy.ts` | `apps/mesh/src/api/routes/sandbox-proxy.ts` |
| `apps/mesh/src/api/routes/vm-events-handler.ts` | `apps/mesh/src/api/routes/sandbox-events-handler.ts` |

(`<dataDir>/sandboxes/` already correct after f150f5016; no change.)

## Function and Type Renames

| Old | New |
|---|---|
| `ensureVm()` | `ensureSandbox()` |
| `readVmMap()` | `readSandboxMap()` |
| `setVmMapEntry()` | `setSandboxMapEntry()` |
| `VmMapEntry` | `SandboxRecord` |
| `vmId` field | `sandboxHandle` field |
| `handle` variable (when ambiguous) | `sandboxHandle` |

UI query keys, hook names (`useVmStart` → `useSandboxStart`), context (`VmEventsContext` → `SandboxEventsContext`) follow the same rename.

## Comments and Documentation

Every doc comment that uses "VM," "runner," or "vm" referring to the sandbox is updated. Notably:

- `apps/mesh/src/sandbox/resolve-provider.ts` header comment — `VM_START` references become `SANDBOX_START`.
- `packages/sandbox/README.md` — `STUDIO_SANDBOX_RUNNER` references become `STUDIO_SANDBOX_PROVIDER`.
- `deploy/helm/sandbox-env/README.md` — env var, helm values name (if applicable).

## Compat & Rollout Plan

The rollout is intentionally aggressive — one PR, hard cutover for all surfaces except the daemon protocol prefix.

| Surface | Strategy |
|---|---|
| Internal types/functions/files | Hard cutover; updated in the same PR. |
| MCP tool names | Hard cutover. Studio UI updated; DB migration rewrites stored references. |
| Env var | Hard cutover; helm + deploy bump atomic with code. |
| DB schema (values + key) | Single Kysely migration runs on deploy; tolerant readers removed in same PR. |
| Daemon route prefix | **Daemon dual-serves both prefixes for one release.** Cluster speaks new prefix only. Old prefix removed in next-next release. |
| Error codes | Hard cutover. Consumers updated in same PR. |

A follow-up PR (one release later) removes the daemon's old-prefix handlers.

## Risks

1. **Daemon protocol skew.** Users with auto-update disabled and a daemon pinned to a pre-rename version will lose dispatch until they update. Dual-serve buys one release of headroom; users still on old daemons after that fail loudly with a clear error.
2. **Stored agent configs referencing `VM_START`/`VM_DELETE`.** The DB migration sweeps `virtualmcp.metadata` blobs and rewrites tool-name references; PR review must confirm the migration covers every place the tool name is persisted (agent prompts, tool allowlists, audit logs).
3. **Test churn.** ~50 files reference the affected names. Mostly mechanical, but the migration tests (087, 089) and the resolve-provider tests carry kind-value strings inline — easy to miss with a global find/replace.
4. **External callers via SSE / MCP.** Any external consumer using the old tool names is broken at deploy time. No third-party callers identified today; PR description should call this out.

## Out of Scope (Explicit)

- Renaming `STUDIO_*` env-var prefix family.
- Renaming `Link*` types or `deco link` CLI.
- Renaming `cluster-side` `apps/mesh/src/sandbox/lifecycle.ts`.
- Renaming `packages/sandbox/daemon/`.
- Refactoring `DispatchTarget` semantics beyond field/value rename.
- Renaming `Harness` (it's a coherent existing concept).
- Re-keying `SandboxId` (the `(userId, projectRef)` tuple).

## Acceptance

- `bun run check` clean.
- `bun test` clean (every test file under the renamed paths still runs and passes).
- `bun run lint` clean.
- The DB migration test asserts: legacy values absent post-migration, key rename complete, no orphan blobs.
- Manual: a `bunx decocms@latest` dev session starts and the studio UI can `SANDBOX_START` a sandbox end-to-end.
- Manual: an existing user-desktop daemon pinned to the previous version still serves dispatch via the old `/_decopilot_vm/*` prefix (dual-serve check).
