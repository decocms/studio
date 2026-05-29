# Registry-aware connect gate with inline connect

**Date:** 2026-05-29
**Status:** Approved design, ready for implementation planning

## Problem

The "Connect to use this agent" gate (`ConnectAgentGate`,
`apps/mesh/src/web/components/chat/connect-agent-gate.tsx`) lists each unresolved slot as a
generic icon (`IntegrationIcon icon={null}`) + the raw `slot_app_id` string (e.g.
`deco/mcp-github`) + a Connect button that deep-links to `/$org/settings/connections`. Two
weaknesses:

1. It shows the raw `app_id` and a generic icon instead of the app's real icon and friendly
   name, so the user can't tell at a glance which integration they need.
2. Connecting kicks the user out of the gate to the Connections page; they have to find the
   app, install it, and come back. The gate should let them connect **in place**.

## Goal

Tighten the gate's integration with the registry:

1. **Render the real MCP icon + friendly name** for each unresolved slot, sourced from the
   registry (`COLLECTION_REGISTRY_APP_GET`).
2. **Inline connect** — the Connect button installs/authenticates the app without leaving the
   gate; on success the slot resolves and its row disappears. When the last slot resolves, the
   gate gives way to the agent view.

## Non-goals

- No new install/OAuth logic — inline connect is the existing `handleConnectAndAdd` pipeline
  (`add-connection-dialog.tsx`) factored into a reusable hook.
- Synthetic / non-registry slots (`url:` / `stdio:` / `npx:` from `deriveAppId`, or any
  `app_id` the registry doesn't know) are **not** inline-installable — they keep today's
  generic icon + raw `app_id` + deep-link Connect.
- No auto-firing connect on mount (would surprise the user with an OAuth popup); connect is
  always on click.
- No change to slot detection (`useUnresolvedSlots`) or to where the gate is mounted
  (`AgentInsetProvider`, per the hoist work).

## Background (current code)

- `ConnectAgentGate` receives `{ agentTitle, agentIcon, slots: SlotLike[], orgSlug }` and maps
  `slots` to rows. `SlotLike = { slot_app_id: string }`. It is mounted by `AgentInsetProvider`
  (`apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`) with `slots={unresolved}`.
- `useUnresolvedSlots(orgId, orgSlug, slots)`
  (`apps/mesh/src/web/hooks/use-unresolved-slots.ts`) is a **`useSuspenseQuery`** that resolves
  every slot's `app_id` via `CONNECTION_RESOLVE_FOR_USER` and returns `{ unresolved: T[] }`
  (the slots that didn't resolve). `staleTime: 0` + `refetchOnWindowFocus: "always"` so it
  re-resolves (background, no re-suspend) when the user returns from connecting.
- `useRegistryApp(appId, { enabled })` (`apps/mesh/src/web/hooks/use-registry-app.ts`) calls
  `COLLECTION_REGISTRY_APP_GET` with `{ name: appId }` and returns `RegistryItem | null`
  (5-min stale time). A `RegistryItem` exposes a friendly title (`_meta["mcp.mesh"].friendlyName`
  / `friendly_name` → `server.title` → `title` → `server.name`) and an icon
  (`server.icons[0].src`).
- `extractConnectionData(item, orgId, userId, { remoteIndex })`
  (`apps/mesh/src/web/utils/extract-connection-data.ts`) turns a `RegistryItem` into connection
  create input (`title`, `icon`, `app_id`, `app_name`, `connection_type`, `connection_url`,
  `oauth_config`, …).
- `handleConnectAndAdd(item)` (`add-connection-dialog.tsx`, ~L804-927) is the inline-connect
  pipeline we will factor out: validate connection method → `connectionActions.create` →
  build `mcpProxyUrl` → `isConnectionAuthenticated` → if OAuth needed, `authenticateMcp`
  (popup) → persist token via `POST /api/:org/connections/:id/oauth-token` (fallback to
  `connectionActions.update` with `connection_token`) → invalidate `isMCPAuthenticated`.
- `connectionActions` come from the connections mutation hooks; `org`/`session` from context
  (`useProjectContext` / session). `useRegistryApp` reads `org` from `useProjectContext`
  internally.

## Design

### 1. Display-metadata resolution (suspending, batched)

For each unresolved slot, resolve `{ kind, title, icon, registryItem }` from the registry:

- **Registry app found** → `{ kind: "registry", title: <friendly title>, icon:
  server.icons[0].src ?? null, registryItem }`.
- **Not found** (`null` — synthetic id or unknown app) → `{ kind: "fallback", title:
  slot_app_id, icon: null, registryItem: null }`.

This lookup **suspends** so the gate appears fully-formed (icons, names, buttons all settled)
with no progressive text→name / generic→icon swap — consistent with the no-flash decision that
made `useUnresolvedSlots` a suspense query.

Implementation: a new hook `useSlotAppDisplays(slots)` that batches one
`COLLECTION_REGISTRY_APP_GET` per `slot_app_id` (Promise.all in a single `useSuspenseQuery`,
mirroring the structure of `useUnresolvedSlots`), returning
`Record<slot_app_id, { kind, title, icon }>`. Batching into one suspense query (rather than
calling `useRegistryApp` per row) keeps the hook count stable and lets the whole gate settle
in one boundary. A pure helper `slotAppDisplay(slotAppId, registryItem | null)` does the
RegistryItem → `{ kind, title, icon }` mapping and is unit-tested.

### 2. `useConnectApp` — generalized inline connect

Factor the `handleConnectAndAdd` body into a reusable hook in
`apps/mesh/src/web/hooks/use-connect-app.ts`:

```ts
function useConnectApp(): {
  connect: (item: RegistryItem) => Promise<void>;
  status: "idle" | "connecting" | "authenticating" | "ready" | "error";
  error: string | null;
};
```

Pipeline (unchanged from `handleConnectAndAdd`, minus the agent-attach `onAdd` step — the gate
doesn't attach anything; the connection just needs to *exist and resolve* for the slot):

1. `extractConnectionData(item, org.id, session.user.id, { remoteIndex: 0 })`; reject if no
   URL and no STDIO command (`status: "error"`).
2. `connectionActions.create.mutateAsync(...)` → `id` (`status: "connecting"`).
3. `isConnectionAuthenticated`; if `supportsOAuth && !isAuthenticated` →
   `authenticateMcp({ connectionId: id, orgSlug, scope: "offline_access" })`
   (`status: "authenticating"`). On OAuth failure, surface `error` (the connection still
   exists but unauthenticated; do **not** auto-delete — keep parity with `handleConnectAndAdd`,
   which leaves it and warns).
4. Persist token (`POST .../oauth-token`, fallback to `update` with `connection_token`).
5. **Invalidate so the gate re-resolves**: `KEYS.unresolvedSlots(...)` (the gate's resolve
   query) and the connections list, plus `KEYS.isMCPAuthenticated(...)`. The refetch is a
   background refetch on the suspense query → no re-suspend / no full-gate flash; the resolved
   row simply drops.

`add-connection-dialog.tsx`'s `handleConnectAndAdd` is refactored to call this hook (keeping
its extra `onAdd`/tracking around the shared core) so there's a single inline-connect
implementation rather than a copy.

> Note on the resolve key: the gate's resolve query is keyed
> `KEYS.unresolvedSlots(orgId, sortedAppIds)`. After connecting, invalidating that exact key
> (the gate's mounted instance) triggers the background re-resolve. If invalidating by the full
> key is awkward from the hook, invalidate the `unresolvedSlots` key prefix so any mounted gate
> re-resolves. (Pin the exact invalidation target during planning against `KEYS`.)

### 3. Gate row rendering

Extract a `ConnectSlotRow` component (one per slot) so each row owns its own `useConnectApp`
state without hooks-in-a-loop. `ConnectAgentGate` maps `slots` → `<ConnectSlotRow slot={slot}
display={displays[slot.slot_app_id]} orgSlug={orgSlug} />`.

Row behavior by `display.kind`:

- **`registry`** — real `icon` + friendly `title`. Connect button calls
  `connect(display.registryItem)` on click:
  - `idle` → `[ Connect ]`
  - `connecting` → `[ Connecting… ]` (disabled, spinner)
  - `authenticating` → `[ Authenticating… ]` (disabled, spinner)
  - `error` → inline error text (e.g. "Couldn't connect") + `[ Try again ]`
  - on success the slot resolves and the row disappears (gate re-resolves).
  Rows are independent — one can be connecting while another is idle.
- **`fallback`** — generic icon (`IntegrationIcon icon={null}`) + raw `slot_app_id` + the
  current deep-link Connect (`Link to="/$org/settings/connections"`). Unchanged behavior.

```
┌──────────────────────────────────────────────────────────┐
│        🔌  Connect to use this agent                        │
│   "storefront" needs your personal connections to run.     │
│                                                            │
│   🐙  GitHub                              [ Connect ]      │  registry: real icon+name, inline connect
│   🟦  Linear                           [ Connecting… ]     │  in-flight: spinner + label
│   🟥  Sentry        couldn't connect      [ Try again ]    │  error: inline message + retry
│   ▢  url:api.acme.com/mcp                 [ Connect ]      │  fallback: generic icon, raw id, deep-link
└──────────────────────────────────────────────────────────┘
```

### Component locations

- `useSlotAppDisplays` → `apps/mesh/src/web/hooks/use-slot-app-displays.ts`; pure helper
  `slotAppDisplay` → co-located (e.g. `apps/mesh/src/web/hooks/slot-app-display.ts`) with a
  `*.test.ts`.
- `useConnectApp` → `apps/mesh/src/web/hooks/use-connect-app.ts`.
- `ConnectSlotRow` → co-located with `ConnectAgentGate` (same `components/chat/` dir, or a new
  file beside it). `ConnectAgentGate` stays where it is.

## Edge cases

- Slot whose registry lookup returns `null` → `fallback` row (deep-link), never an inline
  connect attempt.
- OAuth popup blocked / cancelled → `status: "error"`, inline "Try again"; the orphaned
  connection is left (parity with `handleConnectAndAdd`), and a subsequent retry reuses the
  normal create/auth path (a duplicate private connection to the same service would hit the
  per-service uniqueness rule — surfaced as the row error).
- Connecting one slot must not re-suspend the whole gate: invalidation triggers a **background**
  refetch of the (already-loaded) suspense queries, so only the resolved row drops.
- Agent with mixed registry + fallback slots → rows render independently by kind.
- Registry temporarily unreachable → the metadata suspense query errors to the surrounding
  boundary (same boundary `useVirtualMCP` / `useUnresolvedSlots` already use). Acceptable; the
  registry is a reliable org connection.

## Testing

- **Unit:** `slotAppDisplay(slotAppId, registryItem | null)` → asserts the registry-found case
  (friendly title precedence + icon) and the `null` → fallback case (raw `app_id`, null icon).
- **Manual / E2E:**
  - Open a GitHub-imported agent as a user without GitHub connected → gate shows the **GitHub
    icon + "GitHub"** (not `deco/mcp-github`) and an inline `[ Connect ]`.
  - Click Connect → OAuth popup → on return the row clears; when it was the only slot, the agent
    view appears. No full-gate flash.
  - A second member who already has GitHub → no gate (resolved).
  - An agent with a synthetic-`app_id` slot → fallback row (raw id + deep-link), unchanged.
</content>
