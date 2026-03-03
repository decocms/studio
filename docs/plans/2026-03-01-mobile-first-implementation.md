# Mobile-First: Shell + Agents Page — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make the MCP Mesh shell and Agents page mobile-responsive without breaking desktop, using CSS-first Tailwind and a single `isMobile` check for the chat panel.

**Architecture:** Tailwind base classes (no prefix) target mobile, `md:` adds desktop overrides. The only JS branching is in `shell-layout.tsx` to swap the resizable chat side-panel for a bottom sheet on mobile. Everything else is additive CSS.

**Tech Stack:** React 19, Tailwind v4, Radix UI Sheet (`@deco/ui/components/sheet.tsx`), `useIsMobile` from `@deco/ui/hooks/use-mobile.ts`, TanStack Router

---

## Pre-work: Understand the Breakpoints

Tailwind v4 default breakpoints (no custom overrides in this project):
- No prefix → 0px+ → **mobile styles — always write these first**
- `md:` → 768px+ → **desktop override**
- `sm:` (640px), `lg:` (1024px), `xl:`, `2xl:` — unused in this work

Rule: write the mobile style, then layer `md:` for desktop. Never write desktop-only styles without a mobile default.

---

## Pre-work: Merge `layout-update` Branch

This branch is a prerequisite. It moves the chat toggle button from the sidebar header into the page header topbar, and adds a `LayoutLeft` icon to the sidebar for collapse/expand.

**⚠️ Critical note after merging:** The `layout-update` branch REMOVES `SidebarTrigger` from `page/index.tsx` entirely. On desktop this is fine (the sidebar has its own collapse icon). On mobile the sidebar is a Sheet and has no accessible external trigger — we fix this in Task 1.

**Step 1: Merge the branch**

```bash
git merge layout-update
```

Expected: clean merge, no conflicts (the two branches touch different things).

**Step 2: Verify the merge**

```bash
bun run check
```

Expected: no TypeScript errors.

**Step 3: Commit if everything is clean**

```bash
git commit --allow-empty -m "chore: merge layout-update into mobile branch"
```

(Or just proceed — the merge commit is already created.)

---

## Task 1: Restore Mobile SidebarTrigger in Page Header

**Files:**
- Modify: `apps/mesh/src/web/components/page/index.tsx`

**Context:** After merging `layout-update`, `page/index.tsx` no longer imports or renders `SidebarTrigger`. On desktop, the sidebar has a `LayoutLeft` collapse/expand icon inside the sidebar itself. On mobile, the sidebar is a Sheet (modal), so the trigger must be accessible from outside the sidebar. We add it back with `md:hidden` so it only appears on mobile.

**Step 1: Read the current file after merge**

```bash
cat apps/mesh/src/web/components/page/index.tsx
```

Confirm that `SidebarTrigger` import is gone (removed by `layout-update`).

**Step 2: Add the SidebarTrigger import back**

In `apps/mesh/src/web/components/page/index.tsx`, add `SidebarTrigger` to the existing `@deco/ui/components/sidebar.tsx` import. The file currently imports from `@deco/ui/lib/utils.ts` — add a new import:

```tsx
import { SidebarTrigger } from "@deco/ui/components/sidebar.tsx";
```

**Step 3: Add SidebarTrigger to the left side of PageHeader — mobile only**

Find the `PageHeader` function. The left container currently renders:

```tsx
<div className="flex items-center gap-1">{left}</div>
```

Change it to:

```tsx
<div className="flex items-center gap-1">
  <SidebarTrigger className="md:hidden text-muted-foreground" />
  {left}
</div>
```

`md:hidden` = hidden on desktop (768px+), visible on mobile. No change to desktop behavior.

**Step 4: Format**

```bash
bun run fmt
```

**Step 5: Type check**

```bash
bun run check
```

Expected: no errors.

**Step 6: Manual verification**

Open the app in a browser. Resize to < 768px. Confirm:
- Mobile: hamburger icon visible in the top-left of every page header
- Tapping it opens the sidebar as a sheet from the left
- Desktop (768px+): hamburger icon NOT visible (sidebar uses its own collapse icon)

**Step 7: Commit**

```bash
git add apps/mesh/src/web/components/page/index.tsx
git commit -m "feat(mobile): restore SidebarTrigger in page header for mobile (md:hidden on desktop)"
```

---

## Task 2: Fix PageHeader Horizontal Scroll on Mobile

**Files:**
- Modify: `apps/mesh/src/web/components/page/index.tsx`

**Context:** The `PageHeader` has `min-w-max` which forces the container to be as wide as all its content. On narrow screens this causes forced horizontal scroll instead of graceful compression. Removing it lets the layout flex naturally. The `overflow-x-auto` stays for truly extreme cases.

**Step 1: Locate the className in PageHeader**

In `apps/mesh/src/web/components/page/index.tsx`, find the `PageHeader` function's outer div className. After `layout-update` it looks like:

```tsx
"shrink-0 w-full border-b border-border/50 h-11 overflow-x-auto",
"flex items-center justify-between gap-3 pr-2 pl-4 min-w-max",
```

**Step 2: Remove `min-w-max`**

Change the second line to:

```tsx
"flex items-center justify-between gap-3 pr-2 pl-4",
```

**Step 3: Add `min-w-0` to the left slot so breadcrumbs can truncate**

Find `PageHeaderLeft` function. Its div currently has:

```tsx
className={cn("flex items-center gap-2 shrink-0 overflow-hidden", className)}
```

Add `min-w-0`:

```tsx
className={cn("flex items-center gap-2 shrink-0 overflow-hidden min-w-0", className)}
```

**Step 4: Format + type check**

```bash
bun run fmt && bun run check
```

**Step 5: Manual verification**

Open app at 390px wide (iPhone viewport). Confirm:
- Page header fits within the viewport without horizontal scroll
- Breadcrumb text truncates if too long rather than forcing layout overflow
- Desktop (1440px): no visual change — layout expands naturally in flex context

**Step 6: Commit**

```bash
git add apps/mesh/src/web/components/page/index.tsx
git commit -m "fix(mobile): remove min-w-max from PageHeader to prevent forced horizontal scroll"
```

---

## Task 3: Create ChatBottomSheet Component

**Files:**
- Create: `apps/mesh/src/web/components/chat/chat-bottom-sheet.tsx`

**Context:** On mobile, the resizable side chat panel is replaced by a bottom sheet. It uses the same `useDecoChatOpen` hook as the desktop side panel, so the `ChatToggleButton` in the page header works identically on both — it just toggles state, and the rendering layer decides what to show.

The sheet occupies nearly full height (`calc(100svh - 1.25rem)`) leaving ~20px of page content visible at the top, dimmed by the overlay. This creates the "drawer that comes over the screen" feel the user described.

**Step 1: Create the file**

`apps/mesh/src/web/components/chat/chat-bottom-sheet.tsx`:

```tsx
import { useDecoChatOpen } from "@/web/hooks/use-deco-chat-open";
import {
  Sheet,
  SheetContent,
} from "@deco/ui/components/sheet.tsx";
import { ChatPanel } from "./side-panel-chat";

export function ChatBottomSheet() {
  const [isChatOpen, setChatOpen] = useDecoChatOpen();

  return (
    <Sheet open={isChatOpen} onOpenChange={setChatOpen}>
      <SheetContent
        side="bottom"
        className="h-[calc(100svh-1.25rem)] p-0 rounded-t-xl border-0"
      >
        <ChatPanel />
      </SheetContent>
    </Sheet>
  );
}
```

Notes on the className:
- `h-[calc(100svh-1.25rem)]` — leaves 20px of page visible at top (creates peek effect through the dimmed overlay)
- `p-0` — `ChatPanel` manages its own internal padding
- `rounded-t-xl` — gives the sheet a rounded top edge (standard bottom sheet UX)
- `border-0` — removes the default `border-t` from SheetContent bottom variant

**Step 2: Format + type check**

```bash
bun run fmt && bun run check
```

Expected: no errors. `ChatPanel` is already exported from `side-panel-chat.tsx` and all imports resolve.

**Step 3: Commit**

```bash
git add apps/mesh/src/web/components/chat/chat-bottom-sheet.tsx
git commit -m "feat(mobile): add ChatBottomSheet component for mobile chat experience"
```

---

## Task 4: Update ShellLayoutInner for Mobile

**Files:**
- Modify: `apps/mesh/src/web/layouts/shell-layout.tsx`

**Context:** This is **the one `isMobile` check** in the entire scope. On mobile, the `ResizablePanelGroup` with its JS-driven panel widths and inline `overflow: hidden` cannot be cleanly adapted with CSS alone. The mobile branch renders a simple full-height layout with `<ChatBottomSheet />` instead.

The sidebar's mobile Sheet behavior is already handled inside `@deco/ui/sidebar.tsx` — we don't need to touch it.

**Step 1: Add `useIsMobile` import**

In `apps/mesh/src/web/layouts/shell-layout.tsx`, add the import:

```tsx
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
```

**Step 2: Add `ChatBottomSheet` import**

```tsx
import { ChatBottomSheet } from "@/web/components/chat/chat-bottom-sheet";
```

**Step 3: Add the mobile branch in `ShellLayoutInner`**

Find the `ShellLayoutInner` function. At the top of the function body, after the existing hooks (`useDecoChatOpen`, `useLocalStorage`, `usePreferences`), add:

```tsx
const isMobile = useIsMobile();
```

Then, immediately before the `return (` statement, add the mobile branch:

```tsx
if (isMobile) {
  return (
    <SidebarLayout
      className="flex-1 bg-sidebar"
      data-studio={
        isStudio && preferences.experimental_projects ? "" : undefined
      }
      style={
        {
          "--sidebar-width": "13.5rem",
          "--sidebar-width-mobile": "11rem",
        } as Record<string, string>
      }
    >
      <MeshSidebar onCreateProject={onCreateProject} />
      <SidebarInset
        className="pt-1.5 flex flex-col flex-1 min-h-0"
        style={{ background: "transparent" }}
      >
        <div
          className={cn(
            "flex flex-col flex-1 min-h-0 bg-card overflow-hidden",
            "border-t border-l border-r border-sidebar-border",
            "rounded-tl-[0.75rem] rounded-tr-[0.75rem]",
          )}
        >
          <Outlet />
        </div>
      </SidebarInset>
      {!isHomeRoute && <ChatBottomSheet />}
    </SidebarLayout>
  );
}
```

Key differences from desktop:
- No `ResizablePanelGroup` / `ResizablePanel` / `ResizableHandle` / `PersistentResizablePanel`
- No `containerType: "inline-size"` (not needed — no container query for chat width)
- No `--chat-panel-w` CSS var (no side panel)
- Rounded on both top corners (`rounded-tr-[0.75rem]` added — no chat panel to the right)
- `ChatBottomSheet` rendered outside the card, as a portal overlay

The existing desktop `return (...)` below this is untouched.

**Step 4: Format + type check**

```bash
bun run fmt && bun run check
```

**Step 5: Manual verification**

Open at 390px width:
- Confirm the main content fills the full width
- Confirm the sidebar opens as a left sheet (tap the hamburger in the page header)
- Confirm the chat icon in the page topbar opens the bottom sheet
- Confirm the bottom sheet slides up from the bottom, showing ~20px of content at the top
- Confirm the bottom sheet close (X button or tap overlay) works

Open at 1440px width (desktop):
- Confirm absolutely nothing changed — resizable panels, collapsible sidebar, side chat panel all work exactly as before

**Step 6: Commit**

```bash
git add apps/mesh/src/web/layouts/shell-layout.tsx
git commit -m "feat(mobile): add mobile branch to ShellLayoutInner with ChatBottomSheet"
```

---

## Task 5: Update Agents Page for Mobile

**Files:**
- Modify: `apps/mesh/src/web/routes/orgs/agents.tsx`

**Context:** Two pure CSS changes. Cards become single-column on mobile (full-width cards look and feel natural on a phone). Padding reduces slightly on mobile to give more room to content. Table view is left as-is — it scrolls horizontally on mobile, which is acceptable.

**Step 1: Update the cards grid**

Find the cards grid div in `OrgAgentsContent`. Current:

```tsx
<div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
```

Change to:

```tsx
<div className="grid grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
```

Mobile: single column. Desktop (768px+): original auto-fill grid. Desktop unchanged.

**Step 2: Update the content padding**

Find the outer div wrapping the cards content area:

```tsx
<div className="flex-1 overflow-auto p-5">
```

Change to:

```tsx
<div className="flex-1 overflow-auto p-3 md:p-5">
```

Mobile: 12px padding. Desktop: 20px padding (unchanged).

**Step 3: Format + type check**

```bash
bun run fmt && bun run check
```

**Step 4: Manual verification**

Open `/agents` at 390px width:
- Cards render as a single column, full-width
- No horizontal overflow
- Padding is comfortable (12px each side)

Open at 1440px width:
- Cards render in multi-column auto-fill grid (unchanged)
- Padding is 20px (unchanged)

**Step 5: Commit**

```bash
git add apps/mesh/src/web/routes/orgs/agents.tsx
git commit -m "feat(mobile): single-column card grid and tighter padding on mobile for agents page"
```

---

## Task 6: Final QA + Lint

**Step 1: Run full lint**

```bash
bun run lint
```

Expected: no new errors introduced.

**Step 2: Run type check**

```bash
bun run check
```

**Step 3: Run tests**

```bash
bun test
```

**Step 4: Cross-viewport visual QA checklist**

Test at 390px (iPhone 14 Pro), 768px (tablet boundary), and 1440px (desktop):

| Check | 390px | 768px | 1440px |
|-------|-------|-------|--------|
| Sidebar trigger visible in header | ✓ | hidden | hidden |
| Sidebar opens as left sheet | ✓ | N/A | N/A |
| Page header fits without horizontal scroll | ✓ | ✓ | ✓ |
| Agents: single-column cards | ✓ | multi-col | multi-col |
| Chat icon in page header | ✓ | ✓ | ✓ |
| Chat opens as bottom sheet (mobile) | ✓ | N/A | N/A |
| Chat opens as side panel (desktop) | N/A | N/A | ✓ |
| Desktop layout: zero visual change | N/A | N/A | ✓ |

**Step 5: Final commit if any fmt fixes**

```bash
bun run fmt
git add -p  # stage only formatting changes if any
git commit -m "chore: final fmt pass after mobile-first shell + agents implementation"
```

---

## Summary of Files Changed

| File | Type | Why |
|------|------|-----|
| `apps/mesh/src/web/components/page/index.tsx` | Modify | Mobile SidebarTrigger + remove min-w-max |
| `apps/mesh/src/web/components/chat/chat-bottom-sheet.tsx` | Create | New mobile chat bottom sheet |
| `apps/mesh/src/web/layouts/shell-layout.tsx` | Modify | isMobile branch for mobile layout |
| `apps/mesh/src/web/routes/orgs/agents.tsx` | Modify | Single-column grid + padding |

**Lines of code added:** ~50 (new component) + ~25 (mobile branch in shell) + ~5 (css class changes)
**isMobile checks introduced:** 1 (in shell-layout.tsx only)
**Desktop files changed:** 0 (all changes are additive)
