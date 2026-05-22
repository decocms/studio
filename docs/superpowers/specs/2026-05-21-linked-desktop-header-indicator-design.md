# Linked Desktop Header Indicator

## Summary

Add a persistent indicator to the org shell header that surfaces whether a
desktop is linked to the current realm. Today, this status is only visible on
the no-AI-provider empty state (`no-ai-provider-empty-state.tsx`), via a
`SettingsCardItem` driven by `useCurrentLink()`. We want the signal in the
header so users can confirm at a glance — from any page — that a desktop is
connected to their realm.

The indicator doubles as a CTA: when no desktop is linked, it invites the user
to connect one by opening the existing `ConnectDesktopDialog`.

## Goals

- Provide an always-visible realm-scoped status for the linked desktop.
- Reuse the existing data layer (`useCurrentLink()`) and dialog
  (`ConnectDesktopDialog`) — no new queries, no new tools.
- Work consistently on every desktop route under `/$org/*` (home + chat).

## Non-goals

- Mobile toolbars (`MobileHomeToolbar`, `MobileToolbar`) — out of scope for v1.
- Replacing or removing the empty-state card in
  `no-ai-provider-empty-state.tsx`. It stays as the contextual onboarding
  affordance.
- Showing capabilities inline in the header — they live in the hover tooltip
  and the existing dialog.

## Design

### Placement

A new element rendered into `Toolbar.LeftColumn` in
`apps/mesh/src/web/layouts/org-shell-layout/index.tsx`, positioned between
`<Toolbar.Nav />` and `<Toolbar.TogglesSlot />`:

```tsx
<Toolbar.LeftColumn>
  <Toolbar.Nav />
  <LinkedDesktopIndicator />
  <Toolbar.TogglesSlot />
</Toolbar.LeftColumn>
```

Because `org-shell-layout` is the parent of both `/$org/` (home) and
`/$org/$taskId` (chat), the indicator appears on every desktop route inside
the org shell without per-route plumbing.

### Component

New file: `apps/mesh/src/web/components/header/linked-desktop-indicator.tsx`.

Renders a button with two visual states:

**Online state**

- Icon: `Monitor01` from `@untitledui/icons` with a small green status dot
  overlaid (e.g. bottom-right `bg-success` 1.5×1.5 circle with ring).
- Label: `"Desktop"` (muted foreground, becomes accent on hover).
- Tooltip on hover: `machineId` (if present) followed by the visible
  capability list from `visibleCapabilities(link.capabilities)`. If no
  capabilities are visible, fall back to `"No CLI agents detected"`.

**Offline state**

- Icon: `Monitor01` with no dot.
- Label: `"Connect desktop"` (rendered slightly more prominent — same size,
  default foreground rather than muted, so it reads as a CTA).
- Tooltip: `"Run \`bunx decocms link\` on your desktop"`.

Click behavior is identical in both states: open `ConnectDesktopDialog`. The
dialog already handles both online and offline content internally.

### Data flow

The component uses the existing `useCurrentLink()` hook
(`apps/mesh/src/web/hooks/use-current-link.ts`):

- Polls every 15s, refetches on window focus.
- Returns `{ online, machineId, cliVersion, capabilities }`.
- Query key is org-scoped via `KEYS.currentLink(org.id)`, so the cache is
  shared across all callers (empty state + header indicator) — no duplicate
  fetches.

Capability labeling reuses the exported `visibleCapabilities()` helper from
`apps/mesh/src/web/components/chat/connect-desktop-dialog.tsx`.

### Dialog reuse

`ConnectDesktopDialog` is the existing dialog already opened from the empty
state. The header indicator opens the same component with the same `open` /
`onOpenChange` contract. No changes to the dialog are required.

### Mobile

Not rendered on mobile in v1. `MobileHomeToolbar` and `MobileToolbar` are
space-constrained and have their own minimal chrome; adding another control
would crowd them. The empty-state card on the home page continues to surface
linking on mobile.

### Empty-state behavior

The `SettingsCardItem` inside `no-ai-provider-empty-state.tsx` remains
unchanged. The header indicator is the realm-wide always-on signal; the
empty-state card is the page-specific onboarding nudge alongside the
`ProviderGrid`. The two are complementary; no deduplication is needed.

## Edge cases

- **Initial fetch:** `useCurrentLink()` returns `OFFLINE` until the first
  query resolves. The indicator briefly shows the "Connect desktop" state on
  first paint, then transitions to "Desktop" once data arrives. This matches
  the current empty-state behavior.
- **Capability list empty when online:** Tooltip shows "No CLI agents
  detected" but the indicator still reads "Desktop" with the green dot — the
  link itself is up, even without CLI agents.
- **Org switch:** Query key includes `org.id`, so switching orgs invalidates
  and refetches automatically.

## Files touched

- **New:** `apps/mesh/src/web/components/header/linked-desktop-indicator.tsx`
- **Edited:** `apps/mesh/src/web/layouts/org-shell-layout/index.tsx` — render
  `<LinkedDesktopIndicator />` inside `Toolbar.LeftColumn`.

## Testing notes

- Manual: with `bun run dev`, verify the indicator appears in the header on
  `/$org/` and `/$org/$taskId`. Run `bunx decocms link` on a desktop and
  confirm the indicator transitions to the online state within ~15s.
- Manual: click the indicator in both states and confirm `ConnectDesktopDialog`
  opens with the matching content.
- Manual: confirm the indicator is absent on mobile viewports.
- No new unit tests are required — the component is a thin presentational
  layer over existing tested primitives (`useCurrentLink`,
  `ConnectDesktopDialog`, `visibleCapabilities`).
