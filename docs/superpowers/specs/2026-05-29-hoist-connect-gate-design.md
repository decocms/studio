# Hoist the "connect to use this agent" gate to the whole agent view

**Date:** 2026-05-29
**Status:** Approved design, ready for implementation planning

## Problem

The connect gate (shown when the current user is missing an agent's required personal
connections / typed slots) currently lives only in the chat panel (`side-panel-chat.tsx`).
Navigating to the other agent tabs — preview, settings, automations — bypasses it: preview
hits the same raw `SlotUnresolvedError`, and the experience is inconsistent. The gate should
be the single "connect first" wall for the whole agent, placed above the tab/panel rendering.

## Goal

Hoist the gate to the agent-view container so that, when the current user has any unresolved
slot for the agent, the **entire agent view** (tab bar, all main tabs, and the chat panel) is
replaced by the connect gate. The gate becomes the one place to connect. This applies to
**everyone, including the agent owner** ("connect to the agent beforehand").

A consequence: the settings tab is then only reachable when all slots resolve, so the
settings-tab slot rows no longer need a Connect button.

## Non-goals

- Inline/in-place connect inside the gate — still deep-links to the Connections page (a
  future enhancement).
- Owner exemption — the owner is gated like everyone else.
- Per-tab gating — it's a single top-level wall (Option A), not run-surface-only gating.

## Background (current code)

- `AgentInsetProvider` (`apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`) is the
  agent-view container. It reads `virtualmcpid` from the route search params and already
  calls `entity = useVirtualMCP(virtualMcpId)` (a Suspense query; `entity` has `.slots`,
  `.title`, `.icon`). It renders the toolbar, the tab bar (`MainPanelTabsBar`), the main tab
  content (`MainPanelContent` → preview/settings/automations/git), and the chat panel
  (`ChatMainPanelGroup`), in both a desktop and a mobile layout branch.
- `useUnresolvedSlots(orgId, orgSlug, slots)` (`apps/mesh/src/web/hooks/use-unresolved-slots.ts`)
  returns `{ unresolved, isLoading }`; `refetchOnWindowFocus: "always"` so it re-resolves when
  the user returns from connecting.
- `ConnectAgentGate` (`apps/mesh/src/web/components/chat/connect-agent-gate.tsx`) renders the
  panel (agent icon/title + per-slot rows with a Connect deep-link to
  `/$org/settings/connections`).
- The chat-panel gate lives in `ChatPanelContent` (`side-panel-chat.tsx`): a `useUnresolvedSlots`
  call + `showConnectGate` + an early return rendering `ConnectAgentGate`.
- `SlotItem` (`apps/mesh/src/web/views/virtual-mcp/slot-item.tsx`) renders an agent-settings
  slot row: a resolved branch (violet "Personal" chip) and an unresolved branch ("Not
  connected for you" + a Connect button).

## Design

### 1. Gate the whole agent view at `AgentInsetProvider`

After `entity` is fetched and alongside the other hooks (before the desktop/mobile layout
returns, so the check is unconditional and covers both layouts):

```ts
const { unresolved, isLoading: slotsLoading } = useUnresolvedSlots(
  org.id,
  org.slug,
  entity?.slots ?? [],
);
const showConnectGate = !slotsLoading && unresolved.length > 0;
```

Then an early return (before the desktop and mobile layout returns) that fills the agent
inset with only the gate — no toolbar, no tab bar, no chat (a full brick):

```tsx
if (showConnectGate) {
  return (
    <div className="flex-1 min-w-0 flex flex-col">
      <ConnectAgentGate
        agentTitle={entity?.title ?? ""}
        agentIcon={entity?.icon ?? null}
        slots={unresolved}
        orgSlug={org.slug}
      />
    </div>
  );
}
```

The app sidebar (outside the inset) still lets the user navigate away. Agents with no slots
(e.g. the default Decopilot agent → `entity` null or empty slots) never gate.

### 2. Remove the redundant chat-panel gate

In `ChatPanelContent` (`side-panel-chat.tsx`), delete the `useUnresolvedSlots` call, the
`showConnectGate` computation, and the `ConnectAgentGate` early return. The chat panel returns
to its pre-gate behavior — the higher wall supersedes it, so there is no double-gating and no
dead code. Remove the now-unused imports (`useUnresolvedSlots`, and `ConnectAgentGate` if it's
no longer referenced from this file).

### 3. Simplify `SlotItem` — drop the unresolved Connect button

Settings is now reachable only when all slots resolve, so `SlotItem`'s unresolved branch is
effectively unreachable in normal flow. Remove the **Connect** button (and its `Link`) from
the unresolved branch, leaving a minimal no-action "Not connected for you" display as a
defensive fallback (covers the rare race where a connection is deleted while the user is on
settings). The resolved branch (violet "Personal" chip + link to the connection) is unchanged.
Drop any imports that become unused as a result (e.g. `Button`/`Link` only if no longer used
elsewhere in the file — the resolved branch still uses `Link`, so keep that).

### Component location (minor)

`ConnectAgentGate` stays in `apps/mesh/src/web/components/chat/` to minimize churn (only the
import path changes consumer). Moving it to `layouts/agent-shell-layout/` is an optional
follow-up now that chat no longer owns it.

## Edge cases

- Default Decopilot / slotless agent → no gate.
- All slots resolved → no gate; settings shows resolved `SlotItem`s (Personal chip).
- `isLoading` → no gate flash (render the normal view until resolution settles).
- Owner with unresolved slots → gated (must connect before configuring), per Option A.

## Testing

- Existing `unresolvedSlots` unit tests cover detection (unchanged).
- Manual:
  - Agent with an unresolved slot, as a user without the connection → the whole agent view
    (tab bar + preview/settings/automations + chat) is replaced by the connect wall.
  - Connect (deep-link) and return → wall clears (refetch-on-focus), normal view appears.
  - Agent with all slots resolved → normal view; settings shows the `SlotItem` "Personal"
    chip and no Connect button.
  - Slotless agent → normal view, never gated.
