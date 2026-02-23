# UI Migration Design: studio-demo → apps/mesh

**Date:** 2026-02-23
**Status:** Approved
**Scope:** Visual/UX migration of `apps/mesh` to match the look and feel of `studio-demo`

---

## Context

`studio-demo` is a React SPA prototype representing the target visual design of the Mesh platform. This document describes how to migrate `apps/mesh` to match that design.

### Key decisions

- **Navigation model:** Adopt the demo's sidebar-first navigation. The demo's "workspace" concept maps to "project" in apps/mesh. The `org-admin` project is displayed as "Studio" and gets the dark sidebar treatment. No other project gets special treatment.
- **Data model unchanged:** Org/project hierarchy stays exactly as-is. Only the UI changes.
- **Component strategy:** Pragmatic mix — copy demo's design tokens wholesale, restyle existing shadcn components in `packages/ui` to match, port demo-specific components that have no shadcn equivalent.
- **Brand colors:** Kept in `packages/ui/src/styles/global.css` in a dedicated commented section, even if unused, for future use.
- **Chat toggle:** The sidebar header slot that shows a search icon in the demo will show the existing chat toggle button instead. The floating chat input from the demo is out of scope.
- **Phase 4 (pages):** High-level only — exact per-page decisions deferred to the implementation PR.

---

## Approach: Bottom-up (4 phases)

Each phase ships as an independent PR. Later phases build on earlier ones.

---

## Phase 1: Design Tokens

**File:** `packages/ui/src/styles/global.css`

Replace the current green-focused palette and system font stack with the demo's warm neutral palette and Inter Variable. This single change propagates visually across the entire app.

### Color changes

| Token | Current | New |
|---|---|---|
| `--primary` | `oklch(0.89 0.2 118)` (bright green) | `oklch(0.205 0.012 60)` (dark warm neutral) |
| `--primary-foreground` | `oklch(0.33 0.09 149)` | `oklch(0.98 0.005 60)` (off-white) |
| `--foreground` | `oklch(0.19 0.01 107)` (green tint) | `oklch(0.145 0.01 60)` (warm tint) |
| `--secondary` | greenish neutral | `oklch(0.955 0.006 80)` |
| `--muted` | `oklch(0.975 0.001 90)` | `oklch(0.955 0.006 80)` |
| `--muted-foreground` | `oklch(0.54 0.01 107)` | `oklch(0.46 0.012 60)` |
| `--accent` | greenish | `oklch(0.955 0.008 80)` |
| `--border` | `oklch(0.91 0 107)` | `oklch(0.915 0.005 80)` |
| `--input` | `oklch(0.88 0 107)` | `oklch(0.88 0.006 80)` |
| `--ring` | `oklch(0.36 0.01 107)` | `oklch(0.205 0.012 60)` |

All dark mode tokens updated analogously (warm neutral base, hue ~60).

### Typography

- `--font-sans`: replace system font stack with `"Inter Variable", ui-sans-serif, system-ui, sans-serif`
- Add Google Fonts import for Inter Variable (already in demo's CSS)
- `--font-mono`: keep CommitMono (already good)
- Body: `font-weight: 450` + `font-feature-settings: "cv01", "cv02", "cv03", "cv04", "cv08", "cv10", "ss08"`

### Sidebar tokens — additions

Add missing tokens to `:root` and `.dark`:
- `--sidebar-ring`
- `--sidebar-primary`
- `--sidebar-primary-foreground`

### Studio dark sidebar — new block

Add attribute-scoped override (triggers dark sidebar with zero JS):

```css
[data-studio] {
  --sidebar: oklch(0.18 0.008 60);
  --sidebar-foreground: oklch(0.82 0.006 60);
  --sidebar-accent: oklch(0.235 0.01 60);
  --sidebar-accent-foreground: oklch(0.96 0.005 60);
  --sidebar-border: oklch(0.255 0.008 60);
  --sidebar-primary: oklch(0.96 0.005 60);
  --sidebar-primary-foreground: oklch(0.18 0.008 60);
  --sidebar-ring: oklch(0.50 0.008 60);
}

.dark [data-studio],
[data-studio].dark {
  --sidebar: oklch(0.12 0.006 60);
  /* ... dark mode overrides */
}
```

### Shadow system

Replace the current single-variable shadow system (`--shadow-x`, `--shadow-y`, etc.) with the demo's multi-layer OKLCH shadow scale:

```css
--shadow-xs: oklch(0 0 0 / 0.03) 0px 1px 2px;
--shadow-sm: oklch(0 0 0 / 0.04) 0px 2px 4px, oklch(0 0 0 / 0.02) 0px 1px 2px;
--shadow-md: oklch(0 0 0 / 0.06) 0px 4px 12px, oklch(0 0 0 / 0.04) 0px 2px 4px;
--shadow-lg: oklch(0 0 0 / 0.08) 0px 8px 32px, oklch(0 0 0 / 0.06) 0px 4px 12px;
```

Add `--border-hairline: 1px` (scales to `0.5px` on hi-DPI via media query).

### Misc additions

- Add `text-wrap: balance` for `h1, h2, h3`
- Add `@media (prefers-reduced-motion)` block

### Brand colors (keep, do not delete)

Move to a dedicated commented section — not mapped into Tailwind `@theme`, but preserved for future use:

```css
/* ============================================================
   Brand colors — not in active use, kept for future reference
   ============================================================ */
--brand-green-light: #d0ec1a;
--brand-green-dark: #07401a;
--brand-purple-light: #a595ff;
--brand-purple-dark: #151042;
--brand-yellow-light: #ffc116;
--brand-yellow-dark: #392b02;
```

---

## Phase 2: Component Updates

**Location:** `packages/ui/src/components/`

### Restyle existing shadcn components (API unchanged)

| Component | What changes |
|---|---|
| `button.tsx` | `font-weight: 450`, tighter tracking; `default` variant uses new dark neutral primary |
| `sidebar.tsx` | Use `sidebar-ring`, `sidebar-primary`, `sidebar-primary-foreground` tokens; `SidebarMenuButton` active state matches demo |
| `badge.tsx` | Variant colors adjusted to demo's softer palette |
| `card.tsx` | Add subtle `shadow-xs` instead of border-only |
| `input.tsx` / `textarea.tsx` | Border/focus ring aligned to new warm neutral tokens |
| `select.tsx` / `combobox.tsx` | Same border/focus ring alignment |
| `tabs.tsx` | Active tab indicator matches demo style |

Components that need no changes (will update automatically via token changes): `dialog`, `alert-dialog`, `tooltip`, `popover`, `scroll-area`, `resizable`, `separator`.

### Port from demo (new additions to `packages/ui`)

| Component | Purpose |
|---|---|
| `empty-state.tsx` | Richer empty state with SVG illustration slot |
| `empty-state-illustrations.tsx` | SVG illustration set for empty states |
| `filter-bar.tsx` | Polished filter bar (replace current version) |
| `step-indicator.tsx` | Visual step progress indicator |
| `entity-link.tsx` | Typed link-to-entity component |

---

## Phase 3: Navigation / Layout Shell

**Files:** `apps/mesh/src/web/layouts/shell-layout.tsx`, `apps/mesh/src/web/components/sidebar/`, `apps/mesh/src/web/components/org-switcher.tsx`

### Layout structure change

**Before:**
```
AppTopbar (org switcher + chat button + user menu)
└── SidebarLayout
    ├── MeshSidebar
    └── SidebarInset
        ├── ProjectTopbar (breadcrumbs + plugin slots)
        └── Main content + ChatPanel (resizable)
```

**After:**
```
SidebarLayout  [data-studio when projectSlug === ORG_ADMIN_PROJECT_SLUG]
├── Sidebar
│   ├── SidebarHeader
│   │   ├── ProjectSwitcher (flex-1)
│   │   └── ChatToggleButton (icon, replaces search icon from demo)
│   ├── SidebarContent: nav items
│   └── SidebarFooter: Settings item + UserMenu
└── SidebarInset
    ├── Slim header (breadcrumbs only)
    └── Main content + ChatPanel (resizable, unchanged)
```

### Concrete changes

- **Remove `AppTopbar`** — org switcher moves into sidebar header as `ProjectSwitcher`; user menu moves to sidebar footer.
- **Remove `ProjectTopbar`** — replace with a slim inset header (breadcrumbs only, no full topbar height).
- **New `ProjectSwitcher` component** (ported from demo's `WorkspaceSwitcher`): two-panel popover — left panel lists orgs, right panel shows "Studio" at top + user projects below. Replaces `MeshOrgSwitcher`.
- **`data-studio` attribute** on `SidebarLayout` when `isOrgAdmin === true` — triggers the dark sidebar entirely via CSS, no JS color logic.
- **`UserMenu`** moves from `AppTopbar` to `SidebarFooter`.
- **Chat toggle button** sits in the sidebar header next to `ProjectSwitcher`, in the same slot the demo uses for its search icon.

### What stays the same

Resizable chat panel, `SidebarProvider` open-state persistence, `ProjectContextProvider`, auth guards — all internal wiring unchanged.

---

## Phase 4: Pages

Apply the new shell, tokens, and components consistently across all routes.

**Patterns to establish from demo:**
- `PageHeader` (title + actions row)
- `PageContent` (padding + max-width wrapper)
- `EmptyState` with illustrations
- `FilterBar` on list views
- `EntityGrid` / `EntityCard` for card-based lists

**Scope:** All existing routes under `/$org/org-admin/` and `/$org/$project/`.

Exact per-page decisions (what each page needs, whether to follow demo layouts closely or adapt) are deferred to the implementation PR for this phase.

---

## File map

| Phase | Primary files touched |
|---|---|
| 1 | `packages/ui/src/styles/global.css` |
| 2 | `packages/ui/src/components/*.tsx` (restyle) + new components ported from demo |
| 3 | `apps/mesh/src/web/layouts/shell-layout.tsx`, `components/sidebar/`, `components/org-switcher.tsx`, `components/user-menu.tsx` |
| 4 | `apps/mesh/src/web/routes/**/*.tsx` |
