# Render slotted connections in agent settings

**Date:** 2026-05-29
**Status:** Approved design, ready for implementation planning

## Problem

Agents (Virtual MCPs) can now reference connections two ways: as **concrete children**
(`virtualMcp.connections`, a real `connection_id`) or as **typed slots**
(`virtualMcp.slots`, a `slot_app_id` resolved per-caller to that user's own connection of
the matching `app_id`). The agent settings "connections" section
(`apps/mesh/src/web/views/virtual-mcp/index.tsx`, ≈L1743) renders only
`form.watch("connections")` and **never reads `virtualMcp.slots`**. As a result, a
GitHub-imported agent — which now attaches GitHub as a slot (`slot_app_id: "deco/mcp-github"`)
— shows nothing under connections. Users can't see, configure, or remove the slotted
connection.

## Goal

Render slotted connections in the agent settings "connections" section, alongside concrete
connections, with a distinct violet ("slot") visual treatment. Slots should be configurable
(tool/resource/prompt selection) and removable, and should surface a clear "not connected
for you" state for members who lack a matching connection.

## Non-goals

- An inline install/auth flow inside the slot card (the unresolved "Connect" action just
  deep-links to the existing Connections page flow).
- Changing how slots are *created* (the import flow and bulk add-to-agent already create
  slots). This is about rendering/managing existing slots.
- A separate "Typed connections" section — slots interleave in the single Connections list.

## Background (current code)

- Settings connections section: `apps/mesh/src/web/views/virtual-mcp/index.tsx` ≈L1743,
  maps `connections = form.watch("connections")` to a `ConnectionItem` per entry.
- `ConnectionItem` resolves display via `useConnection(connection_id)` (title, icon,
  description, app_name) and renders: clickable body (links to connection detail), footer
  with an instance selector, ⚙ settings, and ✕ remove.
- Slot shape (`packages/mesh-sdk/src/types/virtual-mcp.ts`):
  `{ slot_app_id, selected_tools, selected_resources, selected_prompts }` — **no
  `connection_id`, no embedded title/icon.**
- Per-caller resolution hook exists: `useResolveConnectionForUser(orgId, orgSlug, app_id)`
  → `{ connectionId, access } | null` (wraps `CONNECTION_RESOLVE_FOR_USER`).
- Design tokens: `--special` / `--special-foreground` (violet, hue 290) already exist in
  `packages/ui/src/styles/global.css`. `Badge` (`packages/ui/src/components/badge.tsx`)
  uses a `cva` variant map and can take a new `special` variant.
- `COLLECTION_VIRTUAL_MCP_UPDATE` storage update preserves an omitted `connections`/`slots`
  field (reads a pre-delete snapshot), so writing only `slots` leaves concrete connections
  intact, and vice-versa.

## Design

### Data flow — `SlotItem` component

A new `SlotItem` component (parallel to `ConnectionItem`), one per `virtualMcp.slots` entry,
resolves its own display:

1. `useResolveConnectionForUser(org.id, org.slug, slot.slot_app_id)` → `connectionId | null`.
2. **Resolved** (`connectionId` present): `useConnection(connectionId)` → title/icon/
   description. Render the row identically to a concrete connection, violet-tinted, with a
   `Slot` badge. The clickable body links to the resolved connection's detail page (same
   target as concrete rows).
3. **Unresolved** (`null`): render a violet "not connected for you" card. Title/icon are
   best-effort:
   - If any connection in the org list shares `slot.slot_app_id`, reuse its title/icon.
   - Otherwise fall back to the `slot_app_id` string + a generic slot icon.
   The body is not a link; it shows a `Connect` button that routes to the Connections page
   (the existing install flow).

A small pure helper isolates the non-React decision for testability:

```
slotDisplayState(
  resolvedConnectionId: string | null,
  appIdMatch: { title: string; icon: string | null } | null,
): { state: "resolved" | "unresolved"; title: string; icon: string | null }
```

(The component supplies `appIdMatch` from the org connections list when unresolved; the
helper just picks state + display fields. The resolved title/icon come from `useConnection`.)

### Layout

Slots render in the **same single "Connections" list**, after the concrete connections,
each as a `SlotItem`. No separate section and no empty-state section when an agent has no
slots. Differentiation is purely the violet tint + `Slot` badge.

### Visual treatment

- New `Badge` variant `special`: `border-transparent bg-special text-special-foreground`
  (violet). Label: **"Slot"**.
- Slot card border/bg: `border-special` with a faint `bg-special/5` — mirroring the existing
  `destructive` "needs auth" treatment (`border-destructive/50 bg-destructive/5`) but in
  violet. Concrete rows are unchanged (`border-border`).

### Actions & write semantics

- **⚙ Settings** — opens the existing tool/resource/prompt selection UI, bound to the slot's
  `selected_tools` / `selected_resources` / `selected_prompts`.
- **✕ Remove** — removes the slot from `form` state and persists by sending the updated
  `slots` array via `COLLECTION_VIRTUAL_MCP_UPDATE`. `connections` is left untouched (storage
  preserves the omitted field).
- **Connect** (unresolved only) — routes to the Connections page so the user can install/
  authenticate the app; no inline install flow.
- **No instance selector** on slot rows (slots auto-resolve per user; choosing an instance is
  meaningless).
- The agent settings **form gains `slots`** in its default values and submit payload so slot
  edits (remove, selection) persist. Saving an agent with unchanged slots is safe either way
  (sending the same array, or omitting it and relying on storage preservation).

### Files

- `packages/ui/src/components/badge.tsx` — add `special` variant.
- `apps/mesh/src/web/views/virtual-mcp/index.tsx` — render `slots` after `connections`;
  add `SlotItem`; thread `slots` through form default values + submit payload + remove/
  settings handlers.
- `apps/mesh/src/web/views/virtual-mcp/slot-display.ts` (new) — `slotDisplayState` helper.
- `apps/mesh/src/web/views/virtual-mcp/slot-display.test.ts` (new) — unit tests.

## Edge cases

- Agent with zero slots → nothing extra renders.
- Slot whose `app_id` resolves for the owner but not for another member → owner sees the
  resolved violet row; member sees the unresolved "Connect" violet row.
- Removing the last slot → `slots: []` persisted; concrete connections unaffected.
- A slot and a concrete connection that happen to resolve to the same underlying connection
  → both render (they're distinct aggregation rows); acceptable, not deduped.

## Testing

- **Unit** (`bun test`): `slotDisplayState` — resolved → uses resolved display; unresolved
  with an org `app_id` match → uses that title/icon; unresolved with no match → falls back to
  `slot_app_id` + generic icon.
- **Manual / E2E**: a GitHub-imported agent shows the GitHub slot violet-tinted with the
  `Slot` badge; ⚙ opens tool selection; ✕ removes it and the change persists; a second org
  member viewing the same agent sees the unresolved "Connect" state.
