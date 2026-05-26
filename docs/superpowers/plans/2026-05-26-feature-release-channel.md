# Feature Release Channel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a client-side release-announcement channel that floats a bottom-right card for the newest unseen release and renders all releases (mixed chronologically with pending invitations) inside the existing sidebar inbox popover, persisting seen-state in localStorage.

**Architecture:** Single TS module (`RELEASES`) is the feed source. A `useReleaseSeenState` hook tracks `{ [id]: { seenAt } }` in localStorage via the existing `useLocalStorage` primitive. A `useInboxFeed` hook merges releases with pending BetterAuth invitations into one date-sorted list. Two surfaces consume the data: the refactored sidebar inbox popover and a new `<FloatingReleaseCard />` mounted once in the authenticated shell layout.

**Tech Stack:** React 19 (no `useEffect`, no `useMemo`/`useCallback`/`memo`), TanStack Query (via existing `useLocalStorage`), Tailwind v4 design tokens, shadcn `Popover`, `@untitledui/icons`, Bun test + `@testing-library/react` + `happy-dom`.

**Spec:** `docs/superpowers/specs/2026-05-26-feature-release-channel-design.md`.

---

## File Map

**Create:**
- `apps/mesh/src/web/lib/release-feed.ts` — `Release` type and `RELEASES: Release[]` array (initially empty).
- `apps/mesh/src/web/hooks/use-pending-invitations.ts` — extracted hook (currently inline in inbox.tsx).
- `apps/mesh/src/web/hooks/use-release-seen-state.ts` — localStorage-backed seen tracker.
- `apps/mesh/src/web/hooks/use-release-seen-state.test.ts` — unit tests.
- `apps/mesh/src/web/hooks/use-inbox-feed.ts` — merges releases + invitations.
- `apps/mesh/src/web/hooks/use-inbox-feed.test.tsx` — unit tests.
- `apps/mesh/src/web/components/release-channel/release-card.tsx` — shared visual body (eyebrow, bullets, CTA, learn more).
- `apps/mesh/src/web/components/release-channel/inbox-release-item.tsx` — inbox-row wrapper around `ReleaseCard`.
- `apps/mesh/src/web/components/release-channel/floating-release-card.tsx` — bottom-right popover wrapper.
- `apps/mesh/src/web/components/release-channel/floating-release-card.test.tsx` — visibility tests.
- `apps/mesh/src/web/components/sidebar/footer/invitation-item.tsx` — extracted from inbox.tsx.

**Modify:**
- `apps/mesh/src/web/components/sidebar/footer/inbox.tsx` — render the merged feed; red-dot counts unseen + invitations.
- `apps/mesh/src/web/layouts/shell-layout.tsx:271-282` — mount `<FloatingReleaseCard />` after `<Outlet />`.

---

## Task 1: Add release feed module with empty array

**Files:**
- Create: `apps/mesh/src/web/lib/release-feed.ts`

- [ ] **Step 1: Create the file**

```ts
// apps/mesh/src/web/lib/release-feed.ts
import type { ComponentType } from "react";

export interface ReleaseBullet {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  body: string;
}

export interface Release {
  id: string;
  date: string; // ISO date
  title: string;
  eyebrow?: string;
  bullets: ReleaseBullet[];
  cta?: { label: string; href: string };
  learnMoreHref?: string;
}

/**
 * Release feed, newest first. Add new entries at the top.
 * The latest entry is the floating-card candidate; older entries live only in the inbox.
 */
export const RELEASES: Release[] = [];
```

- [ ] **Step 2: Run typecheck**

Run: `bun run check`
Expected: PASS (no type errors).

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/lib/release-feed.ts
git commit -m "feat(release-channel): add release feed module"
```

---

## Task 2: Extract `usePendingInvitations` into its own hook file

The hook currently lives inside `inbox.tsx`. Moving it out lets the inbox feed hook depend on it without circular imports.

**Files:**
- Create: `apps/mesh/src/web/hooks/use-pending-invitations.ts`
- Modify: `apps/mesh/src/web/components/sidebar/footer/inbox.tsx` (remove the inline definition, import from the new file)

- [ ] **Step 1: Create the new hook file**

```ts
// apps/mesh/src/web/hooks/use-pending-invitations.ts
import { AuthUIContext } from "@daveyplate/better-auth-ui";
import { useContext } from "react";

export interface Invitation {
  id: string;
  organizationId: string;
  organizationName?: string;
  email: string;
  role: string;
  status: string;
  expiresAt: Date;
}

export function usePendingInvitations(): Invitation[] {
  const authUi = useContext(AuthUIContext);
  const { data } = authUi.hooks.useListUserInvitations();
  const invitations = (data ?? []) as Invitation[];
  return invitations.filter(
    (inv) => inv.status === "pending" && new Date(inv.expiresAt) > new Date(),
  );
}
```

- [ ] **Step 2: Remove the inline definition from `inbox.tsx`**

In `apps/mesh/src/web/components/sidebar/footer/inbox.tsx`:

- Delete lines 40-48 (`interface Invitation`).
- Delete lines 135-142 (`function usePendingInvitations`).
- Remove `useContext` from the `react` import on line 25 if no longer used (it is only used by that function).
- Remove `AuthUIContext` import on line 23.
- Add at the top of the imports:

```ts
import {
  type Invitation,
  usePendingInvitations,
} from "@/web/hooks/use-pending-invitations";
```

- [ ] **Step 3: Run typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 4: Smoke test the inbox in the browser**

Skip if not running the dev server. If running, open the inbox popover — invitations should still render exactly as before.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/hooks/use-pending-invitations.ts apps/mesh/src/web/components/sidebar/footer/inbox.tsx
git commit -m "refactor(inbox): extract usePendingInvitations into hooks/"
```

---

## Task 3: Implement `useReleaseSeenState` with tests

**Files:**
- Create: `apps/mesh/src/web/hooks/use-release-seen-state.ts`
- Create: `apps/mesh/src/web/hooks/use-release-seen-state.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// apps/mesh/src/web/hooks/use-release-seen-state.test.ts
import { setupComponentTest } from "../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useReleaseSeenState } from "./use-release-seen-state";
import { RELEASES } from "@/web/lib/release-feed";

const STORAGE_KEY = "studio.release-feed.v1";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useReleaseSeenState", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("treats unknown ids as unseen", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });
    expect(result.current.isSeen("never-existed")).toBe(false);
  });

  it("marks an id as seen and persists to localStorage", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });

    act(() => {
      result.current.markSeen("composer-2-5");
    });

    expect(result.current.isSeen("composer-2-5")).toBe(true);

    const raw = localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!) as Record<string, { seenAt: string }>;
    expect(parsed["composer-2-5"]?.seenAt).toEqual(expect.any(String));
  });

  it("markSeen is idempotent — calling twice does not overwrite the timestamp", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });

    act(() => {
      result.current.markSeen("composer-2-5");
    });
    const firstRaw = localStorage.getItem(STORAGE_KEY)!;

    act(() => {
      result.current.markSeen("composer-2-5");
    });
    const secondRaw = localStorage.getItem(STORAGE_KEY)!;

    expect(firstRaw).toBe(secondRaw);
  });

  it("unseenCount reflects entries in RELEASES that have no seenAt", () => {
    const { result } = renderHook(() => useReleaseSeenState(), { wrapper });
    // RELEASES starts empty; unseenCount should be 0 regardless of localStorage.
    expect(result.current.unseenCount).toBe(RELEASES.filter(() => true).length);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/web/hooks/use-release-seen-state.test.ts`
Expected: FAIL with "Cannot find module './use-release-seen-state'" or similar.

- [ ] **Step 3: Implement the hook**

```ts
// apps/mesh/src/web/hooks/use-release-seen-state.ts
import { useLocalStorage } from "@/web/hooks/use-local-storage";
import { RELEASES } from "@/web/lib/release-feed";

const STORAGE_KEY = "studio.release-feed.v1";

type SeenMap = Record<string, { seenAt: string }>;

export interface ReleaseSeenState {
  isSeen: (id: string) => boolean;
  markSeen: (id: string) => void;
  unseenCount: number;
}

export function useReleaseSeenState(): ReleaseSeenState {
  const [seen, setSeen] = useLocalStorage<SeenMap>(STORAGE_KEY, {});

  const isSeen = (id: string) => Boolean(seen[id]);

  const markSeen = (id: string) => {
    if (seen[id]) return;
    setSeen((prev) => ({
      ...prev,
      [id]: { seenAt: new Date().toISOString() },
    }));
  };

  const unseenCount = RELEASES.reduce(
    (count, release) => (seen[release.id] ? count : count + 1),
    0,
  );

  return { isSeen, markSeen, unseenCount };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/web/hooks/use-release-seen-state.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/hooks/use-release-seen-state.ts apps/mesh/src/web/hooks/use-release-seen-state.test.ts
git commit -m "feat(release-channel): add useReleaseSeenState hook"
```

---

## Task 4: Implement `useInboxFeed` with tests

This hook merges releases and pending invitations into one chronologically sorted feed and reports the combined unread count for the red-dot indicator.

**Files:**
- Create: `apps/mesh/src/web/hooks/use-inbox-feed.ts`
- Create: `apps/mesh/src/web/hooks/use-inbox-feed.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/mesh/src/web/hooks/use-inbox-feed.test.tsx
import { setupComponentTest } from "../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

// Mock module dependencies BEFORE importing the SUT.
mock.module("@/web/hooks/use-pending-invitations", () => ({
  usePendingInvitations: () => [
    {
      id: "inv-1",
      organizationId: "org-1",
      organizationName: "Acme",
      email: "user@acme.test",
      role: "member",
      status: "pending",
      expiresAt: new Date("2026-06-01T00:00:00Z"),
    },
  ],
}));

mock.module("@/web/lib/release-feed", () => ({
  RELEASES: [
    {
      id: "newer-release",
      date: "2026-05-20",
      title: "Newer",
      bullets: [],
    },
    {
      id: "older-release",
      date: "2026-01-10",
      title: "Older",
      bullets: [],
    },
  ],
}));

import { useInboxFeed } from "./use-inbox-feed";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("useInboxFeed", () => {
  beforeEach(() => {
    localStorage.clear();
  });
  afterEach(() => {
    localStorage.clear();
  });

  it("returns releases + invitations sorted by date desc", () => {
    const { result } = renderHook(() => useInboxFeed(), { wrapper });
    const ids = result.current.items.map((item) =>
      item.type === "release" ? item.release.id : item.invitation.id,
    );
    // Invitation expires 2026-06-01 (most recent), then newer-release (2026-05-20), then older-release (2026-01-10).
    expect(ids).toEqual(["inv-1", "newer-release", "older-release"]);
  });

  it("flags every release with its seen state", () => {
    const { result } = renderHook(() => useInboxFeed(), { wrapper });
    const releases = result.current.items.filter(
      (i): i is Extract<typeof i, { type: "release" }> => i.type === "release",
    );
    expect(releases.every((r) => r.isSeen === false)).toBe(true);
  });

  it("redDotCount is unseen releases + pending invitations", () => {
    const { result } = renderHook(() => useInboxFeed(), { wrapper });
    expect(result.current.redDotCount).toBe(2 + 1);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/web/hooks/use-inbox-feed.test.tsx`
Expected: FAIL with "Cannot find module './use-inbox-feed'".

- [ ] **Step 3: Implement the hook**

```ts
// apps/mesh/src/web/hooks/use-inbox-feed.ts
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";
import {
  type Invitation,
  usePendingInvitations,
} from "@/web/hooks/use-pending-invitations";
import { type Release, RELEASES } from "@/web/lib/release-feed";

export type InboxFeedItem =
  | { type: "release"; release: Release; isSeen: boolean }
  | { type: "invitation"; invitation: Invitation };

interface DatedItem {
  date: number;
  item: InboxFeedItem;
}

export interface InboxFeed {
  items: InboxFeedItem[];
  pendingInvitations: Invitation[];
  redDotCount: number;
}

export function useInboxFeed(): InboxFeed {
  const { isSeen, unseenCount } = useReleaseSeenState();
  const pendingInvitations = usePendingInvitations();

  const dated: DatedItem[] = [
    ...RELEASES.map<DatedItem>((release) => ({
      date: new Date(release.date).getTime(),
      item: { type: "release", release, isSeen: isSeen(release.id) },
    })),
    ...pendingInvitations.map<DatedItem>((invitation) => ({
      date: new Date(invitation.expiresAt).getTime(),
      item: { type: "invitation", invitation },
    })),
  ];

  dated.sort((a, b) => b.date - a.date);

  return {
    items: dated.map((d) => d.item),
    pendingInvitations,
    redDotCount: unseenCount + pendingInvitations.length,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/web/hooks/use-inbox-feed.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/hooks/use-inbox-feed.ts apps/mesh/src/web/hooks/use-inbox-feed.test.tsx
git commit -m "feat(release-channel): add useInboxFeed hook"
```

---

## Task 5: Build the shared `ReleaseCard` body component

This is the inner visual — eyebrow, title, bullet list, CTA, learn-more. It is rendered both inside inbox rows and inside the floating card, so it stays purely presentational.

**Files:**
- Create: `apps/mesh/src/web/components/release-channel/release-card.tsx`

- [ ] **Step 1: Create the component**

```tsx
// apps/mesh/src/web/components/release-channel/release-card.tsx
import type { Release } from "@/web/lib/release-feed";
import { Button } from "@deco/ui/components/button.tsx";

export interface ReleaseCardProps {
  release: Release;
  onCtaClick?: () => void;
  onLearnMoreClick?: () => void;
}

export function ReleaseCard({
  release,
  onCtaClick,
  onLearnMoreClick,
}: ReleaseCardProps) {
  return (
    <div className="flex flex-col gap-3">
      <div>
        {release.eyebrow && (
          <p className="text-xs text-muted-foreground">{release.eyebrow}</p>
        )}
        <h3 className="text-base font-semibold text-foreground">
          {release.title}
        </h3>
      </div>

      <ul className="flex flex-col gap-3">
        {release.bullets.map((bullet, idx) => (
          <li key={idx} className="flex items-start gap-3">
            <bullet.icon
              size={20}
              className="text-muted-foreground mt-0.5 shrink-0"
            />
            <div className="min-w-0">
              <p className="text-sm font-medium text-foreground">
                {bullet.title}
              </p>
              <p className="text-xs text-muted-foreground">{bullet.body}</p>
            </div>
          </li>
        ))}
      </ul>

      {(release.cta || release.learnMoreHref) && (
        <div className="flex items-center justify-between pt-1">
          {release.learnMoreHref ? (
            <a
              href={release.learnMoreHref}
              target="_blank"
              rel="noreferrer"
              onClick={onLearnMoreClick}
              className="text-xs text-muted-foreground hover:text-foreground underline-offset-2 hover:underline"
            >
              Learn More
            </a>
          ) : (
            <span />
          )}
          {release.cta && (
            <Button asChild size="sm" onClick={onCtaClick}>
              <a href={release.cta.href}>{release.cta.label}</a>
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add apps/mesh/src/web/components/release-channel/release-card.tsx
git commit -m "feat(release-channel): add ReleaseCard presentational component"
```

---

## Task 6: Refactor inbox popover to render the merged feed

Replace today's invitations-only list with the chronological feed. Extract `InvitationItem` to its own file (the inbox file is already crowded) and add an `InboxReleaseItem` wrapper for release rows.

**Files:**
- Create: `apps/mesh/src/web/components/sidebar/footer/invitation-item.tsx`
- Create: `apps/mesh/src/web/components/release-channel/inbox-release-item.tsx`
- Modify: `apps/mesh/src/web/components/sidebar/footer/inbox.tsx`

- [ ] **Step 1: Extract `InvitationItem` to its own file**

Create `apps/mesh/src/web/components/sidebar/footer/invitation-item.tsx` with the existing `InvitationItem` from `inbox.tsx` (lines 50-133), unchanged. Add the necessary imports at the top of the new file:

```tsx
// apps/mesh/src/web/components/sidebar/footer/invitation-item.tsx
import { authClient } from "@/web/lib/auth-client";
import { Button } from "@deco/ui/components/button.tsx";
import { Check, XClose } from "@untitledui/icons";
import { useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { Invitation } from "@/web/hooks/use-pending-invitations";

export function InvitationItem({ invitation }: { invitation: Invitation }) {
  const [isAccepting, setIsAccepting] = useState(false);
  const [isRejecting, setIsRejecting] = useState(false);
  const queryClient = useQueryClient();

  const handleAccept = async () => {
    setIsAccepting(true);
    try {
      const result = await authClient.organization.acceptInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsAccepting(false);
      } else {
        const orgResult = await authClient.organization.getFullOrganization({
          query: { organizationId: invitation.organizationId },
        });
        toast.success("Invitation accepted!");
        const slug = orgResult?.data?.slug;
        window.location.href = slug ? `/${slug}` : "/";
      }
    } catch {
      toast.error("Failed to accept invitation");
      setIsAccepting(false);
    }
  };

  const handleReject = async () => {
    setIsRejecting(true);
    try {
      const result = await authClient.organization.rejectInvitation({
        invitationId: invitation.id,
      });
      if (result.error) {
        toast.error(result.error.message);
        setIsRejecting(false);
      } else {
        toast.success("Invitation declined");
        queryClient.invalidateQueries();
      }
    } catch {
      toast.error("Failed to decline invitation");
      setIsRejecting(false);
    }
  };

  return (
    <div className="flex items-center gap-3 px-5 py-4 border-b border-border last:border-0 hover:bg-muted/25 transition-colors">
      <div className="flex-1 min-w-0">
        <p className="text-xs text-muted-foreground">
          You&apos;ve been invited to join
        </p>
        <p className="text-sm font-medium truncate">
          {invitation.organizationName ?? "Unknown organization"}
        </p>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-green-600 hover:text-green-700 hover:bg-green-50 dark:hover:bg-green-950"
          onClick={handleAccept}
          disabled={isAccepting || isRejecting}
          aria-label="Accept invitation"
        >
          <Check size={14} />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="size-7 text-muted-foreground hover:text-destructive hover:bg-destructive/10"
          onClick={handleReject}
          disabled={isAccepting || isRejecting}
          aria-label="Decline invitation"
        >
          <XClose size={14} />
        </Button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Create the `InboxReleaseItem` wrapper**

```tsx
// apps/mesh/src/web/components/release-channel/inbox-release-item.tsx
import { ReleaseCard } from "@/web/components/release-channel/release-card";
import type { Release } from "@/web/lib/release-feed";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";

export interface InboxReleaseItemProps {
  release: Release;
  isSeen: boolean;
}

export function InboxReleaseItem({ release, isSeen }: InboxReleaseItemProps) {
  const { markSeen } = useReleaseSeenState();

  return (
    <div className="relative px-5 py-4 border-b border-border last:border-0">
      {!isSeen && (
        <span
          aria-label="New release"
          className="absolute left-2 top-6 size-1.5 rounded-full bg-primary"
        />
      )}
      <ReleaseCard
        release={release}
        onCtaClick={() => markSeen(release.id)}
        onLearnMoreClick={() => markSeen(release.id)}
      />
    </div>
  );
}
```

- [ ] **Step 3: Rewrite the `InboxButton` body in `inbox.tsx`**

In `apps/mesh/src/web/components/sidebar/footer/inbox.tsx`:

- Delete the inline `InvitationItem` (now lives in its own file).
- Replace the imports of `Check`, `XClose`, `authClient`, `useQueryClient`, `toast`, `useState` if those become unused. (Confirm with the typechecker; keep what's still needed.)
- Add imports:

```ts
import { InvitationItem } from "@/web/components/sidebar/footer/invitation-item";
import { InboxReleaseItem } from "@/web/components/release-channel/inbox-release-item";
import { useInboxFeed } from "@/web/hooks/use-inbox-feed";
```

- Replace the `InboxButton` function (lines 263-310 of the original file) with:

```tsx
function InboxButton() {
  const { items, redDotCount } = useInboxFeed();

  return (
    <Popover>
      <SidebarMenu>
        <SidebarMenuItem>
          <PopoverTrigger asChild>
            <SidebarMenuButton tooltip="Inbox" className="relative">
              <Inbox01 size={24} />
              {redDotCount > 0 && (
                <span className="absolute top-1 right-1 size-2 rounded-full bg-red-500 pointer-events-none" />
              )}
            </SidebarMenuButton>
          </PopoverTrigger>
        </SidebarMenuItem>
      </SidebarMenu>
      <PopoverContent
        side="right"
        align="start"
        sideOffset={16}
        collisionPadding={16}
        className="w-[min(400px,calc(100vw-2rem))] p-0 h-[min(650px,calc(100dvh-4rem))] flex flex-col"
      >
        <div className="px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-medium">Inbox</h3>
        </div>
        {items.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
            <Inbox01 size={24} className="text-muted-foreground/50" />
            <p className="text-sm font-medium text-foreground">
              Nothing here yet
            </p>
            <p className="text-xs text-muted-foreground">
              Invitations and release updates will appear here
            </p>
          </div>
        ) : (
          <div className="overflow-y-auto flex-1">
            {items.map((item) =>
              item.type === "invitation" ? (
                <InvitationItem
                  key={`inv-${item.invitation.id}`}
                  invitation={item.invitation}
                />
              ) : (
                <InboxReleaseItem
                  key={`rel-${item.release.id}`}
                  release={item.release}
                  isSeen={item.isSeen}
                />
              ),
            )}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
}
```

- [ ] **Step 4: Run typecheck**

Run: `bun run check`
Expected: PASS. Fix any unused-import errors by removing imports that are no longer referenced after the `InvitationItem` extraction.

- [ ] **Step 5: Run lint**

Run: `bun run lint`
Expected: PASS.

- [ ] **Step 6: Smoke test in the browser**

If `bun run dev` is running, open the inbox popover. With an empty `RELEASES` array, behavior should be identical to before: invitations render and accept/reject still work; "Nothing here yet" empty state shows when no invitations.

- [ ] **Step 7: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/footer/invitation-item.tsx apps/mesh/src/web/components/release-channel/inbox-release-item.tsx apps/mesh/src/web/components/sidebar/footer/inbox.tsx
git commit -m "feat(release-channel): render releases + invitations in unified inbox feed"
```

---

## Task 7: Build `FloatingReleaseCard` with visibility tests and mount in shell

**Files:**
- Create: `apps/mesh/src/web/components/release-channel/floating-release-card.tsx`
- Create: `apps/mesh/src/web/components/release-channel/floating-release-card.test.tsx`
- Modify: `apps/mesh/src/web/layouts/shell-layout.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// apps/mesh/src/web/components/release-channel/floating-release-card.test.tsx
import { setupComponentTest } from "../../test/setup";
setupComponentTest();
import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { fireEvent, render } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

const FRESH_DATE = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);
const OLD_DATE = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000)
  .toISOString()
  .slice(0, 10);

function makeRelease(overrides: Partial<{ id: string; date: string }> = {}) {
  return {
    id: overrides.id ?? "fresh-release",
    date: overrides.date ?? FRESH_DATE,
    title: "Fresh Release",
    eyebrow: "Now Available",
    bullets: [],
  };
}

const releasesRef: { current: ReturnType<typeof makeRelease>[] } = {
  current: [],
};

mock.module("@/web/lib/release-feed", () => ({
  get RELEASES() {
    return releasesRef.current;
  },
}));

import { FloatingReleaseCard } from "./floating-release-card";

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("FloatingReleaseCard", () => {
  beforeEach(() => {
    localStorage.clear();
    releasesRef.current = [];
  });
  afterEach(() => {
    localStorage.clear();
    releasesRef.current = [];
  });

  it("renders nothing when RELEASES is empty", () => {
    const { container } = render(<FloatingReleaseCard />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("renders nothing when the newest release is older than 30 days", () => {
    releasesRef.current = [makeRelease({ id: "stale", date: OLD_DATE })];
    const { container } = render(<FloatingReleaseCard />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("renders the card when the newest release is fresh and unseen", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    const { getByText } = render(<FloatingReleaseCard />, { wrapper });
    expect(getByText("Fresh Release")).toBeInTheDocument();
  });

  it("does not render when the newest release is already seen", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    localStorage.setItem(
      "studio.release-feed.v1",
      JSON.stringify({ fresh: { seenAt: new Date().toISOString() } }),
    );
    const { container } = render(<FloatingReleaseCard />, { wrapper });
    expect(container.firstChild).toBeNull();
  });

  it("clicking the dismiss button marks the release as seen and unmounts the card", () => {
    releasesRef.current = [makeRelease({ id: "fresh" })];
    const { getByLabelText, queryByText } = render(<FloatingReleaseCard />, {
      wrapper,
    });
    fireEvent.click(getByLabelText("Dismiss release announcement"));
    expect(queryByText("Fresh Release")).toBeNull();
    const stored = JSON.parse(
      localStorage.getItem("studio.release-feed.v1") ?? "{}",
    );
    expect(stored.fresh?.seenAt).toEqual(expect.any(String));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test apps/mesh/src/web/components/release-channel/floating-release-card.test.tsx`
Expected: FAIL with "Cannot find module './floating-release-card'".

- [ ] **Step 3: Implement the component**

```tsx
// apps/mesh/src/web/components/release-channel/floating-release-card.tsx
import { Button } from "@deco/ui/components/button.tsx";
import { XClose } from "@untitledui/icons";
import { ReleaseCard } from "@/web/components/release-channel/release-card";
import { useReleaseSeenState } from "@/web/hooks/use-release-seen-state";
import { RELEASES } from "@/web/lib/release-feed";

const FRESHNESS_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

function pickFloatingCandidate(now: number) {
  const latest = RELEASES[0];
  if (!latest) return null;
  const releaseTime = new Date(latest.date).getTime();
  const age = now - releaseTime;
  if (age < 0 || age > FRESHNESS_WINDOW_MS) return null;
  return latest;
}

export function FloatingReleaseCard() {
  const { isSeen, markSeen } = useReleaseSeenState();
  const candidate = pickFloatingCandidate(Date.now());

  if (!candidate) return null;
  if (isSeen(candidate.id)) return null;

  return (
    <div
      role="dialog"
      aria-label="Release announcement"
      className="fixed bottom-6 right-6 z-50 w-[min(360px,calc(100vw-3rem))] rounded-lg border border-border bg-background p-4 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-300"
    >
      <Button
        size="icon"
        variant="ghost"
        aria-label="Dismiss release announcement"
        className="absolute right-2 top-2 size-7 text-muted-foreground"
        onClick={() => markSeen(candidate.id)}
      >
        <XClose size={14} />
      </Button>
      <ReleaseCard
        release={candidate}
        onCtaClick={() => markSeen(candidate.id)}
        onLearnMoreClick={() => markSeen(candidate.id)}
      />
    </div>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test apps/mesh/src/web/components/release-channel/floating-release-card.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 5: Mount the card in the shell layout**

Open `apps/mesh/src/web/layouts/shell-layout.tsx`. Add an import near the top:

```ts
import { FloatingReleaseCard } from "@/web/components/release-channel/floating-release-card";
```

Modify the JSX returned by `ShellLayoutContent` (currently lines 271-282) to:

```tsx
return (
  <ShellProjectProvider org={{ ...activeOrg, logo: activeOrg.logo ?? null }}>
    <PostHogGroupSync activeOrg={activeOrg} />
    <Outlet />

    <FloatingReleaseCard />

    {/* Keyboard Shortcuts Dialog */}
    <KeyboardShortcutsDialog
      open={shortcutsDialogOpen}
      onOpenChange={setShortcutsDialogOpen}
    />
  </ShellProjectProvider>
);
```

- [ ] **Step 6: Run typecheck, lint, and the full test suite**

Run in parallel:
- `bun run check`
- `bun run lint`
- `bun test apps/mesh/src/web/`

Expected: all PASS.

- [ ] **Step 7: Format**

Run: `bun run fmt`
Expected: writes formatting fixes (if any).

- [ ] **Step 8: Manual smoke test**

If `bun run dev` is running:
1. Add a temporary entry to `RELEASES` with today's date (do NOT commit it).
2. Reload the app — verify the floating card appears bottom-right after ~300ms.
3. Verify the inbox button shows a red dot.
4. Open the inbox — verify the release appears with the unseen dot, alongside any pending invitations sorted by date.
5. Click the floating card's X — verify it disappears and `localStorage.getItem("studio.release-feed.v1")` contains a `seenAt` for the temporary id.
6. Reload — verify the card stays gone and the inbox dot (and the row's "new" dot) are gone.
7. Remove the temporary entry before committing.

- [ ] **Step 9: Commit**

```bash
git add apps/mesh/src/web/components/release-channel/floating-release-card.tsx apps/mesh/src/web/components/release-channel/floating-release-card.test.tsx apps/mesh/src/web/layouts/shell-layout.tsx
git commit -m "feat(release-channel): mount floating release card in authenticated shell"
```

---

## Done

`RELEASES` is empty, so the floating card never renders and the inbox behaves exactly as before. A follow-up PR adds the first real entry — this is the go-live moment for the channel.
