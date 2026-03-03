# Mobile-First Design — Shell + Agents Page

**Date:** 2026-03-01
**Ticket:** DECO-2128
**Scope:** Shell layout + Agents page (first wave)

## Guiding Principles

- **CSS-first**: Tailwind base classes (no prefix) are mobile. `md:` adds desktop overrides. Desktop is never touched by this work.
- **Minimal `isMobile`**: JS branching only where the component _hierarchy_ genuinely changes — not just styles. One check total in this scope.
- **No desktop regressions**: Desktop renders identically to before. Every change is additive via `md:`.

## Tailwind Breakpoints (no custom overrides in this project)

| Prefix | Min-width | Role |
|--------|-----------|------|
| _(none)_ | 0px | Mobile styles (write here first) |
| `sm:` | 640px | Unused in this work |
| `md:` | 768px | Desktop override (existing project standard) |

## Pre-requisite

Merge `layout-update` branch before implementing. It adds:
- Sidebar icon into the sidebar (desktop)
- User icon + chat icon into the page topbar

These are the triggers the mobile chat bottom sheet hooks into.

---

## Section 1: Shell Layout (`apps/mesh/src/web/layouts/shell-layout.tsx`)

**The one `isMobile` check in this entire scope.**

`ShellLayoutInner` becomes mobile-aware at the top level only:

```
Mobile  → plain flex-col container (Outlet fills height) + ChatBottomSheet
Desktop → existing ResizablePanelGroup unchanged
```

Why `isMobile` here instead of CSS: `ResizablePanelGroup` uses JS-driven panel widths and inline `overflow: hidden`. There's no clean way to make the chat appear as a bottom sheet purely with CSS while keeping the resizable panel structure. The branch is isolated to one component, clearly motivated.

**ChatBottomSheet** (`apps/mesh/src/web/components/chat/chat-bottom-sheet.tsx`):
- Radix `Sheet` with `side="bottom"`
- Triggered via the existing `useDecoChatOpen` hook (same hook the desktop chat panel uses)
- Opens on top of page content — ~20px of the page visible behind it as overlay
- Reuses `<ChatPanel />` as its content
- Only rendered in the mobile branch of `ShellLayoutInner`

**Desktop**: zero change — `ResizablePanelGroup` + `PersistentResizablePanel` exactly as before.

---

## Section 2: Page Header (`apps/mesh/src/web/components/page/index.tsx`)

**Problem**: `min-w-max` on `PageHeader` forces the container to be as wide as all its children, causing horizontal scroll on narrow screens.

**Fix**: Remove `min-w-max`. Keep `overflow-x-auto`. Add `min-w-0` to the left breadcrumb slot so long text truncates instead of pushing layout.

```
Before: "shrink-0 w-full border-b ... h-11 overflow-x-auto flex items-center ... min-w-max"
After:  "shrink-0 w-full border-b ... h-11 overflow-x-auto flex items-center ..."
Left slot: add min-w-0 to allow truncation
```

Desktop: visually identical — flex layout expands naturally. Mobile: content compresses gracefully instead of forcing scroll.

---

## Section 3: Agents Page (`apps/mesh/src/web/routes/orgs/agents.tsx`)

Two CSS-only changes:

### Cards grid
```
Before: "grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4"
After:  "grid grid-cols-1 md:grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4"
```
Mobile: single-column cards. Desktop: existing auto-fill grid.

### Content padding
```
Before: "flex-1 overflow-auto p-5"
After:  "flex-1 overflow-auto p-3 md:p-5"
```
Mobile: tighter padding (more content visible on small screens). Desktop: unchanged.

Table view: no changes. Horizontal scroll on mobile is acceptable. View toggle stays visible — don't restrict user choice.

---

## Section 4: ChatBottomSheet Component (new file)

**File**: `apps/mesh/src/web/components/chat/chat-bottom-sheet.tsx`

Uses `@deco/ui/components/sheet.tsx` with `side="bottom"`. Integrates with:
- `useDecoChatOpen()` — same hook as desktop, no new state
- `<ChatPanel />` — same component as desktop, no duplication

The sheet is an overlay, not a push layout — page content stays rendered behind it.

---

## Implementation Order

1. Merge `layout-update` branch
2. `chat-bottom-sheet.tsx` — new component
3. `shell-layout.tsx` — add `isMobile` branch, render `ChatBottomSheet` on mobile
4. `page/index.tsx` — remove `min-w-max`, add `min-w-0` to left slot
5. `agents.tsx` — update grid and padding classes
6. Visual QA on mobile viewport (390px) and desktop (1440px)
