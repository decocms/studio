# Linked Desktop Header Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a persistent header indicator that shows whether a desktop is linked to the current realm, doubling as a CTA to open `ConnectDesktopDialog` when offline.

**Architecture:** A new thin presentational component (`LinkedDesktopIndicator`) is rendered into `Toolbar.LeftColumn` in `org-shell-layout`. It reuses the existing `useCurrentLink()` hook for status polling and the existing `ConnectDesktopDialog` for click behavior. No new queries, no new server tools, no changes to data layer.

**Tech Stack:** React 19, TypeScript, Tailwind v4, `@deco/ui` (Tooltip, primitives), `@untitledui/icons` (`Monitor01`), TanStack Query (via the existing `useCurrentLink` hook).

**Spec:** `docs/superpowers/specs/2026-05-21-linked-desktop-header-indicator-design.md`

---

## File Structure

- **Create:** `apps/mesh/src/web/components/header/linked-desktop-indicator.tsx`
  - Renders a button using `useCurrentLink()` that toggles between "Desktop" (online) and "Connect desktop" (offline) states. Opens `ConnectDesktopDialog` on click.
- **Modify:** `apps/mesh/src/web/layouts/org-shell-layout/index.tsx`
  - Adds `<LinkedDesktopIndicator />` between `<Toolbar.Nav />` and `<Toolbar.TogglesSlot />` in `Toolbar.LeftColumn`.

The component lives in its own file under a new `components/header/` directory so future header-level chrome (account, status, etc.) has a clear home.

**Testing:** No unit tests are added. The component is a thin composition of already-tested primitives (`useCurrentLink`, `ConnectDesktopDialog`, `visibleCapabilities`). Verification is manual via the dev server, as called out in the spec's testing notes.

---

## Task 1: Create LinkedDesktopIndicator Component

**Files:**
- Create: `apps/mesh/src/web/components/header/linked-desktop-indicator.tsx`

- [ ] **Step 1: Create the component file**

Write the full component:

```tsx
import { useState } from "react";
import { Monitor01 } from "@untitledui/icons";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@deco/ui/components/tooltip.tsx";
import { cn } from "@deco/ui/lib/utils.ts";
import { useCurrentLink } from "@/web/hooks/use-current-link";
import {
  ConnectDesktopDialog,
  visibleCapabilities,
} from "@/web/components/chat/connect-desktop-dialog";

export function LinkedDesktopIndicator() {
  const link = useCurrentLink();
  const [dialogOpen, setDialogOpen] = useState(false);

  const labels = visibleCapabilities(link.capabilities);
  const tooltipContent = link.online ? (
    <div className="flex flex-col gap-0.5 text-xs">
      <span className="font-medium">{link.machineId ?? "Desktop linked"}</span>
      <span className="text-muted-foreground">
        {labels.length > 0
          ? `Available: ${labels.join(", ")}`
          : "No CLI agents detected"}
      </span>
    </div>
  ) : (
    <span className="text-xs">
      Run <code className="font-mono">bunx decocms link</code> on your desktop
    </span>
  );

  return (
    <>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            aria-label={
              link.online ? "Desktop linked" : "Connect your desktop"
            }
            className={cn(
              "flex items-center gap-1.5 h-7 px-2 rounded-md transition-colors",
              "hover:bg-sidebar-accent",
              link.online
                ? "text-sidebar-foreground/70 hover:text-sidebar-foreground"
                : "text-sidebar-foreground hover:text-sidebar-foreground",
            )}
          >
            <span className="relative inline-flex items-center justify-center">
              <Monitor01 size={16} />
              {link.online && (
                <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-success ring-2 ring-background" />
              )}
            </span>
            <span className="text-xs font-medium">
              {link.online ? "Desktop" : "Connect desktop"}
            </span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{tooltipContent}</TooltipContent>
      </Tooltip>
      <ConnectDesktopDialog open={dialogOpen} onOpenChange={setDialogOpen} />
    </>
  );
}
```

Notes for the implementer:
- `useCurrentLink()` is already org-scoped via `useProjectContext()` inside the hook — no params needed.
- The `success` color token is defined in the Tailwind design system (see `plugins/ensure-tailwind-design-system-tokens.ts`). If `bg-success` errors at lint time, fall back to `bg-green-500` and recheck token availability.
- React 19: do NOT add `useMemo`/`useCallback`/`memo` — the compiler handles optimization, and `plugins/ban-memoization.ts` will fail the lint.
- Do NOT use `useEffect` — `plugins/ban-use-effect.ts` will fail the lint.

- [ ] **Step 2: Run typecheck**

Run: `bun run check`
Expected: no errors related to the new file.

- [ ] **Step 3: Run lint**

Run: `bun run lint`
Expected: no errors related to the new file (in particular, no `ban-memoization`, `ban-use-effect`, or design-token violations).

- [ ] **Step 4: Format**

Run: `bun run fmt`
Expected: file reformatted in place by Biome (two-space indent, double quotes).

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/web/components/header/linked-desktop-indicator.tsx
git commit -m "feat(web): add LinkedDesktopIndicator component"
```

---

## Task 2: Wire the indicator into the org-shell toolbar

**Files:**
- Modify: `apps/mesh/src/web/layouts/org-shell-layout/index.tsx`

- [ ] **Step 1: Add the import**

In `apps/mesh/src/web/layouts/org-shell-layout/index.tsx`, add this import alongside the existing imports (group with other `@/web/components/*` imports):

```tsx
import { LinkedDesktopIndicator } from "@/web/components/header/linked-desktop-indicator";
```

- [ ] **Step 2: Render the indicator in the toolbar's LeftColumn**

Locate this block (around line 110–115):

```tsx
<Toolbar>
  <Toolbar.Header>
    <Toolbar.LeftColumn>
      <Toolbar.Nav />
      <Toolbar.TogglesSlot />
    </Toolbar.LeftColumn>
```

Insert `<LinkedDesktopIndicator />` between `<Toolbar.Nav />` and `<Toolbar.TogglesSlot />`:

```tsx
<Toolbar>
  <Toolbar.Header>
    <Toolbar.LeftColumn>
      <Toolbar.Nav />
      <LinkedDesktopIndicator />
      <Toolbar.TogglesSlot />
    </Toolbar.LeftColumn>
```

Do not change anything else in this file. The indicator is intentionally desktop-only — the mobile branch (`isMobile === true`) of this component uses `MobileHomeToolbar` and is untouched, matching the spec's non-goal.

- [ ] **Step 3: Run typecheck**

Run: `bun run check`
Expected: no errors.

- [ ] **Step 4: Run lint**

Run: `bun run lint`
Expected: no errors.

- [ ] **Step 5: Format**

Run: `bun run fmt`
Expected: clean run.

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/web/layouts/org-shell-layout/index.tsx
git commit -m "feat(web): show linked-desktop indicator in org shell header"
```

---

## Task 3: Manual verification

This task is non-coding. It is a checklist of things to verify in the browser before declaring the work complete. No commit at the end — just confirm.

- [ ] **Step 1: Start the dev server**

Run: `bun run dev`

Wait for both the migrations to apply and the Vite client to start (look for the `http://localhost:4000` line in the output).

- [ ] **Step 2: Open the app and navigate to an org**

Open `http://localhost:4000` in a browser, sign in if needed, and navigate to any organization route (e.g. `/$org/` home).

Verify: the header shows a `Monitor01` icon + "Connect desktop" label in the left column, right after the back/forward arrows.

- [ ] **Step 3: Hover the indicator (offline state)**

Verify: a tooltip appears below the indicator with `Run bunx decocms link on your desktop`.

- [ ] **Step 4: Click the indicator (offline state)**

Verify: `ConnectDesktopDialog` opens with title "Connect your desktop" and the `bunx decocms link` snippet visible.

Close the dialog.

- [ ] **Step 5: Link a desktop**

In a separate terminal: `bunx decocms link` (against the same dev server / realm).

Wait up to ~15s (the `useCurrentLink` poll interval). The indicator label should transition to "Desktop" with a green dot overlaid on the icon.

- [ ] **Step 6: Hover the indicator (online state)**

Verify: tooltip shows the machine ID (or "Desktop linked" if no machine ID is reported) plus the capability list (e.g. `Available: Claude Code, Codex`) — or "No CLI agents detected" when no visible capabilities are present.

- [ ] **Step 7: Click the indicator (online state)**

Verify: `ConnectDesktopDialog` opens with title "Desktop connected" and the linked machine details inside.

- [ ] **Step 8: Navigate to a chat route**

Open or create a task so the URL becomes `/$org/$taskId`. Verify the indicator still appears in the header (same `org-shell-layout` parent, so it should be unchanged).

- [ ] **Step 9: Switch to mobile viewport**

In Chrome DevTools, toggle device emulation to a mobile viewport. Verify the indicator does NOT appear (the mobile branch in `org-shell-layout` renders `MobileHomeToolbar`, not `Toolbar`).

- [ ] **Step 10: Verify empty state still works**

If a fresh org with no AI providers is available, visit it and verify the existing `SettingsCardItem` on `no-ai-provider-empty-state.tsx` still renders alongside the header indicator (both should reflect the same state).

---

## Self-Review Notes

- **Spec coverage:** Every section of the spec is mapped to a task. Placement (Task 2), component design + states (Task 1), data flow (Task 1 — uses existing hook), dialog reuse (Task 1), mobile (intentionally untouched in Task 2 — see note in step 2), empty-state behavior (intentionally untouched — verified in Task 3 step 10), edge cases (visible through manual verification in Task 3).
- **No placeholders:** All code blocks are complete. No "TODO" or "implement later" steps.
- **Type consistency:** `LinkedDesktopIndicator` is the only new exported symbol. The import in Task 2 matches the file path in Task 1.
- **React 19 / lint compliance:** Component avoids `useEffect`, `useMemo`, `useCallback`, and `memo`. Only `useState` is used (allowed). Tailwind tokens (`success`, `sidebar-foreground`, `sidebar-accent`, `background`, `muted-foreground`) are part of the design system already used elsewhere in the toolbar component (see `apps/mesh/src/web/layouts/agent-shell-layout/toolbar.tsx`).
