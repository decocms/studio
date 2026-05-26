# Sidebar + Tasks Panel Merge — Design

**Status:** approved (brainstorming)
**Date:** 2026-05-25
**Owner:** tlgimenes

## Problem

Today the agent shell has two left columns:

- A narrow icon-only rail (`StudioSidebar` → `NavigationSidebar`) with logo, Home, plugin shortcuts, and a footer stack of Credits / Connections / Inbox / Settings / Account.
- A wider Tasks panel (`TasksPanel` → `TasksSection`) with a flat list of open threads sorted by `updated_at` and a header bar (search / member / type / new-chat).

Two columns chew layout space and split the user's mental model: "where I go" lives in column 1, "what I'm working on" lives in column 2. The new design merges both into a single sidebar (Linear/Conductor style) where today's narrow rail becomes the *collapsed* state of the same sidebar.

## Goals

- One left column. Wide by default, collapsible to today's icon rail.
- Tasks grouped by `virtual_mcp_id` so the sidebar doubles as an agent navigator.
- Per-group `+` to start a new thread on that VM.
- Decopilot pinned at the top; other groups ordered by most-recent task within the group.
- Keep today's `TaskRow` (two-line layout, status icon, hover-to-archive).
- No API changes — grouping happens client-side over the existing flat thread list.

## Non-goals

- Plugin sidebar registration (`registerRootSidebarItem`, `registerSidebarGroup`, `pinnedViews`) — removed from sidebar in scope of this refactor. They may return as a different surface later.
- Workflows entry in the sidebar — removed in this scope.
- Mobile layout changes — out of scope for this design pass (existing mobile sheet behavior is preserved).
- Server-side aggregation of "list of VMs with tasks" — not needed; client groups the flat list.

## Layout

### Expanded (~260px)

```
┌──────────────────────────────┐
│ ◉ deco/mesh              ⇤   │  logo · collapse toggle
├──────────────────────────────┤
│  🏠  Home                    │  fixed top buttons
│  ＋  New              ⌄      │  preserved popover button (the existing "+" )
│  ⚡  Connections             │
│  ◐  Balance         $12.40   │
├──────────────────────────────┤
│ Tasks            🔍   ⋯      │  search · filter menu (mine/all + type)
│                              │
│ ▼ ✨ Decopilot          ＋    │  pinned, always first
│   ┌──────────────────────┐   │
│   │ baum?            ◌   │   │  TaskRow (unchanged)
│   │ feat/x · 4m          │   │
│   └──────────────────────┘   │
│                              │
│ ▼ 🟢 mcps               ＋    │  groups: most-recent task desc
│   ┌──────────────────────┐   │
│   │ Fix HMR breakage ◌   │   │
│   │ feat/hmr · 1h        │   │
│   └──────────────────────┘   │
│                              │
│ ▶ 🌿 deco/iron          ＋    │  collapsed accordion
│ ▶ 🎯 admin-mcp          ＋    │
│ ▶ 🔵 ai-farmrio         ＋    │
│                              │
├──────────────────────────────┤
│ 📥  Inbox            (•)     │
├──────────────────────────────┤
│ 👤  Tiago Gimenes       ⚙    │  AccountPopover · Settings
│     deco-cms                 │
└──────────────────────────────┘
```

### Collapsed (~56px — today's narrow rail)

```
┌──────┐
│  ◉   │  logo · click to expand
├──────┤
│  🏠  │  Home
│  ＋  │  same "+" popover
│  ⚡  │  Connections
│  ◐   │  Balance
├──────┤
│  🔍  │  → GlobalSearchDialog
│  ✨  │  Decopilot — hover shows group popover
│  🟢  │  mcps
│  🌿  │  deco/iron
│  🎯  │  admin-mcp
│  🔵  │  ai-farmrio
├──────┤
│  📥  │  Inbox
├──────┤
│  ⚙   │  Settings
│  👤  │  AccountPopover
└──────┘
```

### Group anatomy

```
▼ 🟢 mcps                                  ＋    ← icon · name · per-group new-task
   ┌────────────────────────────────────────┐
   │ Fix HMR breakage                    ◌  │   ← title (current TaskRow line 1)
   │ feat/hmr · 1h                          │   ← branch · time   (status → archive on hover)
   ├────────────────────────────────────────┤
   │ Prod envvar missing                 ✓  │
   │ main · 3h                              │
   ├────────────────────────────────────────┤
   │ Add resilience test                 ✓  │
   │ tests/resilience · 2d                  │
   └────────────────────────────────────────┘
```

- Click chevron / group header row → collapse / expand.
- `＋` on the header creates a thread on that `virtual_mcp_id` and navigates.
- `McpAvatar` is removed from `TaskRow`. The automation badge (currently rendered on the avatar) moves inline next to the title, before the status slot, only when `task.trigger_id` is set.

## Behavior

### Grouping (client-side)

- Source: existing `useThreads()` paged list, filtered by `hidden: false`, sorted by `updated_at` desc (today's behavior).
- Group key: `task.virtual_mcp_id` (nullable — tool-call automation runs without a VM are bucketed under a synthetic "Automation runs" group at the bottom, or skipped, TBD in plan).
- Group order: Decopilot (`getWellKnownDecopilotVirtualMCP(org.id).id`) pinned first; remaining groups sorted by `max(updated_at)` within group, desc.
- Inside a group: rows keep their current `updated_at` desc order — no per-group resort.
- Infinite scroll: the existing `useInfiniteScroll` hook stays on the section's scroll container. As new pages load, groups appear / reflow as their keys show up.

### Group expanded / collapsed state

- Per-group state persists in `localStorage` (key prefix `sidebar.group.<virtualMcpId>`).
- Default: Decopilot expanded; other groups expanded if they contain the currently active task, otherwise collapsed.
- New groups (e.g. first thread created on a fresh VM) default expanded.

### Filters

Section header keeps Search; member (mine/all) and type (all/manual/automation) filters fold into a single `⋯` dropdown.

- Filtering applies *across* all groups.
- A group with zero matches stays in the list but renders dimmed and disabled (chevron + `＋` only). This keeps the group order stable as filters change so the user's eye doesn't lose place.

### Collapsed-state hover popover

When the sidebar is in icon-rail mode and the user hovers a VM icon:

- A popover anchored to the icon (right side, sideOffset matched to the rail width) renders the same accordion contents for that group.
- Clicking a task inside the popover navigates as usual and closes the popover.
- The per-group `＋` inside the popover works the same.
- Mouse-leave closes after a short delay (~150ms) to forgive diagonal travel.

### "New" button at the top

- Existing popover behavior is preserved verbatim (icon, popover content, trigger).
- This is the discovery surface for starting a thread on a VM that has no current group in the list. The popover already shows agents / quick actions today.

### Footer

- **Inbox**: existing popover (invitations). Same red-dot affordance.
- **Account / Settings row**: shows the active user's avatar, name, and current org slug. Clicking the row opens the `AccountPopover` (which already handles org switching). The `⚙` icon at the right of the row navigates to `/$org/settings` — same behavior as today's footer Settings button.
- **Collapsed-state footer order**: Inbox → Settings → AccountPopover (Settings rendered *above* the account avatar so it sits closer to the rest of the rail and the account avatar anchors the very bottom).

## Components & files

### New

- `apps/mesh/src/web/components/sidebar/task-groups/index.tsx` — groups the flat thread list by `virtual_mcp_id` and renders accordions.
- `apps/mesh/src/web/components/sidebar/task-groups/group.tsx` — single VM group accordion (header + body), and collapsed-state popover.
- `apps/mesh/src/web/components/sidebar/task-groups/use-group-state.ts` — per-group expanded/collapsed `localStorage` state.

### Modified

- `apps/mesh/src/web/components/sidebar/index.tsx` — `StudioSidebar` becomes the single sidebar surface. Pulls in fixed top buttons + Tasks section + footer.
- `apps/mesh/src/web/components/sidebar/navigation.tsx` — accept a wider expanded width; `collapsible="icon"` semantics for the collapsed rail.
- `apps/mesh/src/web/components/sidebar/footer/inbox.tsx` — strip top-of-footer items (Credits, Connections) that move to the fixed-buttons section. Keep Inbox + Account + Settings.
- `apps/mesh/src/web/layouts/tasks-panel/index.tsx` — content moves into the sidebar. The standalone `TasksPanel` route surface is retired; `TasksSection` is reused inside the new group component (or its row-list parts are extracted).
- `apps/mesh/src/web/layouts/tasks-panel/task-row.tsx` — drop `McpAvatar`; render automation badge inline.
- `apps/mesh/src/web/layouts/agent-shell-layout/tasks-panel-column.tsx` — deleted.
- `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx` — remove the second column from the flex-row; sidebar carries the tasks now. `tasksOpen` state and the tasks toggle button in `ToggleButtons` either go away or repurpose to toggle the sidebar.
- `apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx` — the tasks toggle becomes a sidebar toggle (or is dropped if shadcn's built-in sidebar trigger covers it).
- `apps/mesh/src/web/hooks/use-project-sidebar-items.tsx` — drop `pluginRootSidebarItems`, `pinnedViews`, and `workflowsItem`. Reduce to a static `[homeItem]` + the new-popover button + Connections + Balance. (Eventually this file may collapse entirely if nothing else uses it.)
- `apps/mesh/src/web/components/sidebar/navigation-mobile.tsx` — mobile sheet keeps current behavior (out of scope).

### Removed from sidebar (not deleted from codebase yet)

- Plugin registration of root sidebar items via `pluginRootSidebarItems`.
- `pluginSidebarGroups` rendering in the sidebar.
- `pinnedViews` rendering in the sidebar (project UI `pinnedViews` data remains in `project.ui` for now; just not rendered in the sidebar).
- `workflowsItem` from `useProjectSidebarItems`.

## Open questions for implementation plan

- **Tool-call automation runs without a `virtual_mcp_id`**: bucket under a synthetic group, hide, or show ungrouped at the bottom? Decide in the implementation plan with one example task in hand.
- **shadcn `Sidebar` `collapsible="icon"` width**: the current rail is ~56px. shadcn's default icon width is configurable; pick a value that matches today exactly so the visual diff in collapsed state is zero.
- **Tasks toggle in toolbar**: today `ToggleButtons` has a tasks toggle. With the merge, "tasks toggle" overlaps with "sidebar toggle". Likely drop the tasks toggle and use shadcn's `SidebarTrigger` somewhere in the toolbar.
- **Group icon source**: today's `McpAvatar` reads the VM entity. Group header uses the same — just bigger / no badge. Confirm sizing in the plan.
- **`Workflows` removal blast radius**: only sidebar entry is removed; routes / pages stay reachable by URL.

## Testing

- Unit: client-side grouping function (decopilot first, others by `max(updated_at)`, stable inside group).
- Unit: filter dim-but-stable behavior — group ordering identical before/after filter toggle.
- Component: collapsed-state hover popover opens, navigates, and closes correctly.
- Visual / manual: collapsed sidebar matches today's narrow rail to the pixel; expanded sidebar renders without horizontal scrolling at 1280px viewport.

## Telemetry

Preserve existing PostHog events (`tasks_panel_*`, `nav_item_clicked`) on the new surfaces. Add:

- `sidebar_group_toggled` (`{ virtual_mcp_id, expanded }`)
- `sidebar_group_new_clicked` (`{ virtual_mcp_id }`)
- `sidebar_group_hover_popover_opened` (`{ virtual_mcp_id }`) — collapsed state
