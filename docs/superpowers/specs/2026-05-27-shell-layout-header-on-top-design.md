# Shell layout: header on top, sidebar underneath

## Problem

The current desktop shell renders the sidebar full-height on the left, with the toolbar header nested inside `SidebarInset` to the right. Three concrete problems:

1. **Jumpy collapse transition.** `SidebarNavControls` (back/forward + sidebar toggle) lives in two different DOM locations depending on sidebar state: inside the sidebar header when expanded (`StudioSidebar`'s `headerRight` prop), and inside `Toolbar.LeftColumn` when collapsed. Buttons teleport between containers on every collapse/expand.
2. **PWA Window Controls Overlay (WCO) is complex.** Because the header is not a top-level full-width bar, WCO mode has to re-pin `.app-titlebar` with `position: fixed`, reserve `padding-top` on `.app-shell-root`, and offset everything with `env(titlebar-area-x)`. Lots of moving parts to keep the OS chrome from colliding with header content.
3. **Visual mismatch.** The sidebar's own header row (`SidebarLogoHeader`, `h-12`) and the toolbar header (`h-12`) sit at the same y-coordinate but in different containers. They share a baseline without sharing a layout, which is the source of the alignment fragility above.

## Goal

Restructure the app shell so the header runs full-width across the top of the viewport and the sidebar sits below it on the left. Eliminate the dual-mount of `SidebarNavControls`. Simplify PWA WCO so the only thing it does is hide the logo.

## Non-goals

- Changing what's *inside* the sidebar (nav items, sections, footer) — content is untouched.
- Mobile redesign — the mobile `Sheet` pattern stays as is; only the trigger location adjusts to match the new shell.
- New features (search field, org switcher, etc.) in the freed-up sidebar header space.
- Touching `@deco/ui`'s `Sidebar` / `SidebarProvider` / `SidebarInset` internals.

## Design

### Shell DOM (desktop)

```
SidebarProvider
└── div.app-shell-root        (flex flex-col, h-screen)
    ├── header.app-titlebar   (full-width, h-12, border-b)
    │     ├── LeftZone: Logo + SidebarTrigger + Toolbar.Nav (back/fwd)
    │     ├── CenterSlot (portal target)
    │     └── RightZone: TabsSlot + RightSlot (portal targets)
    └── div.shell-body        (flex flex-row, flex-1, min-h-0)
        ├── StudioSidebar          (Sidebar variant="sidebar")
        ├── SidebarResizeHandle
        └── SidebarInset           (routed page content; scroll container)
```

The header is a sibling above the row that contains the sidebar and content. The header's left zone holds fixed-position elements in this order: `[Logo] [SidebarTrigger] [Back] [Forward]`. Nothing in this zone moves when the sidebar collapses.

### Mobile

Identical shell, with two differences:
- `StudioSidebarMobile` is rendered instead of `StudioSidebar`; it wraps the sidebar content in a `Sheet`.
- The `SidebarTrigger` in `Toolbar.LeftColumn` acts as the hamburger (behavior already provided by `@deco/ui` based on `isMobile`).

The header is already full-width on mobile today; this change does not alter mobile structure beyond consolidating the trigger location.

### Component changes

| File | Change |
|---|---|
| `apps/mesh/src/web/layouts/org-shell-layout/index.tsx` | Restructure to the vertical shell above. `Toolbar.Header` is a direct child of `app-shell-root`, not nested inside `SidebarInset`. `SidebarNavControls` is mounted **once**, unconditionally in `Toolbar.LeftColumn`. The `headerRight` prop on `StudioSidebar` is removed. |
| `apps/mesh/src/web/components/sidebar/navigation.tsx` | Delete `SidebarLogoHeader`. Remove `headerRight` from `NavigationSidebarProps`. `<Sidebar>` body starts directly with `SidebarContent`. |
| `apps/mesh/src/web/components/sidebar/index.tsx` | Remove the `headerRight` prop wiring on `StudioSidebar`. |
| `apps/mesh/src/web/layouts/agent-shell-layout/toolbar.tsx` | Add a `Toolbar.Logo` sub-component (mirrors `Toolbar.Nav` style) that renders the public-config logo with light/dark variants and `wco-hide` class. Wrap its internals in `<Suspense>` with a fixed-size (`h-6 w-6`) placeholder to prevent layout shift while `usePublicConfig()` resolves. `org-shell-layout` mounts it as the first child of `Toolbar.LeftColumn`. |
| `apps/mesh/index.css` | Simplify the WCO media query (see below). |

### Collapse transition behavior

- `SidebarTrigger` toggles state on `SidebarProvider` as it does today.
- `@deco/ui` animates the sidebar's width between expanded and collapsed (icon-rail) states; no custom animation is added.
- Because the header sits above the row that contains the sidebar, **nothing in the header moves** during collapse. The left zone is pixel-stable.

### PWA WCO simplification

Replace the current WCO media query in `apps/mesh/index.css` with:

```css
@media (display-mode: window-controls-overlay) {
  .app-titlebar {
    -webkit-app-region: drag;
    padding-left: env(titlebar-area-x, 0);
    padding-right: calc(100vw - env(titlebar-area-x, 0) - env(titlebar-area-width, 100vw));
    min-height: env(titlebar-area-height, 3rem);
  }
  .wco-hide { display: none; }
  .wco-no-drag { -webkit-app-region: no-drag; }
}
```

Removed:
- `position: fixed` on `.app-titlebar` — header is already the top element in normal document flow.
- `padding-top` on `.app-shell-root` — the titlebar takes its natural height in the flex column.

Retained:
- `.wco-hide` on the logo `<img>` so it doesn't compete with OS window-control buttons.
- `.wco-no-drag` on header buttons (drag region is the whole header).

### What gets deleted

- `SidebarLogoHeader` component.
- The `headerRight` prop chain: `org-shell-layout` → `StudioSidebar` → `NavigationSidebar` → `SidebarLogoHeader`.
- The `sidebarOpen ? <SidebarNavControls /> : undefined` and `!sidebarOpen && <SidebarNavControls />` branches in `org-shell-layout`.
- The `group-data-[state=collapsed]/sidebar:hidden` styling on the in-sidebar nav controls (the controls aren't in the sidebar anymore).
- WCO `position: fixed` / titlebar-area-x repositioning in `index.css`.

## Edge cases to verify during implementation

1. **`SidebarInset` parent requirement.** `@deco/ui`'s `SidebarInset` is typically a sibling of `Sidebar` under `SidebarProvider`. Quick spike: confirm it doesn't require `SidebarProvider` to be its *direct* parent. If it does, add a thin context-forwarding wrapper.
2. **`SidebarResizeHandle`** continues to operate on the sidebar's width within `shell-body`; geometry relative to its siblings is unchanged.
3. **Scroll containment.** `app-shell-root` is `h-screen`; `shell-body` is `flex-1 min-h-0`; `SidebarInset` becomes the scroll container for page content. Today's behavior is preserved.
4. **Logo Suspense.** `SidebarLogoHeader` wrapped the logo in `<Suspense fallback={<div className="h-10 shrink-0" />} />`. The new logo location needs an equivalent Suspense boundary with a fixed-size placeholder.
5. **Tab overflow.** `Toolbar.TabsSlot` may have more horizontal room than before. Existing overflow handling should still apply; verify visually.

## Testing

- **Manual desktop:** toggle sidebar collapsed/expanded — confirm logo, trigger, back/forward are pixel-stable in the header. Drag-resize the sidebar.
- **Manual mobile:** open the sheet from the hamburger in the toolbar; confirm sheet behavior unchanged.
- **PWA WCO:** install the PWA, launch as standalone window, verify the logo hides and OS title-bar controls are unobscured and draggable; verify header buttons remain clickable.
- **Route smoke test:** load a representative page from each top-level nav section (home, agents, connections, etc.) to make sure no page relies on `Toolbar.Header` being inside `SidebarInset` (e.g., portal targets resolve correctly).
- **Type/lint:** `bun run check` and `bun run lint` must pass. `bun run fmt` before committing.

No new unit tests are added; the shell is a visual layout concern.

## Rollout

Single PR. No feature flag — the change is purely structural and either renders correctly or doesn't.
