# Feature Release Channel — Design

**Date:** 2026-05-26
**Status:** Approved for planning

## Goal

Give Studio a lightweight, client-side mechanism for announcing new features to users. The system surfaces release announcements through two coordinated UIs — a corner floating card for the latest unseen release, and a chronological inbox popover that also hosts existing organization invitations — and remembers what each browser profile has already seen so users are not shown the same release twice.

## Non-goals

- Server-driven, personalized, or A/B-targeted releases.
- Per-user persistence across browsers or devices.
- Push or OS-level notifications.
- Filtering, search, or category tabs in the inbox.
- Marking releases seen merely by opening the inbox popover.
- Migrating invitations storage or notification delivery.

## Architecture

A single client-side feed source (`RELEASES`) drives two UI surfaces (inbox popover and floating card) and a single seen-state store (localStorage). Invitations come from the existing BetterAuth `useListUserInvitations()` hook and are merged into the inbox view at render time. No server changes; no new database state; no new MCP tools.

```
RELEASES (TS module)            Invitations (BetterAuth hook)
        │                                │
        ▼                                ▼
useReleaseSeenState()  ──────►  useInboxFeed()  ──────►  Inbox popover
        │                                                  (sidebar footer)
        ▼
FloatingReleaseCard
(authenticated shell, bottom-right)

Storage: localStorage["studio.release-feed.v1"] = { [releaseId]: { seenAt } }
```

## Data model

Release entries live in a typed TS module checked into the repo. Adding a release = open a PR with one new entry at the top of the array.

```ts
// apps/mesh/src/web/lib/release-feed.ts
import type { ComponentType } from "react";

export interface ReleaseBullet {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
}

export interface Release {
  id: string;              // stable slug, e.g. "composer-2-5"
  date: string;            // ISO date, used for sort and 30-day cutoff
  title: string;           // "Composer 2.5"
  eyebrow?: string;        // "Now Available"
  bullets: ReleaseBullet[];
  cta?: { label: string; href: string };
  learnMoreHref?: string;
}

export const RELEASES: Release[] = [/* newest first */];
```

Design notes:

- No `showAsFloatingCard` flag. The latest entry is always the candidate for the floating card; older entries never float.
- Icons are React components, consistent with the rest of the codebase (`@untitledui/icons`).
- `href` values may be external URLs or in-app routes; the link renderer decides based on prefix.

## Seen-state store

- localStorage key: `studio.release-feed.v1`.
- Value shape: `Record<releaseId, { seenAt: string /* ISO */ }>`.
- Encapsulated by `useReleaseSeenState()`, returning:
  - `isSeen(id: string): boolean`
  - `markSeen(id: string): void`
  - `unseenCount: number` (count of entries in `RELEASES` with no `seenAt`)
- The hook subscribes to the browser `storage` event so multiple tabs converge on the same state without a refresh.
- Not keyed by user. localStorage is per-browser-profile; cross-user contamination on a shared machine is acceptable and not worth additional plumbing.
- Reads/writes are wrapped in try/catch to tolerate environments where localStorage is unavailable (Safari private mode, iframe sandboxes). Failure mode = treat all entries as unseen for the session and skip writes.

## Surface 1 — Inbox popover

Replaces the current invitations-only popover anchored to the sidebar `Inbox01` button.

- Layout: single chronological feed, items sorted by date desc.
- Two row types share the popover:
  - **Release row** — eyebrow + title + bullets + optional CTA + optional Learn More. While `!isSeen(id)`, a small dot is rendered to the left of the title.
  - **Invitation row** — current `InvitationItem`, unchanged (accept/reject buttons + org name).
- Sort key: `release.date` for releases; for invitations, use `invitation.expiresAt - invitationTTL` if available, otherwise `Date.now()` so they sort to the top. Spec leaves the exact field to the implementation since it depends on what BetterAuth exposes — the requirement is that pending invitations are not pushed below old releases.
- Red dot on the inbox button: shown when `unseenReleaseCount + pendingInvitations.length > 0`.
- Opening the inbox does **not** mark releases seen. Only the floating card and direct interaction do.
- The current "No invites pending" empty state is removed. With release history accumulating, the popover is never empty in practice.

## Surface 2 — Floating release card

A fixed-position card in the bottom-right of the authenticated shell.

- Trigger: on shell mount, the latest entry in `RELEASES` is checked. If it has no `seenAt` and `0 <= now - release.date <= 30 days`, the card animates in ~800ms after first paint. Future-dated entries are skipped until their date arrives.
- If multiple unseen releases exist, only the newest one ever floats. Older unseen releases are still visible in the inbox with the "new" dot until the user opens the inbox and interacts (currently, only floating-card interaction or future per-row dismiss would mark them seen; per the inbox rule they stay marked unseen until then).
- Position: `fixed bottom-6 right-6 z-50`, ~360px wide. Inside the authenticated shell, so it never appears on the login screen.
- Dismissal — all three paths call `markSeen(release.id)`:
  1. X button in the card's top-right.
  2. CTA button (also navigates to / opens `cta.href`).
  3. Learn More link (also opens `learnMoreHref` in a new tab).
- No auto-dismiss timeout.
- Mounts once per app load. After dismissal, the card unmounts and does not return in the same session.

### Subtle interaction note

Because opening the inbox does not mark items seen, a user who dismisses the floating card via the X but later opens the inbox will still see the release with a "new" dot until the next app reload. This is acceptable and intentional — the floating card was the announcement; the inbox dot is just a passive indicator. On the next reload, `seenAt` is set so the dot disappears.

## Component layout

```
apps/mesh/src/web/
  lib/release-feed.ts                       // RELEASES + Release type
  hooks/use-release-seen-state.ts           // localStorage hook
  hooks/use-inbox-feed.ts                   // merges releases + invitations
  components/release-channel/
    release-card.tsx                        // shared body: eyebrow, bullets, CTA
    floating-release-card.tsx               // bottom-right wrapper, dismiss logic
    inbox-release-item.tsx                  // inbox-row wrapper around release-card
  components/sidebar/footer/inbox.tsx       // refactored to render useInboxFeed()
```

Mount points:

- `FloatingReleaseCard` is rendered once in the authenticated shell layout, sibling to the existing `<Toaster />` (`apps/mesh/src/web/providers/providers.tsx` or the auth shell — implementation picks the right spot).
- The inbox button and popover stay in `apps/mesh/src/web/components/sidebar/footer/inbox.tsx`.

### Refactor of the existing inbox file

`inbox.tsx` currently mixes `InvitationItem`, `usePendingInvitations`, `InboxButton`, plus unrelated `CreditChip`, `ConnectionsButton`, and `SettingsButton`. The release work touches only the inbox parts. The implementation plan should extract `InvitationItem` and the inbox popover into smaller files alongside the new release components so the popover can host both row types cleanly without growing one file further.

## Error handling and edge cases

- localStorage throws or returns null → treat all entries as unseen for the session, suppress writes, do not crash. Card still appears.
- A release id is removed from `RELEASES` after being marked seen → the seen-state entry is orphaned but harmless. No active cleanup; the storage value will not grow unbounded in practice (releases are added at a slow human cadence).
- A release `date` is in the future → it will appear in the inbox sorted to the top and float once "now" passes the date, since the cutoff is "within the last 30 days." This is intended; PR authors can stage entries.
- Brand-new user, browser has no localStorage entries → they will see the floating card for the latest release on first load. This is the desired behavior; the 30-day cutoff prevents long-archived releases from popping up if the array still contains them.
- User on a shell route that does not mount the floating card host (e.g. invitation acceptance, OAuth flow) → no card shown; will appear on the next regular app load.

## Testing

- Unit tests for `useReleaseSeenState` covering: cold start, mark seen, storage event, localStorage unavailable.
- Unit tests for `useInboxFeed` covering: releases only, invitations only, both, sort order, unseen count.
- A component test for `FloatingReleaseCard` covering: visible when unseen + within window, hidden when seen, hidden when outside the 30-day window, all three dismissal paths call `markSeen`.
- A component test for the inbox popover verifying both row types render and the red dot logic accounts for both sources.

## Rollout

- No feature flag. The first PR ships an empty `RELEASES` array, so the floating card never renders and the inbox behaves exactly as today (red dot driven only by invitations).
- A follow-up PR adds the first real release entry; this is the "go-live" moment for the channel.

## Open follow-ups (intentionally deferred)

- Server-driven feed if/when we want targeting or scheduling beyond what a TS array allows.
- Per-row dismiss in the inbox (also marking that release seen) once we see whether users actually want it.
- A small `pnpm`/`bun` script to scaffold a new release entry, if the cadence picks up.
