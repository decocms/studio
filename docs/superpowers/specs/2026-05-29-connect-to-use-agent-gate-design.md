# "Connect to use this agent" gate

**Date:** 2026-05-29
**Status:** Approved design, ready for implementation planning

## Problem

When a user sends a message to an agent (Virtual MCP) whose typed slots don't resolve to
any of the user's connections, agent assembly throws `SlotUnresolvedError`
(`apps/mesh/src/core/slot-resolver.ts`) server-side. By the time it reaches the chat it has
been flattened to a plaintext assistant message and rendered through the generic
`StatusHighlight` "Error occurred" card (`apps/mesh/src/web/components/chat/highlight/index.tsx`),
showing a raw developer message: *"Slot for app_id 'deco/mcp-github' could not be resolved —
the caller has no matching connection."* with a "Fix in chat" button. There is no typed-error
path, and the error only reports the first unresolved slot.

## Goal

Before the run can fail, proactively detect that the current user is missing one or more of
the agent's required (slotted) connections, and render a friendly in-chat gate that tells
them which connections to connect and links them to do so. Disable sending until the slots
are filled, so the raw `SlotUnresolvedError` never surfaces.

## Non-goals

- No server changes (the client computes missing slots directly; we do not plumb the
  structured error to the client).
- No inline connect flow — "Connect" deep-links to the Connections page (consistent with the
  slot card in agent settings).
- No registry-title lookup for slot app_ids — rows show the raw `slot_app_id` (same as the
  unresolved slot card). A prettier name is a later refinement.

## Background (current code)

- `VirtualMCPEntity.slots` is available client-side via `useVirtualMCP(virtualMcpId)`; each
  slot has `slot_app_id` (+ selection fields).
- `useResolveConnectionForUser(orgId, orgSlug, appId)`
  (`apps/mesh/src/web/hooks/use-resolve-connection-for-user.ts`) wraps
  `CONNECTION_RESOLVE_FOR_USER`, returning `{ connectionId: string | null }`; `connectionId
  === null` means the caller has no connection of that `app_id`. Resolution is per-caller.
- The chat composer/message area lives in the chat view; it already has `virtualMcpId` and
  `org` in scope.
- `SlotUnresolvedError` is thrown during `createVirtualClientFrom`
  (`apps/mesh/src/mcp-clients/virtual-mcp/index.ts`) — so *any* message to an agent with an
  unresolved slot fails to assemble; gating send prevents the whole failure.

## Design

### Detection — `useUnresolvedSlots`

A new hook, `useUnresolvedSlots(orgId, orgSlug, slots)`, resolves all of the agent's slots in
a **single** query (a `useQuery` whose `queryFn` runs `CONNECTION_RESOLVE_FOR_USER` for each
`slot_app_id` via `Promise.all`). Returns `{ unresolved: VirtualMCPSlot[], isLoading: boolean }`.

Batching into one hook is required: calling `useResolveConnectionForUser` once per slot in a
loop in the parent would violate the rules of hooks (variable hook count). The query key
includes the sorted list of `slot_app_id`s so it re-runs when the agent's slots change, and
it reuses the same `CONNECTION_RESOLVE_FOR_USER` tool the per-slot hook uses.

The pure decision is extracted for testing:

```
unresolvedSlots(
  slots: { slot_app_id: string }[],
  resolvedByAppId: Record<string, string | null>,
): { slot_app_id: string }[]
```

— returns the slots whose `app_id` mapped to a null/absent connection id.

### Gating

The gate is active when `unresolved.length > 0` (and not `isLoading`). While active:
- The composer is **disabled** (greyed input, placeholder "Connect the required connections
  to start chatting"), so no send is attempted.
- During `isLoading`, do **not** show the gate — render the normal composer (or a brief
  skeleton) so users who *do* have the connection don't see a gate flash.

### Rendering

- **Empty thread (common case):** a full "connect" panel fills the message area:
  ```
  🔌  Connect to use this agent
  "<agent title>" needs your personal connections to run:
    ●  <slot_app_id>     [ Connect ]
    ●  <slot_app_id>     [ Connect ]
  ```
- **Thread with existing messages:** keep the history visible; show a slim inline notice (not
  the full panel) above the disabled composer.
- Each row: the raw `slot_app_id` + a **Connect** button that deep-links to
  `/$org/settings/connections` (`<Link to="/$org/settings/connections" params={{ org: orgSlug }}>`).

### Clearing the gate

`CONNECTION_RESOLVE_FOR_USER` queries refetch on window focus (TanStack Query default). When
the user returns from connecting, the resolve succeeds, `unresolved` empties, the panel
disappears, and the composer re-enables. No manual wiring beyond standard query behavior.

## Edge cases

- Agent with no slots, or all slots resolved → no gate; normal chat.
- Agent with concrete connections **and** unresolved slots → still gated (assembly would fail
  regardless of the concrete ones).
- Per-caller: the agent owner who holds the GitHub connection sees no gate; a teammate
  without it sees the gate.
- `isLoading` → no gate flicker (render normal composer until resolution settles).

## Files (anticipated)

- `apps/mesh/src/web/hooks/use-unresolved-slots.ts` (new) — batched resolution hook +
  `unresolvedSlots` pure helper (or split the helper into its own file).
- `apps/mesh/src/web/hooks/use-unresolved-slots.test.ts` (new) — unit test for the helper.
- A new gate component (e.g. `apps/mesh/src/web/components/chat/connect-agent-gate.tsx`).
- The chat view/composer file — render the gate, disable the composer when active. (Exact
  file identified during planning.)

## Testing

- **Unit**: `unresolvedSlots` — all resolved → `[]`; some null → those slots; empty slots →
  `[]`; app_id missing from the map → treated as unresolved.
- **Manual / E2E**: open a GitHub-imported agent as a user *without* the GitHub connection →
  full panel + disabled composer; connect (deep-link) and return → gate clears, composer
  enables; as the owner → no gate; agent with no slots → no gate.
