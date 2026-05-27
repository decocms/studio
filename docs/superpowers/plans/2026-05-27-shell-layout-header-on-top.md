# Shell Layout: Header On Top Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the app shell so the toolbar header runs full-width across the top and the sidebar sits below it, eliminating the dual-mount of `SidebarNavControls` and simplifying PWA WCO CSS.

**Architecture:** `SidebarProvider` stays at the root. Inside `app-shell-root` (flex-col), a single `Toolbar.Header` is rendered above a body row (`SidebarLayout`) that holds the sidebar, resize handle, and `SidebarInset`. The header's left zone holds `[Logo] [SidebarTrigger] [Back] [Forward]` at fixed positions, so collapse animations only change the sidebar's width — nothing in the header moves. Mobile renders the sidebar inside a `Sheet`; the `SidebarTrigger` in the header acts as the hamburger via `@deco/ui`'s existing `toggleSidebar()` mobile-aware behavior.

**Tech Stack:** React 19, `@deco/ui` (sidebar primitives), Tailwind v4, TanStack Router. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-05-27-shell-layout-header-on-top-design.md`

**Testing note:** The change is structural/visual. There are no useful unit tests for shell DOM arrangement, so this plan does not follow a TDD red/green cycle. Instead, each task ends with explicit verification steps: type-check, lint, and a manual smoke test. Do not skip the manual steps — they are the only thing that catches layout regressions.

---

## File Map

**Modified:**
- `apps/mesh/src/web/layouts/agent-shell-layout/toolbar.tsx` — add `Toolbar.Logo` sub-component
- `apps/mesh/src/web/layouts/org-shell-layout/index.tsx` — restructure shell, hoist `Toolbar.Header`, delete `MobileHomeToolbar`, mount `Sheet` for mobile, render `SidebarTrigger` unconditionally
- `apps/mesh/src/web/components/sidebar/navigation.tsx` — delete `SidebarLogoHeader`, remove `headerRight` prop
- `apps/mesh/src/web/components/sidebar/index.tsx` — remove `headerRight` prop from `StudioSidebar`
- `apps/mesh/index.css` — simplify WCO media query

**Created:** none.

**Deleted (logically):** `SidebarLogoHeader` (inside navigation.tsx), `MobileHomeToolbar` (inside org-shell-layout/index.tsx), `SidebarToggleButton` (inside org-shell-layout/index.tsx — replaced by direct `useSidebar().toggleSidebar()` in the header).

---

## Task 1: Add `Toolbar.Logo` sub-component

**Files:**
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/toolbar.tsx`

- [ ] **Step 1: Add the Logo sub-component**

In `apps/mesh/src/web/layouts/agent-shell-layout/toolbar.tsx`, add a new `ToolbarLogo` function near the other sub-components (e.g., between `ToolbarNav` and `ToolbarCenterSlot`):

```tsx
import { Suspense } from "react";
import { DEFAULT_LOGO, usePublicConfig } from "@/web/hooks/use-public-config";

function ToolbarLogoInner() {
  const config = usePublicConfig();
  const logo = config.logo ?? DEFAULT_LOGO;
  const lightSrc = typeof logo === "string" ? logo : logo.light;
  const darkSrc = typeof logo === "string" ? logo : logo.dark;
  return (
    <span className="wco-hide flex items-center shrink-0 px-2">
      <img
        src={lightSrc}
        alt="Logo"
        className="size-6 object-contain dark:hidden"
      />
      <img
        src={darkSrc}
        alt="Logo"
        className="size-6 object-contain hidden dark:block"
      />
    </span>
  );
}

function ToolbarLogo() {
  return (
    <Suspense
      fallback={<span className="wco-hide shrink-0 size-6 mx-2" />}
    >
      <ToolbarLogoInner />
    </Suspense>
  );
}
```

Note: the existing `import { createContext, use, useState, type ReactNode } from "react";` line needs `Suspense` added:

```tsx
import { createContext, Suspense, use, useState, type ReactNode } from "react";
```

(Drop the standalone `import { Suspense } from "react";` from the snippet above — fold it into the existing react import.)

- [ ] **Step 2: Expose Logo on the Toolbar namespace**

At the bottom of the file, alongside the existing `Toolbar.X = X` assignments, add:

```tsx
Toolbar.Logo = ToolbarLogo;
```

- [ ] **Step 3: Type-check**

```bash
bun run --cwd=apps/mesh check
```

Expected: passes. If `usePublicConfig` types don't import cleanly, verify the import path matches existing usage in `apps/mesh/src/web/components/sidebar/navigation.tsx`.

- [ ] **Step 4: Format & commit**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/agent-shell-layout/toolbar.tsx
git commit -m "feat(toolbar): add Toolbar.Logo sub-component"
```

---

## Task 2: Restructure `org-shell-layout` — hoist header, unify trigger, drop dual-mount

**Files:**
- Modify: `apps/mesh/src/web/layouts/org-shell-layout/index.tsx`

This task replaces the file's render tree so `Toolbar.Header` is a sibling above `SidebarLayout`, `SidebarNavControls` mounts once, and mobile uses a top-level `Sheet`.

- [ ] **Step 1: Replace the file with the new shell structure**

Replace the entire contents of `apps/mesh/src/web/layouts/org-shell-layout/index.tsx` with:

```tsx
/**
 * Org Shell Layout
 *
 * Shared parent for `/$org/` (home) and `/$org/$taskId` (chat). Owns the
 * full-width toolbar header, the sidebar row beneath it, ChatPrefsProvider,
 * and the org-wide tasks panel. The tasks panel lives here, outside child-
 * route Suspense, so it stays mounted while the active task/chat switches.
 *
 * Shell shape:
 *   SidebarProvider
 *   └── app-shell-root (flex-col, h-dvh)
 *       ├── Toolbar.Header           — full-width, fixed left zone
 *       └── SidebarLayout            — body row
 *           ├── StudioSidebar (desktop only)
 *           ├── SidebarResizeHandle (desktop only)
 *           └── SidebarInset         — routed content
 *   + Sheet for mobile sidebar (rendered alongside, portal-based)
 */

import { Suspense } from "react";
import {
  SidebarInset,
  SidebarLayout,
  SidebarProvider,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { useIsMobile } from "@deco/ui/hooks/use-mobile.ts";
import { Sheet, SheetContent, SheetTitle } from "@deco/ui/components/sheet.tsx";
import { LayoutLeft, Loading01 } from "@untitledui/icons";
import { Outlet } from "@tanstack/react-router";
import { ToolbarIconButton } from "@/web/components/toolbar-icon-button";
import { SidebarResizeHandle } from "@/web/components/sidebar/sidebar-resize-handle";
import { useSidebarResize } from "@/web/hooks/use-sidebar-resize";
import { StudioSidebar, StudioSidebarMobile } from "@/web/components/sidebar";
import { ChatPrefsProvider } from "@/web/components/chat/context";
import { ThreadManagerProvider } from "@/web/components/chat/store/hooks";
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
import { Toolbar } from "@/web/layouts/agent-shell-layout/toolbar";
import { useLocalStorage } from "@/web/hooks/use-local-storage";

const SIDEBAR_OPEN_STORAGE_KEY = "sidebar.open";

function SidebarTriggerButton() {
  const { toggleSidebar } = useSidebar();
  return (
    <ToolbarIconButton onClick={toggleSidebar} aria-label="Toggle sidebar">
      <LayoutLeft size={16} />
    </ToolbarIconButton>
  );
}

function RouteFallback() {
  return (
    <div className="flex-1 flex items-center justify-center">
      <Loading01 size={20} className="animate-spin text-muted-foreground" />
    </div>
  );
}

function MobileSidebarSheet() {
  const { openMobile, setOpenMobile } = useSidebar();
  return (
    <Sheet open={openMobile} onOpenChange={setOpenMobile}>
      <SheetContent
        side="left"
        hideCloseButton
        className="w-[calc(100vw-3rem)] sm:max-w-md! p-0"
      >
        <SheetTitle className="sr-only">Navigation</SheetTitle>
        <div className="flex h-full">
          <div
            className="w-full bg-sidebar flex flex-col overflow-y-auto group/sidebar"
            data-state="expanded"
          >
            <StudioSidebarMobile onClose={() => setOpenMobile(false)} />
          </div>
        </div>
      </SheetContent>
    </Sheet>
  );
}

export default function OrgShellLayout() {
  const isMobile = useIsMobile();
  const [sidebarOpen, setSidebarOpen] = useLocalStorage<boolean>(
    SIDEBAR_OPEN_STORAGE_KEY,
    false,
  );
  const { width, wrapperRef, onStartResize, resetWidth } = useSidebarResize();

  return (
    <ThreadManagerProvider>
      <Toolbar.Provider>
        <SidebarProvider open={sidebarOpen} onOpenChange={setSidebarOpen}>
          <ChatPrefsProvider>
            <div className="app-shell-root flex flex-col h-dvh overflow-hidden">
              <Toolbar.Header>
                <Toolbar.LeftColumn>
                  <Toolbar.Logo />
                  <SidebarTriggerButton />
                  <span className="hidden md:contents">
                    <Toolbar.Nav />
                  </span>
                  <Toolbar.TogglesSlot />
                  <LinkedDesktopIndicator />
                </Toolbar.LeftColumn>
                <Toolbar.CenterSlot />
                <Toolbar.RightColumn>
                  <div className="min-w-0 flex-1 overflow-x-auto [scrollbar-width:none] flex justify-end">
                    <Toolbar.TabsSlot />
                  </div>
                  <Toolbar.RightSlot />
                </Toolbar.RightColumn>
              </Toolbar.Header>
              <SidebarLayout
                ref={wrapperRef}
                className="flex-1 bg-sidebar relative min-h-0"
                style={
                  {
                    "--sidebar-width": `${width}px`,
                    "--sidebar-width-icon": "3.5rem",
                  } as Record<string, string>
                }
              >
                {!isMobile && (
                  <>
                    <StudioSidebar />
                    <SidebarResizeHandle
                      onPointerDown={onStartResize}
                      onDoubleClick={resetWidth}
                    />
                  </>
                )}
                <SidebarInset
                  className="flex flex-col"
                  style={{
                    background: "transparent",
                    containerType: "inline-size",
                  }}
                >
                  <div className="flex flex-col h-full min-h-0">
                    <div className="flex-1 min-h-0 flex flex-row">
                      <Suspense fallback={<RouteFallback />}>
                        <Outlet />
                      </Suspense>
                    </div>
                  </div>
                </SidebarInset>
              </SidebarLayout>
              {isMobile && <MobileSidebarSheet />}
            </div>
          </ChatPrefsProvider>
        </SidebarProvider>
      </Toolbar.Provider>
    </ThreadManagerProvider>
  );
}
```

Key behavioral changes encoded above:
- `Toolbar.Header` is now a sibling above `SidebarLayout`, not nested inside `SidebarInset`.
- `SidebarTriggerButton` is unconditionally rendered (no `sidebarOpen ? ... : undefined` branch).
- `Toolbar.Logo` is the first item in the left zone (in front of the trigger).
- `Toolbar.Nav` (back/forward) is wrapped in `hidden md:contents` so it doesn't show on mobile (no behavior change vs. today, where mobile didn't show them at all).
- Mobile sheet is rendered once, at the shell root, instead of being co-located with a mobile-only toolbar.
- `MobileHomeToolbar`, `SidebarNavControls`, `SidebarToggleButton`, and `hasTaskRoute`/`useParams` are removed (no longer needed).
- `ChatPrefsProvider` is hoisted above `SidebarLayout` so child routes still get its context.

- [ ] **Step 2: Type-check**

```bash
bun run --cwd=apps/mesh check
```

Expected: passes. If `useParams` is reported as an unused import elsewhere, ignore — we removed its only use here.

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: passes. The custom oxlint plugins (ban-use-effect, ban-memoization) are not relevant here — no hooks added.

- [ ] **Step 4: Manual smoke (dev server)**

```bash
bun run dev
```

Open the app in a browser at the default URL. Verify:
- Header runs the full width of the viewport.
- Left zone shows: logo → sidebar toggle → back → forward.
- Click the sidebar toggle. The sidebar collapses to icon-rail width. Logo, toggle, back/forward **do not move**.
- Click the toggle again — sidebar expands. Header left zone still does not move.
- Resize the sidebar by dragging the handle. Header is unaffected.
- Resize the browser window down to mobile width (<768px). The sidebar disappears from the body; the header is still full-width; the trigger button now opens a `Sheet` overlay containing the mobile sidebar.
- Open a task route (`/$org/$taskId`). The agent-shell-layout's toolbar slots (tabs, center, right) populate correctly via portals.

If any of the above fails, **stop and debug before committing**.

- [ ] **Step 5: Format & commit**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/org-shell-layout/index.tsx
git commit -m "refactor(shell): hoist Toolbar.Header above sidebar, mount SidebarTrigger once"
```

---

## Task 3: Drop `SidebarLogoHeader` and `headerRight` from `NavigationSidebar`

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/navigation.tsx`

- [ ] **Step 1: Delete `SidebarLogoHeader` and update `NavigationSidebarInner`**

In `apps/mesh/src/web/components/sidebar/navigation.tsx`:

1. Delete the `SidebarLogoHeader` function (lines 21–48 in the current file).
2. Remove the now-unused imports: `DEFAULT_LOGO`, `usePublicConfig`, `SidebarHeader`. Keep `Suspense` only if used elsewhere (it isn't after this change — drop it too).
3. Remove `headerRight?: ReactNode;` from `NavigationSidebarProps`.
4. In `NavigationSidebarInner`, remove the `headerRight` destructure and remove the `<Suspense>…<SidebarLogoHeader />…</Suspense>` block.

The function should look like:

```tsx
function NavigationSidebarInner({
  sections,
  header,
  footer,
  additionalContent,
  variant = "sidebar",
  contentClassName,
}: NavigationSidebarProps) {
  return (
    <Sidebar variant={variant}>
      {header}
      <SidebarContent
        className={cn(
          "flex flex-col flex-1 px-2 py-2 gap-0.5",
          contentClassName,
        )}
      >
        {sections.map((section, index) => (
          <SidebarSectionRenderer key={index} section={section} />
        ))}
        {additionalContent && (
          <div className="flex flex-col flex-1 min-h-0 group-data-[state=collapsed]/sidebar:mt-1 group-data-[state=expanded]/sidebar:mt-2">
            {additionalContent}
          </div>
        )}
      </SidebarContent>
      {footer}
    </Sidebar>
  );
}
```

And the imports at the top should reduce to:

```tsx
import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarSeparator,
  useSidebar,
} from "@deco/ui/components/sidebar.tsx";
import { Skeleton } from "@deco/ui/components/skeleton.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import type { ReactNode } from "react";
import type { NavigationSidebarItem, SidebarSection } from "./types";
import { SidebarCollapsibleGroup } from "./sidebar-group";
import { track } from "@/web/lib/posthog-client";
```

The `NavigationSidebarProps` interface:

```tsx
interface NavigationSidebarProps {
  sections: SidebarSection[];
  header?: ReactNode;
  footer?: ReactNode;
  additionalContent?: ReactNode;
  variant?: "sidebar" | "floating" | "inset";
  contentClassName?: string;
}
```

- [ ] **Step 2: Type-check**

```bash
bun run --cwd=apps/mesh check
```

Expected: passes. If a downstream consumer still passes `headerRight`, the TS compiler will flag it — fix in that consumer (only `StudioSidebar` in `sidebar/index.tsx` should be affected, fixed in Task 4).

- [ ] **Step 3: Format & commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/navigation.tsx
git commit -m "refactor(sidebar): drop SidebarLogoHeader and headerRight prop"
```

---

## Task 4: Drop `headerRight` from `StudioSidebar`

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/index.tsx`

- [ ] **Step 1: Remove `headerRight` prop**

In `apps/mesh/src/web/components/sidebar/index.tsx`, change the `StudioSidebar` signature:

```tsx
export function StudioSidebar() {
  const sections = useProjectSidebarItems();

  return (
    <NavigationSidebar
      sections={sections}
      footer={<SidebarInboxFooter />}
      additionalContent={
        <ErrorBoundary>
          <Suspense
            fallback={
              <div className="px-2 py-2 text-xs text-muted-foreground">
                Loading tasks…
              </div>
            }
          >
            <SidebarTopActions />
            <TaskGroupsList />
          </Suspense>
        </ErrorBoundary>
      }
    />
  );
}
```

Remove the unused `type ReactNode` import if it's no longer referenced:

```tsx
import { Suspense } from "react";
```

(`StudioSidebarMobile` below should remain unchanged.)

- [ ] **Step 2: Type-check**

```bash
bun run --cwd=apps/mesh check
```

Expected: passes. All `headerRight` references should now be gone (verify with: search for `headerRight` in `apps/mesh/src/web/` — should be zero results).

- [ ] **Step 3: Lint**

```bash
bun run lint
```

Expected: passes (no unused imports remaining).

- [ ] **Step 4: Format & commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sidebar/index.tsx
git commit -m "refactor(sidebar): remove headerRight prop from StudioSidebar"
```

---

## Task 5: Simplify WCO CSS

**Files:**
- Modify: `apps/mesh/index.css`

- [ ] **Step 1: Replace the WCO media-query block**

In `apps/mesh/index.css`, replace lines 16–63 (the `/* Window Controls Overlay ... */` comment plus the `@media (display-mode: window-controls-overlay) { ... }` block) with:

```css
/* Window Controls Overlay (installed PWA on Chromium):
   The toolbar header is already the top element of the flex shell, so all
   we need to do is (1) make its background act as the OS drag region,
   (2) inset its content to clear the OS title-bar controls on the left
   and right, (3) hide elements that duplicate the chrome (e.g. app logo),
   and (4) opt buttons back to clickable.

   Lives outside @layer base so it wins against Tailwind utilities like
   h-12, pl-1, pr-2 that would otherwise cascade later. */
@media (display-mode: window-controls-overlay) {
  .app-titlebar {
    padding-left: env(titlebar-area-x, 0);
    padding-right: calc(
      100vw -
      env(titlebar-area-x, 0) -
      env(titlebar-area-width, 100vw)
    );
    min-height: env(titlebar-area-height, 3rem);
  }
  .wco-drag {
    -webkit-app-region: drag;
    app-region: drag;
  }
  .wco-drag button,
  .wco-drag a,
  .wco-drag input,
  .wco-drag [role="button"],
  .wco-no-drag {
    -webkit-app-region: no-drag;
    app-region: no-drag;
  }
  .wco-hide {
    display: none !important;
  }
}
```

Removed: `.app-shell-root { padding-top: ... }` and `position: fixed; top: 0; left: 0; right: 0; z-index: 50; height: ...` on `.app-titlebar`. The header is now in normal flow and takes its natural height.

- [ ] **Step 2: Type-check & lint**

```bash
bun run --cwd=apps/mesh check
bun run lint
```

Expected: both pass (CSS isn't type-checked, but verify no unrelated regressions).

- [ ] **Step 3: Manual WCO verification (optional but recommended)**

If you have a Chromium-based browser with PWA install support:

```bash
bun run dev
```

1. Open the app, install as a PWA from the browser menu.
2. Launch the PWA in standalone mode.
3. Verify: logo is hidden in the toolbar; OS window controls (close/min/max) are visible and unobstructed; clicking-and-dragging the header background drags the window; clicking buttons in the header (toggle, back, etc.) still works without dragging.

If you cannot test WCO locally, document this in the PR description and rely on a reviewer to verify.

- [ ] **Step 4: Format & commit**

```bash
bun run fmt
git add apps/mesh/index.css
git commit -m "fix(pwa): simplify WCO CSS now that header is full-width"
```

---

## Task 6: Final verification

**Files:** none modified.

- [ ] **Step 1: Run all checks together**

```bash
bun run --cwd=apps/mesh check && bun run lint && bun run fmt:check
```

Expected: all three pass.

- [ ] **Step 2: Confirm no stale references**

```bash
git grep -n "SidebarLogoHeader\|MobileHomeToolbar\|SidebarNavControls\|headerRight" apps/mesh/src/web
```

Expected: zero matches. If any appear, investigate — likely a missed cleanup.

- [ ] **Step 3: Full manual smoke test**

`bun run dev` and exercise:

| Scenario | Expected |
|---|---|
| Desktop, sidebar expanded | Logo + trigger + back/fwd in header left; sidebar visible with content; no double-header (no row inside sidebar above content). |
| Desktop, sidebar collapsed (click trigger) | Sidebar shrinks to icon rail; header content does **not** shift horizontally. |
| Desktop, drag resize handle | Sidebar width changes; header unaffected. |
| Mobile (resize browser < 768px) | Body shows no left sidebar; header has logo + trigger (no back/fwd); clicking trigger opens Sheet with mobile sidebar. |
| Open a task (any breakpoint) | Tabs and right-slot actions populate via portals from the task page; center slot shows task label if provided. |
| Navigate between routes | Header stays mounted; no flash or remount. |

- [ ] **Step 4: Done — no commit needed**

If everything above passes, the work is complete. The branch now contains 5 commits (one per task 1–5).

---

## Notes for the implementer

- **Do not** add backwards-compatibility shims for the deleted `headerRight` prop — it was only used in two files, both updated in this plan.
- **Do not** introduce new mobile UI in this PR (e.g., back/forward on mobile). The `hidden md:contents` wrapper around `Toolbar.Nav` preserves today's mobile behavior.
- **Do not** refactor `agent-shell-layout/toolbar.tsx` beyond adding `Toolbar.Logo`. The portal/slots model is intentional.
- If `SidebarInset` from `@deco/ui` complains about not having `SidebarProvider` as a *direct* ancestor (it shouldn't — context lookup walks the whole tree), wrap the affected subtree in a small forwarding `<SidebarProvider value={...}>`. Investigate before adding workarounds.
- The user runs in Conductor; verify changes by opening the dev server URL in a real browser, not just by reading the diff.
