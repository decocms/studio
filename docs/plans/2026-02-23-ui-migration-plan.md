# UI Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Migrate `apps/mesh` to match the visual design of `studio-demo`, working bottom-up: design tokens → component restyling → navigation shell → pages.

**Architecture:** Four independent phases, each shipped as its own PR. Design tokens in `packages/ui/src/styles/global.css` propagate automatically through the entire app. The existing org/project data model is unchanged — only visuals change. The org-admin project ("Studio") gets a dark sidebar via a CSS attribute selector `[data-studio]`, zero JS color logic.

**Tech Stack:** Tailwind CSS v4, OKLCH color tokens, shadcn/Radix UI, Bun test runner, `bun run check` for TypeScript, `bun run fmt` for formatting.

**Reference:** Design decisions are in `docs/plans/2026-02-23-ui-migration-design.md`. The source of visual truth is `studio-demo/src/` (git-ignored, available locally). Compare components side-by-side as you work.

---

## Phase 1: Design Tokens

### Task 1: Replace color palette and typography tokens

**Files:**
- Modify: `packages/ui/src/styles/global.css`

The current file uses a green-focused primary and system fonts. Replace with the demo's warm-neutral palette and Inter Variable. Keep CommitMono for mono.

**Step 1: Replace the Google Fonts import at the top of the file**

Current line 1:
```css
@import url("https://fonts.googleapis.com/css2?family=Inter:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap");
```

Replace with (Inter **Variable** — note the `+Variable` in the URL):
```css
@import url("https://fonts.googleapis.com/css2?family=Inter+Variable:ital,opsz,wght@0,14..32,100..900;1,14..32,100..900&display=swap");
```

**Step 2: Replace the `:root` color tokens**

Replace the entire `:root { ... }` block (lines 35–96) with:

```css
:root {
  --background: oklch(1 0 0);
  --foreground: oklch(0.145 0.01 60);
  --card: oklch(1 0 0);
  --card-foreground: oklch(0.145 0.01 60);
  --popover: oklch(1 0 0);
  --popover-foreground: oklch(0.145 0.01 60);
  --muted: oklch(0.955 0.006 80);
  --muted-foreground: oklch(0.46 0.012 60);
  --accent: oklch(0.955 0.008 80);
  --accent-foreground: oklch(0.20 0.01 60);
  --border: oklch(0.915 0.005 80);
  --input: oklch(0.88 0.006 80);
  --ring: oklch(0.205 0.012 60);

  --primary: oklch(0.205 0.012 60);
  --primary-foreground: oklch(0.98 0.005 60);

  --secondary: oklch(0.955 0.006 80);
  --secondary-foreground: oklch(0.20 0.01 60);

  --destructive: oklch(0.58 0.22 27);
  --destructive-foreground: oklch(0.97 0.01 17);
  --success: oklch(0.60 0.17 149);
  --success-foreground: oklch(0.98 0.02 156);
  --warning: oklch(0.75 0.15 70);
  --warning-foreground: oklch(0.99 0.02 95);

  --sidebar: oklch(0.975 0.006 80);
  --sidebar-foreground: oklch(0.20 0.01 60);
  --sidebar-accent: oklch(0.94 0.012 80);
  --sidebar-accent-foreground: oklch(0.20 0.01 60);
  --sidebar-border: oklch(0.915 0.005 80);
  --sidebar-ring: oklch(0.205 0.012 60);
  --sidebar-primary: oklch(0.205 0.012 60);
  --sidebar-primary-foreground: oklch(0.98 0.005 60);

  --font-sans: "Inter Variable", ui-sans-serif, system-ui, sans-serif;
  --font-serif: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  --font-mono:
    "CommitMono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;

  --spacing: 0.25rem;
  --radius: 0.375rem;
  --border-hairline: 1px;

  --shadow-xs: oklch(0 0 0 / 0.03) 0px 1px 2px;
  --shadow-sm: oklch(0 0 0 / 0.04) 0px 2px 4px, oklch(0 0 0 / 0.02) 0px 1px 2px;
  --shadow-md: oklch(0 0 0 / 0.06) 0px 4px 12px, oklch(0 0 0 / 0.04) 0px 2px 4px;
  --shadow-lg: oklch(0 0 0 / 0.08) 0px 8px 32px, oklch(0 0 0 / 0.06) 0px 4px 12px;
}
```

**Step 3: Replace the `.dark` color tokens**

Replace the entire `.dark { ... }` block with:

```css
.dark {
  --background: oklch(0.155 0.005 60);
  --foreground: oklch(0.96 0.005 60);
  --card: oklch(0.185 0.005 60);
  --card-foreground: oklch(0.96 0.005 60);
  --popover: oklch(0.22 0.005 60);
  --popover-foreground: oklch(0.96 0.005 60);
  --muted: oklch(0.23 0.005 60);
  --muted-foreground: oklch(0.62 0.008 60);
  --accent: oklch(0.26 0.005 60);
  --accent-foreground: oklch(0.96 0.005 60);
  --border: oklch(0.26 0.005 60);
  --input: oklch(0.28 0.005 60);
  --ring: oklch(0.82 0.01 60);

  --primary: oklch(0.82 0.01 60);
  --primary-foreground: oklch(0.14 0.01 60);

  --secondary: oklch(0.21 0.005 60);
  --secondary-foreground: oklch(0.96 0.005 60);

  --destructive: oklch(0.45 0.20 27);
  --destructive-foreground: oklch(0.97 0.01 17);
  --success: oklch(0.45 0.15 149);
  --success-foreground: oklch(0.97 0.02 156);
  --warning: oklch(0.65 0.15 70);
  --warning-foreground: oklch(0.98 0.02 95);

  --sidebar: oklch(0.175 0.005 60);
  --sidebar-foreground: oklch(0.96 0.005 60);
  --sidebar-accent: oklch(0.23 0.005 60);
  --sidebar-accent-foreground: oklch(0.96 0.005 60);
  --sidebar-border: oklch(0.26 0.005 60);
  --sidebar-ring: oklch(0.82 0.01 60);
  --sidebar-primary: oklch(0.82 0.01 60);
  --sidebar-primary-foreground: oklch(0.14 0.01 60);
}
```

**Step 4: Add Studio dark sidebar block after `:root`**

Insert this block immediately after the `:root { }` closing brace, before `.dark`:

```css
/* Studio (org-admin) — dark sidebar */
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
  --sidebar-foreground: oklch(0.82 0.005 60);
  --sidebar-accent: oklch(0.17 0.008 60);
  --sidebar-accent-foreground: oklch(0.96 0.005 60);
  --sidebar-border: oklch(0.19 0.006 60);
  --sidebar-primary: oklch(0.96 0.005 60);
  --sidebar-primary-foreground: oklch(0.14 0.006 60);
  --sidebar-ring: oklch(0.50 0.006 60);
}
```

**Step 5: Update `@theme inline` block — add new sidebar token mappings**

In the `@theme inline { }` block, find the sidebar color section and replace it with:

```css
  --color-sidebar: var(--sidebar);
  --color-sidebar-foreground: var(--sidebar-foreground);
  --color-sidebar-accent: var(--sidebar-accent);
  --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
  --color-sidebar-border: var(--sidebar-border);
  --color-sidebar-ring: var(--sidebar-ring);
  --color-sidebar-primary: var(--sidebar-primary);
  --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
```

Also update font mappings in `@theme inline` to use three fonts:
```css
  --font-sans: var(--font-sans);
  --font-mono: var(--font-mono);
  --font-serif: var(--font-serif);
```

Remove the `--shadow` (single-variable) mapping and the `--color-chart-*` mappings. The chart colors can be re-added if needed later (YAGNI).

**Step 6: Update `@layer base` — body and heading styles**

Find the `body` rule in `@layer base` and update it:

```css
body {
  @apply bg-background text-foreground font-sans antialiased;
  font-weight: 450;
  font-feature-settings: "cv01", "cv02", "cv03", "cv04", "cv08", "cv10", "ss08";
}

h1, h2, h3 {
  text-wrap: balance;
}
```

**Step 7: Add hi-DPI hairline and reduced-motion blocks**

At the end of the file, add:

```css
@media only screen and (min-device-pixel-ratio: 2),
  only screen and (min-resolution: 192dpi) {
  :root {
    --border-hairline: 0.5px;
  }
}

@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
```

**Step 8: Move brand colors to a dedicated commented section**

Find the `--brand-green-light` / `--brand-purple-*` / `--brand-yellow-*` variables in both `:root` and `.dark` and remove them from those blocks. Add a standalone block at the end of the file (before the media queries):

```css
/* ============================================================
   Brand colors — not in active Tailwind theme use.
   Kept for future reference / logo / marketing surfaces.
   ============================================================ */
:root {
  --brand-green-light: #d0ec1a;
  --brand-green-dark: #07401a;
  --brand-purple-light: #a595ff;
  --brand-purple-dark: #151042;
  --brand-yellow-light: #ffc116;
  --brand-yellow-dark: #392b02;
}
```

Also remove their `@theme inline` mappings (`--color-brand-*`).

**Step 9: Run type check and format**

```bash
bun run check
bun run fmt
```

Expected: no TypeScript errors, formatting applied.

**Step 10: Visually verify in browser**

```bash
bun run dev
```

Open the app. The primary color should now be dark/charcoal instead of bright green. Body text should render in Inter Variable. Open DevTools → Elements → `:root` to confirm CSS variables are set.

**Step 11: Commit**

```bash
git add packages/ui/src/styles/global.css
git commit -m "feat(ui): migrate design tokens to warm-neutral palette with Inter Variable"
```

---

## Phase 2: Component Updates

### Task 2: Restyle button and badge

**Files:**
- Modify: `packages/ui/src/components/button.tsx`
- Modify: `packages/ui/src/components/badge.tsx`

**Step 1: Update button**

Open `packages/ui/src/components/button.tsx`. The `default` variant already uses `bg-primary text-primary-foreground` — this will automatically pick up the new dark neutral primary from Phase 1.

The only visual tweak needed: in the base button className, ensure font-weight inherits from body (no explicit override needed since body is now 450). Verify the button looks right in the browser after Phase 1.

If the button has an explicit `font-medium` or `font-semibold`, remove it so it inherits `450` from body.

**Step 2: Update badge**

Open `packages/ui/src/components/badge.tsx`. Inspect the `default` variant — it uses `bg-primary`. With the new dark neutral primary this will look correct. Check the `secondary` and `outline` variants render cleanly against the new palette in the browser.

No code changes expected here unless something looks visually off.

**Step 3: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 4: Commit**

```bash
git add packages/ui/src/components/button.tsx packages/ui/src/components/badge.tsx
git commit -m "feat(ui): align button and badge to new design tokens"
```

---

### Task 3: Restyle card

**Files:**
- Modify: `packages/ui/src/components/card.tsx`

**Step 1: Add subtle shadow to card**

Open `packages/ui/src/components/card.tsx`. Find the root `Card` component className. Add `shadow-xs` to give cards the demo's subtle lifted appearance:

```tsx
// Before (approximate):
className={cn("rounded-xl border bg-card text-card-foreground", className)}

// After:
className={cn("rounded-xl border bg-card text-card-foreground shadow-xs", className)}
```

**Step 2: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 3: Visual verify**

Open any page with cards. They should appear with a very subtle lift shadow.

**Step 4: Commit**

```bash
git add packages/ui/src/components/card.tsx
git commit -m "feat(ui): add subtle shadow-xs to card component"
```

---

### Task 4: Restyle sidebar component — add missing token usage

**Files:**
- Modify: `packages/ui/src/components/sidebar.tsx`

**Step 1: Add sidebar-ring and sidebar-primary token usage**

Open `packages/ui/src/components/sidebar.tsx`. Search for focus ring and active state classes on `SidebarMenuButton`. Update them to use the new sidebar-specific tokens:

- Focus rings: `focus-visible:ring-sidebar-ring` (instead of generic `ring`)
- Active/selected state: use `bg-sidebar-primary text-sidebar-primary-foreground` for the active menu item

Compare with `studio-demo/src/components/ui/sidebar.tsx` for the exact active state classes used in the demo.

**Step 2: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 3: Commit**

```bash
git add packages/ui/src/components/sidebar.tsx
git commit -m "feat(ui): use sidebar-ring and sidebar-primary tokens in sidebar component"
```

---

### Task 5: Restyle input, select, and tabs

**Files:**
- Modify: `packages/ui/src/components/input.tsx`
- Modify: `packages/ui/src/components/select.tsx`
- Modify: `packages/ui/src/components/tabs.tsx`

These should largely self-correct from Phase 1 token changes. Do a visual pass:

**Step 1: Check input**

Open `packages/ui/src/components/input.tsx`. Verify border uses `border-input` and focus ring uses `ring-ring`. No changes expected — token changes handle it.

**Step 2: Check select**

Same as input — verify `border-input` and `ring-ring` are used. No code changes expected.

**Step 3: Update tabs active indicator**

Open `packages/ui/src/components/tabs.tsx`. Find `TabsTrigger`. The active/selected state should use the new dark primary. Compare with `studio-demo/src/components/ui/tabs.tsx` to confirm indicator style matches. Update if the underline/indicator style differs.

**Step 4: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 5: Commit**

```bash
git add packages/ui/src/components/input.tsx packages/ui/src/components/select.tsx packages/ui/src/components/tabs.tsx
git commit -m "feat(ui): verify input/select/tabs visual alignment with new tokens"
```

---

### Task 6: Port step-indicator and entity-link from demo

**Files:**
- Create: `packages/ui/src/components/step-indicator.tsx`
- Create: `packages/ui/src/components/entity-link.tsx`

**Step 1: Copy step-indicator from demo**

Copy `studio-demo/src/components/ui/step-indicator.tsx` to `packages/ui/src/components/step-indicator.tsx`.

Update imports:
- Replace `@/lib/utils` → `../lib/utils`
- Remove any demo-specific imports

**Step 2: Copy entity-link from demo**

Copy `studio-demo/src/components/ui/entity-link.tsx` to `packages/ui/src/components/entity-link.tsx`.

Update imports similarly.

**Step 3: Export from packages/ui index if one exists**

Check if `packages/ui/src/index.ts` exists. If so, add exports for the new components.

**Step 4: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 5: Commit**

```bash
git add packages/ui/src/components/step-indicator.tsx packages/ui/src/components/entity-link.tsx
git commit -m "feat(ui): port step-indicator and entity-link from studio-demo"
```

---

### Task 7: Update empty-state and filter-bar

**Files:**
- Modify: `packages/ui/src/components/empty-state.tsx`
- Modify: `packages/ui/src/components/filter-bar.tsx`

**Step 1: Compare empty-state with demo version**

Read both files:
- `packages/ui/src/components/empty-state.tsx` (current)
- `studio-demo/src/components/ui/empty-state.tsx` (reference)

The packages/ui version is close to the demo. Main thing to check: does it have the same icon container styling (`rounded-xl bg-muted/50`). Update any visual differences.

Also check if `studio-demo/src/components/ui/empty-state-illustrations.tsx` has illustrations worth porting. If yes, copy to `packages/ui/src/components/empty-state-illustrations.tsx` (update imports as in Task 6).

**Step 2: Compare filter-bar with demo version**

Read both:
- `packages/ui/src/components/filter-bar.tsx` (current)
- `studio-demo/src/components/ui/filter-bar.tsx` (reference)

Update any visual differences.

**Step 3: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 4: Commit**

```bash
git add packages/ui/src/components/empty-state.tsx packages/ui/src/components/filter-bar.tsx
git commit -m "feat(ui): align empty-state and filter-bar with studio-demo"
```

---

## Phase 3: Navigation / Layout Shell

### Task 8: Add `data-studio` attribute to shell layout

**Files:**
- Modify: `apps/mesh/src/web/layouts/shell-layout.tsx`

The CSS `[data-studio]` block added in Phase 1 gives the dark sidebar to any element with `data-studio` attribute. We just need to set it when `isOrgAdmin === true`.

**Step 1: Add the attribute to SidebarLayout**

In `shell-layout.tsx`, find `<SidebarLayout` (around line 261). Add a `data-studio` attribute conditionally:

```tsx
<SidebarLayout
  className="flex-1 bg-sidebar"
  data-studio={projectContext.project.isOrgAdmin ? "" : undefined}
  style={{
    "--sidebar-width": "13rem",
    "--sidebar-width-mobile": "11rem",
  } as Record<string, string>}
>
```

Note: `data-studio=""` sets the attribute (which CSS `[data-studio]` matches), `undefined` omits it.

**Step 2: Run check**

```bash
bun run check
```

**Step 3: Verify in browser**

Navigate to the org-admin view. The sidebar should now be dark. Navigate to a regular project — sidebar should be light. The color values come entirely from CSS; no JS color logic is needed.

**Step 4: Commit**

```bash
git add apps/mesh/src/web/layouts/shell-layout.tsx
git commit -m "feat(shell): apply data-studio attribute to trigger dark sidebar for org-admin"
```

---

### Task 9: Flip sidebar header dark/light logic to use CSS tokens

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/header/index.tsx`

**Context:** The current file has `const isDark = !isOrgAdmin` — dark for regular projects, light for org-admin. We need the opposite: `const isDark = isOrgAdmin`. Additionally, the hardcoded `bg-[#030302]`, `border-zinc-800`, `hover:bg-zinc-800`, `text-zinc-400` classes need to be replaced with the CSS token-based sidebar classes so `[data-studio]` drives the colors automatically.

**Step 1: Flip isDark logic**

```tsx
// Before:
// Dark variant for project sidebar, light for org-admin
const isDark = !isOrgAdmin;

// After:
// Studio (org-admin) gets dark sidebar treatment
const isDark = isOrgAdmin;
```

**Step 2: Replace hardcoded zinc classes with token-based classes**

The `isDark` branches in the JSX use hardcoded `bg-[#030302]`, `border-zinc-800`, etc. Since `[data-studio]` now overrides the `--sidebar-*` CSS variables, we can use those semantic classes everywhere and let the CSS handle the dark/light difference.

Replace all conditional `isDark ? "..." : "..."` color logic with the sidebar token classes that work for both:

- Container background: remove `isDark && "bg-[#030302] border-b border-zinc-800"` → the sidebar background comes from `var(--sidebar)` automatically via `SidebarHeaderUI`
- Icon/button hover: replace `isDark ? "hover:bg-zinc-800 text-zinc-400" : "hover:bg-sidebar-accent"` → use `hover:bg-sidebar-accent text-sidebar-foreground/50` for both
- Active chat button: replace `isDark ? "bg-zinc-800 text-white" : "bg-sidebar-accent"` → use `bg-sidebar-accent` for both
- Chevron icons: replace `isDark ? "text-zinc-400" : "text-muted-foreground"` → use `text-sidebar-foreground/40` for both

After the replacement, `isDark` is no longer needed in the JSX — remove it and the `const isDark` line entirely (the `data-studio` CSS handles all the visual difference).

Also update the Skeleton component to remove its `isDark` prop and hardcoded zinc classes.

**Step 3: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 4: Verify in browser**

- org-admin view: dark sidebar header with appropriate icon colors
- Regular project: light sidebar header

**Step 5: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/header/index.tsx
git commit -m "feat(shell): replace hardcoded sidebar header colors with CSS token classes"
```

---

### Task 10: Update ProjectSwitcher (MeshAccountSwitcher) to match demo style

**Files:**
- Modify: `apps/mesh/src/web/components/sidebar/header/account-switcher/index.tsx`
- Modify: `apps/mesh/src/web/components/sidebar/header/account-switcher/org-panel.tsx`
- Modify: `apps/mesh/src/web/components/sidebar/header/account-switcher/project-panel.tsx`

**Context:** The current `MeshAccountSwitcher` is the equivalent of the demo's `WorkspaceSwitcher`. Read the demo's `WorkspaceSwitcher` at `studio-demo/src/components/layout/sidebar/workspace-switcher.tsx` as your visual reference.

**Step 1: Read all four files**

Read:
- `apps/mesh/src/web/components/sidebar/header/account-switcher/index.tsx`
- `apps/mesh/src/web/components/sidebar/header/account-switcher/org-panel.tsx`
- `apps/mesh/src/web/components/sidebar/header/account-switcher/project-panel.tsx`
- `studio-demo/src/components/layout/sidebar/workspace-switcher.tsx`

**Step 2: Align switcher trigger button to demo style**

The trigger button in the demo shows:
- Workspace avatar icon (left)
- Org name in small muted text above project name (stacked)
- `ChevronSelectorVertical` icon (right)

Update `index.tsx` trigger button to match this layout. Keep the org/project data from `useProjectContext()` — only the visual structure changes.

**Step 3: Align popover panel layout to demo style**

The demo popover has a two-column layout:
- Left panel (~150px): org list with "Create org" at bottom
- Right panel: "Studio" entry at top, then "Projects" section with project list, "Create project" at bottom

Map the existing `org-panel.tsx` and `project-panel.tsx` to match this two-column layout. Keep all existing data/navigation logic; only update the visual structure and classNames.

The current mesh panels already have org and project lists — the demo's structure maps naturally onto them.

**Step 4: Remove any remaining hardcoded dark colors**

The account-switcher files may have `isDark`-based hardcoded color logic. Replace any remaining `zinc-*` or `[#030302]` classes with the sidebar token equivalents (`sidebar-accent`, `sidebar-foreground`, etc.).

**Step 5: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 6: Verify in browser**

Click the switcher in both org-admin (dark) and regular project (light) views. Two-panel popover should appear. Org list on left, Studio + projects on right.

**Step 7: Commit**

```bash
git add apps/mesh/src/web/components/sidebar/header/account-switcher/
git commit -m "feat(shell): align ProjectSwitcher visual layout to studio-demo style"
```

---

### Task 11: Slim down ProjectTopbar to breadcrumbs-only header

**Files:**
- Modify: `apps/mesh/src/web/components/topbar/project-topbar.tsx` (find exact path first)

**Step 1: Find the ProjectTopbar file**

```bash
find apps/mesh/src/web/components -name "*topbar*" -o -name "*project-topbar*"
```

**Step 2: Read the file**

Read the ProjectTopbar component and identify what it currently renders (breadcrumbs, plugin slots, action buttons, etc.).

**Step 3: Slim to breadcrumbs + plugin slot only**

The goal is a slim header bar (40-44px tall) that shows only:
- Breadcrumb navigation (left)
- Any plugin-injected content via `TopbarPortalProvider` (right)

Remove any full topbar chrome (shadows, heavy borders, large heights). The header should be visually minimal — a thin separator between sidebar and page content.

Reference: `studio-demo/src/components/layout/header.tsx` for the demo's slim header pattern.

**Step 4: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 5: Verify**

All project routes should still show breadcrumbs. The topbar should be slim, not a full toolbar.

**Step 6: Commit**

```bash
git add apps/mesh/src/web/components/topbar/
git commit -m "feat(shell): slim ProjectTopbar to breadcrumbs-only header"
```

---

### Task 12: Remove AppTopbar from no-context fallback path

**Files:**
- Modify: `apps/mesh/src/web/layouts/shell-layout.tsx`

**Context:** The `AppTopbar` is currently only used in the no-org-context fallback path (the `Topbar` function, lines 41-97). Since `AppTopbar` is being deprecated in favor of the sidebar-integrated approach, simplify this fallback.

**Step 1: Update the fallback render**

In `ShellLayoutContent`, find the early return when `!projectContext` (around line 210). Replace the `<Topbar />` with a minimal header or just remove it. The fallback is a loading/error state so it doesn't need full navigation chrome.

**Step 2: Remove unused imports**

Remove imports of `AppTopbar`, the `Topbar` function, and any related components if no longer used.

**Step 3: Run check and format**

```bash
bun run check && bun run fmt
```

**Step 4: Commit**

```bash
git add apps/mesh/src/web/layouts/shell-layout.tsx
git commit -m "feat(shell): remove AppTopbar from fallback path, cleanup unused imports"
```

---

## Phase 4: Pages

### Task 13: Page-level migration (deferred, high-level)

**Context:** This phase applies the new shell, tokens, and components consistently across all routes. Exact per-page decisions are deferred to the implementation PR for this phase. See `docs/plans/2026-02-23-ui-migration-design.md` Phase 4 section.

**High-level work per route:**
- Replace ad-hoc page headers with a consistent `PageHeader` component (title + actions row — port from demo's `page-header.tsx`)
- Replace ad-hoc page content wrappers with a consistent `PageContent` component (port from demo's `page-content.tsx`)
- Replace ad-hoc empty states with `EmptyState` from `packages/ui`
- Add `FilterBar` to list views (MCPs, agents, members)
- Use `EntityGrid`/`EntityCard` for card-based lists

**Routes to cover:**
- `/$org/$project/` — home/dashboard
- `/$org/org-admin/mcps` — MCPs list
- `/$org/org-admin/mcps/$id` — MCP detail
- `/$org/org-admin/members` — members
- `/$org/org-admin/projects` — projects
- `/$org/org-admin/agents` — agents
- `/$org/org-admin/store` — store
- `/$org/org-admin/monitoring` — monitoring
- Settings routes

**During implementation:** Go case-by-case, decide for each page how closely to follow the demo layout vs adapt to existing content.

---

## Verification checklist (per phase PR)

Before opening each PR:

```bash
bun run check      # TypeScript — must pass
bun run lint       # Linting — must pass
bun run fmt:check  # Formatting — must pass
bun test           # Tests — must pass
```

Visual checks:
- [ ] Light mode looks correct
- [ ] Dark mode looks correct
- [ ] org-admin (Studio) has dark sidebar
- [ ] Regular project has light sidebar
- [ ] Sidebar collapses correctly
- [ ] Chat toggle works
- [ ] Mobile layout is not broken
