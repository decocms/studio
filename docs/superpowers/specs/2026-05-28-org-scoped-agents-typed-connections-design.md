# Org-scoped agents + typed connections

**Date:** 2026-05-28
**Status:** Approved design, ready for implementation planning

## Problem

Two related gaps in the current connection/agent model:

1. **Agents can be private.** Virtual MCPs (agents) are stored as `connections` rows
   with `connection_type = 'VIRTUAL'`. Neither `VirtualMCPStorage.create` nor the
   `COLLECTION_VIRTUAL_MCP_CREATE` handler sets `access`, so agents fall through to the
   `connections.access` DB default of `'user'` (set by migration 097). Agents are meant
   to be org-shared, not private.

2. **Private connections can be hard-bound into agents as concrete children.** A Virtual
   MCP references children either as a **concrete child** (`connection_aggregations.child_connection_id`
   set) or as a **slot** (`slot_app_id` set, resolved per-caller at runtime via
   `resolveSlot`). Nothing validates that a concrete child is org-scoped, so a
   `access='user'` (private) connection can be stored as a concrete child. When another
   caller invokes the agent, a concrete child loads that specific connection regardless of
   caller — leaking one user's private connection to everyone using the agent. Slots, by
   contrast, resolve to *the caller's own* connection of a given `app_id`, which is the
   correct privacy model.

Observed in dev: agent `vir_Q8TV4_kChUMwPOl-b-qUf` (`access='user'`) had the private
GitHub connection `conn_MFlu_m7K5KVc6lq1_bSTO` (`access='user'`, `app_id='deco/mcp-github'`)
as a concrete child.

## Goals

- Agents are **always org-scoped**.
- A **private (`user`) connection can only be attached to an agent as a slot**, never a
  concrete child. Concrete children are reserved for org-scoped connections.
- Make slots usable for *any* connection by giving every connection a stable `app_id`,
  including custom (non-registry) ones — so the "attach as a slot" rule is always actionable.
- **Minimize production disruption.** Existing connections stay functional; the
  private-connection behavior activates only for newly created connections.

## Non-goals

- No bulk rewiring of existing agents from concrete children to slots (unnecessary once all
  existing connections are org-scoped — see Migration).
- UI changes to the agent editor (routing new private connections into `slots[]`) are a
  downstream follow-up, not part of this spec.

## Background: current model

- `connections.access`: `'user' | 'org'`. DB default `'user'` (private-by-default,
  migration 097). Pre-097 rows were backfilled to `'org'`.
- `connections.app_id`: nullable. Set **only** for registry-installed apps (e.g.
  `deco/mcp-github`). NULL for custom/manual connections (user-pasted HTTP/SSE/Websocket
  URL or STDIO/NPX command), default org connections, deco.cx imports, and VIRTUAL agents.
- `connection_aggregations`: XOR between `child_connection_id` (concrete child) and
  `slot_app_id` (slot), enforced by DB CHECK.
- `idx_connections_user_app_unique`: partial unique index on
  `(organization_id, created_by, app_id) WHERE access='user' AND app_id IS NOT NULL`.
- `idx_conn_agg_slot_unique`: partial unique index on
  `(parent_connection_id, slot_app_id) WHERE slot_app_id IS NOT NULL` (one slot per agent
  per app).
- `resolveSlot` (`apps/mesh/src/core/slot-resolver.ts`): given `(org, invokerUserId, appId)`,
  returns the caller's connection of that `app_id` — `access='user' AND created_by=invoker`
  preferred, `access='org'` fallback.

## Design

### 1. `deriveAppId(connection)` helper

A pure helper that produces a stable, deterministic `app_id` so that **the same service
yields the same `app_id`** (which is what lets a slot resolve per-caller across users).

- **Registry apps** — `app_id` already set and does **not** start with a synthetic prefix →
  returned unchanged. Registry ids are never overwritten.
- **VIRTUAL** connections (agents) → `null`. Agents are never a child / slot target.
- **URL-based** (`HTTP` / `SSE` / `Websocket`) → canonicalize `connection_url`, then
  `url:<host><path>`:
  - lowercase scheme + host
  - strip default port (`:80` for http, `:443` for https)
  - strip trailing slash
  - **drop the querystring**
  - **keep the path** (`/tenant-a/mcp` and `/tenant-b/mcp` are distinct services)
  - example: `https://API.Example.com:443/mcp/?token=abc` → `url:api.example.com/mcp`
- **STDIO / NPX** (no URL; command in `connection_headers.command`, args, or npx package) →
  `stdio:<slug(command + args)>`, or `npx:<package-name>` for the NPX variant. Args are
  included by default (they often encode which server is launched).

The `url:` / `stdio:` / `npx:` prefix doubles as the **"synthetic" marker** — it lets
create/update distinguish a derived id (safe to re-derive) from a real registry id (never
touch).

### 2. Fill `app_id` on connection create/update (storage choke point)

Apply `deriveAppId` in `ConnectionStorage.create` and `ConnectionStorage.update`
(`apps/mesh/src/storage/connection.ts`), **not** in the connection tool handlers — because
import / OAuth / org-seeding / deco.cx flows call storage directly and bypass the tools,
and they should get `app_id`s too.

- **create**: if the derived id is non-null and the incoming `app_id` is null, set it.
- **update**: re-derive only when the current `app_id` is null **or** starts with a
  synthetic prefix (`url:` / `stdio:` / `npx:`); never re-derive a real registry `app_id`.
  Hook into the existing `update` branch that already reloads `existing` when
  `connection_url` / `title` / `app_name` change.

### 3. Agents are always org-scoped

`VirtualMCPStorage.create` (`apps/mesh/src/storage/virtual.ts`) sets `access: 'org'`
explicitly on the inserted VIRTUAL row. This is required because the DB default for new
rows is `'user'`. `access` is not an input on the agent create/update schema — it is a
constant for VIRTUAL connections.

### 4. Reject private connections as concrete children

In `COLLECTION_VIRTUAL_MCP_CREATE` and `COLLECTION_VIRTUAL_MCP_UPDATE` (via a shared helper),
load each entry of the incoming `connections` (concrete-children) array and reject any whose
`access === 'user'` with a clear error, e.g.:

> Connection `<id>` is private and cannot be added as a concrete child. Attach it as a slot
> using its `app_id` instead.

Org-scoped connections remain valid concrete children. Slots are unaffected. This rule is
vacuously satisfied by all existing data after the migration (everything is org).

### 5. One private connection per service per user

The existing `idx_connections_user_app_unique` index now meaningfully enforces "one private
connection per service per user": a second `access='user'` connection deriving the same
`app_id` is rejected at create/update. Surface this as a friendly validation error rather
than a raw DB constraint failure.

### Migration (one-time, migration 098)

Runs in order:

1. `UPDATE connections SET access = 'org' WHERE access = 'user'` — resets all current
   connections (including existing agents) to org-scoped. This dissolves the leaky
   concrete-child case in existing data: every existing concrete child becomes org and thus
   rule-conformant.
2. Backfill `app_id = deriveAppId(row)` for every **non-VIRTUAL** row where `app_id IS NULL`.
   **No collision handling needed** — after step 1 every row is `access='org'`, and
   `idx_connections_user_app_unique` only constrains `access='user'` rows, so duplicate
   derived ids among org connections are allowed. VIRTUAL rows are left `null`.
3. **No** concrete→slot conversion of existing agents — unnecessary, since all children are
   now org and therefore valid concrete children.

The DB default for `connections.access` stays `'user'` — new connections remain
private-by-default, so the new behavior rolls out gradually as connections are created.

`deriveAppId` must be importable from both the storage layer and the migration so the logic
is shared (the migration's backfill and the runtime fill use the identical function).

## Net effect

- Existing production is behavior-unchanged: every connection is org-scoped (as it
  effectively was pre-097), API access gating is unchanged, and existing agents keep their
  concrete children.
- The private-connection model activates only for **new** connections: private by default,
  attachable to agents only as slots, one per service per user.
- The original leak is closed structurally: agents are always org, and private connections
  can never be concrete children.

## Affected areas

- `apps/mesh/src/storage/connection.ts` — `create` / `update`, new `deriveAppId`.
- `apps/mesh/src/storage/virtual.ts` — `create` sets `access: 'org'`.
- `apps/mesh/src/tools/virtual/create.ts`, `update.ts` — concrete-child access validation
  (shared helper).
- `apps/mesh/migrations/098-*.ts` — the one-time migration.
- **Follow-up (out of scope):** UI agent editor must route new private connections into
  `slots[]` by `app_id` instead of `connections[]`.

## Testing

- **Unit** (`bun test`): `deriveAppId` canonicalization — host casing, default-port
  stripping, trailing-slash, querystring drop, path retention, STDIO/NPX branches, registry
  passthrough, VIRTUAL → null.
- **E2E** (Playwright): agent created as `access='org'`; create/update fills `app_id` for
  custom connections and re-derives synthetic ids on URL edit but not registry ids;
  `COLLECTION_VIRTUAL_MCP_CREATE/UPDATE` rejects a private connection as a concrete child;
  second private connection to the same service is rejected; migration backfills `app_id`
  and flips access to org.
