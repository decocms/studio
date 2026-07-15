# Standalone Blocks Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Blocks as a Preview-backed Main tab with an independently toggleable Blocks panel in the `Chat | Blocks | Main` workspace.

**Architecture:** First restore the distinct pre-`e25f039` Preview and Blocks tab components as a tested checkpoint. Then add URL-backed Blocks visibility, promote the editor-only Blocks experience into the shell's persistent resizable workspace, and leave Preview/Code/Automations/Settings in the existing Main tab system. A small workspace context synchronizes page selection and preview reload requests without coupling either panel's visibility to the other.

**Tech Stack:** React 19, TypeScript, TanStack Router, TanStack Query, `react-resizable-panels`, Bun test, Playwright, Biome, Oxlint.

---

## File map

### Restore checkpoint

- Create `apps/mesh/src/web/layouts/main-panel-tabs/preview-tab.tsx`: restored Preview-only Main tab.
- Create, then later repurpose, `apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab.tsx`: restored Blocks-only Main tab and eventual standalone panel state boundary.
- Delete `apps/mesh/src/web/layouts/main-panel-tabs/preview-blocks-tab.tsx`: remove the merged render path.
- Modify `apps/mesh/src/web/layouts/main-panel-tabs/index.tsx`: distinct Preview and Blocks branches for Stage 1; remove Blocks branch in Stage 2.
- Modify `apps/mesh/src/web/layouts/main-panel-tabs/tab-id.ts`: restore normal Main-tab close behavior, then retain `blocks` only as a legacy input.
- Modify `apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.ts`: restore the old order, then remove Blocks when it becomes a shell toggle.

### Independent workspace state

- Modify `apps/mesh/src/web/index.tsx`: validate the `blocks` search parameter.
- Modify `apps/mesh/src/web/hooks/use-layout-state.ts`: derive and mutate independent Chat, Blocks, and Main visibility, including legacy migration.
- Modify `apps/mesh/src/web/hooks/use-layout-state.test.ts`: cover defaults, legacy URLs, last-panel protection, and panel sizing.
- Create `apps/mesh/src/web/hooks/use-blocks-panel-width.ts`: persist the Blocks/Main split.
- Modify `apps/mesh/src/web/lib/localstorage-keys.ts`: register the Blocks panel width key.

### Blocks/Preview separation

- Create `apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-state.ts`: pure shared-target/revision transitions.
- Create `apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-state.test.ts`: pure transition coverage.
- Create `apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-context.tsx`: React provider around the pure state.
- Create `apps/mesh/src/web/components/sandbox/blocks/blocks-panel.tsx`: Blocks state boundary plus editor-only content.
- Modify `apps/mesh/src/web/components/sandbox/content/content-browser.tsx`: accept shared page/section selection and save callbacks.
- Modify `apps/mesh/src/web/components/sandbox/preview/preview.tsx`: become Preview-only and consume shared selection/reload state.
- Delete `apps/mesh/src/web/components/sandbox/preview/preview-surface.ts` and its test after no consumers remain.
- Delete `apps/mesh/src/web/components/sandbox/preview/tab-intent.ts`: replace the module-global handoff with workspace context.
- Delete `apps/mesh/src/web/layouts/agent-shell-layout/secondary-panel-context.tsx`: the Blocks editor no longer portals out of Preview.

### Shell and controls

- Modify `apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx`: add the independent Blocks toggle beside Chat.
- Replace `apps/mesh/src/web/layouts/agent-shell-layout/chat-main-panel-group.tsx` with `apps/mesh/src/web/layouts/agent-shell-layout/workspace-panel-group.tsx`: persistent Chat, Blocks, and Main panels.
- Modify `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`: provide workspace context, wire desktop controls, and select one mobile surface.
- Modify `apps/mesh/src/web/layouts/main-panel-tabs/main-panel-tabs-bar.tsx`: prevent closing the final visible Main panel.
- Modify `apps/mesh/src/web/layouts/main-panel-tabs/mobile-main-panel-tab-select.tsx`: selecting Main on mobile closes Blocks.
- Modify `apps/mesh/src/web/layouts/main-panel-tabs/resolve-tab-icon.ts`: keep the Blocks icon as a shell-control icon rather than a Main tab icon.

### Black-box verification

- Create `packages/e2e/tests/standalone-blocks-panel.spec.ts`: independent desktop toggles, three visible panels, preserved Main selection, and mobile exclusivity.

## Task 1: Restore the separate Preview and Blocks Main tabs

**Files:**

- Create: `apps/mesh/src/web/layouts/main-panel-tabs/preview-tab.tsx`
- Create: `apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab.tsx`
- Delete: `apps/mesh/src/web/layouts/main-panel-tabs/preview-blocks-tab.tsx`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/index.tsx`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/tab-id.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/tab-id.test.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.test.ts`
- Modify: `apps/mesh/src/web/components/sandbox/preview/preview.tsx`

- [ ] **Step 1: Change the pure tests to describe the restored behavior**

Replace the Blocks click and source-order assertions with:

```ts
test("clicking active Blocks tab closes Main", () => {
  expect(
    resolveTabClickTarget({
      clickedId: "blocks",
      activeTab: "blocks",
      mainOpen: true,
    }),
  ).toBe("0");
});

test("returns Preview, Blocks, and Code for clonable source", () => {
  expect(getSourceSystemTabs(true)).toEqual([
    { id: "preview", title: "Preview" },
    { id: "blocks", title: "Blocks" },
    { id: "code", title: "Code" },
  ]);
});
```

- [ ] **Step 2: Run the focused tests and verify the regression is exposed**

Run:

```bash
bun test apps/mesh/src/web/layouts/main-panel-tabs/tab-id.test.ts apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.test.ts
```

Expected: FAIL because active Blocks currently resolves to `preview` and Blocks precedes Preview.

- [ ] **Step 3: Restore the two tab components and ordinary toggle semantics**

Create `preview-tab.tsx` with the pre-`e25f039` source check and `<PreviewContent />`. Restore `blocks-tab.tsx` from `e25f039^`, including `resolveBlocksTabState`, retry behavior, and `<PreviewContent surface="blocks" />`. In `index.tsx`, use separate branches:

```tsx
if (activeTab === "preview") {
  return <PreviewTab virtualMcpId={virtualMcpId} />;
}
if (activeTab === "blocks") {
  return <BlocksTab virtualMcpId={virtualMcpId} />;
}
```

Key the boundary directly by `activeTab`:

```tsx
<ErrorBoundary key={activeTab}>
  <Suspense fallback={<MainPanelLoading />}>
    <TabBody {...props} />
  </Suspense>
</ErrorBoundary>
```

Restore the pure click helper:

```ts
export function resolveTabClickTarget(ctx: {
  clickedId: string;
  activeTab: string;
  mainOpen: boolean;
}): string {
  if (ctx.mainOpen && ctx.clickedId === ctx.activeTab) return "0";
  return ctx.clickedId;
}
```

Restore the Preview/Blocks/Code order, delete `preview-blocks-tab.tsx`, and revert the iframe-overlay synchronization hunk from `e25f039` so each remounted surface owns its own overlay lifecycle.

- [ ] **Step 4: Run the Stage 1 test checkpoint**

Run:

```bash
bun test apps/mesh/src/web/layouts/main-panel-tabs/tab-id.test.ts apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.test.ts apps/mesh/src/web/components/sandbox/preview/preview-surface.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Format and commit the restoration checkpoint**

```bash
bun run fmt
git add apps/mesh/src/web/layouts/main-panel-tabs apps/mesh/src/web/components/sandbox/preview/preview.tsx
git commit -m "fix(blocks): restore standalone tab render path"
```

## Task 2: Add independent Blocks URL state and legacy migration

**Files:**

- Modify: `apps/mesh/src/web/index.tsx`
- Modify: `apps/mesh/src/web/hooks/use-layout-state.ts`
- Modify: `apps/mesh/src/web/hooks/use-layout-state.test.ts`

- [ ] **Step 1: Write failing state and migration tests**

Extend `resolveDefaultPanelState` expectations to include `blocksOpen`, then add:

```ts
test("?blocks=1 opens Blocks without changing Main", () => {
  expect(
    resolveDefaultPanelState({
      entityMetadata: { defaultMainView: { type: "preview" } },
      mainParamPresent: true,
      mainParamValue: "preview",
      blocksParamPresent: true,
      blocksParamValue: 1,
    }),
  ).toEqual({ chatOpen: false, blocksOpen: true, mainOpen: true });
});

test("legacy ?main=blocks becomes Blocks-only", () => {
  expect(
    resolveDefaultPanelState({
      entityMetadata: null,
      mainParamPresent: true,
      mainParamValue: "blocks",
      blocksParamPresent: false,
    }),
  ).toEqual({ chatOpen: false, blocksOpen: true, mainOpen: false });
});

test("a Blocks default becomes Blocks-only", () => {
  expect(
    resolveDefaultPanelState({
      entityMetadata: { defaultMainView: { type: "blocks" } },
      mainParamPresent: false,
      blocksParamPresent: false,
    }),
  ).toEqual({ chatOpen: false, blocksOpen: true, mainOpen: false });
});

test("canCloseWorkspacePanel protects the final visible panel", () => {
  expect(
    canCloseWorkspacePanel("blocks", {
      chatOpen: false,
      blocksOpen: true,
      mainOpen: false,
    }),
  ).toBe(false);
  expect(
    canCloseWorkspacePanel("blocks", {
      chatOpen: false,
      blocksOpen: true,
      mainOpen: true,
    }),
  ).toBe(true);
});
```

- [ ] **Step 2: Run the layout-state test and verify it fails**

Run:

```bash
bun test apps/mesh/src/web/hooks/use-layout-state.test.ts
```

Expected: FAIL because `blocksOpen` and `canCloseWorkspacePanel` do not exist.

- [ ] **Step 3: Implement the three visibility fields**

Add `blocks?: number` to `unifiedChatSearchSchema` and `PanelSearchParams`. Expand the state/action interfaces:

```ts
export type WorkspacePanel = "chat" | "blocks" | "main";

export interface WorkspaceVisibility {
  chatOpen: boolean;
  blocksOpen: boolean;
  mainOpen: boolean;
}

export function canCloseWorkspacePanel(
  panel: WorkspacePanel,
  visibility: WorkspaceVisibility,
): boolean {
  const openCount = Number(visibility.chatOpen) +
    Number(visibility.blocksOpen) + Number(visibility.mainOpen);
  const panelOpen = panel === "chat"
    ? visibility.chatOpen
    : panel === "blocks"
      ? visibility.blocksOpen
      : visibility.mainOpen;
  return panelOpen && openCount > 1;
}
```

Derive legacy state before normal Main state:

```ts
const def = ctx.entityMetadata?.defaultMainView ?? null;
const defaultIsChat = def == null || def.type === "chat";
const defaultIsBlocks = def?.type === "blocks";
const legacyBlocks = ctx.mainParamPresent && ctx.mainParamValue === "blocks";
const blocksDefaultOpen = defaultIsBlocks || legacyBlocks;
const blocksOpen = ctx.blocksParamPresent
  ? ctx.blocksParamValue === 1
  : blocksDefaultOpen;
const mainOpen = legacyBlocks || defaultIsBlocks
  ? false
  : ctx.mainParamPresent
    ? ctx.mainParamValue !== "0"
    : !defaultIsChat;
const chatOpen = defaultIsChat ? true : (ctx.entityMetadata?.chatDefaultOpen ?? false);
```

Expose `toggleBlocks` and guard all three close actions with `canCloseWorkspacePanel`. Desktop `toggleBlocks` must update only `{ blocks: blocksOpen ? 0 : 1 }`.

- [ ] **Step 4: Run the focused tests**

```bash
bun test apps/mesh/src/web/hooks/use-layout-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit independent URL state**

```bash
bun run fmt
git add apps/mesh/src/web/index.tsx apps/mesh/src/web/hooks/use-layout-state.ts apps/mesh/src/web/hooks/use-layout-state.test.ts
git commit -m "feat(layout): add independent Blocks panel state"
```

## Task 3: Add pure shared Blocks/Preview workspace state

**Files:**

- Create: `apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-state.ts`
- Create: `apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-state.test.ts`
- Create: `apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-context.tsx`

- [ ] **Step 1: Write failing transition tests**

```ts
import { describe, expect, test } from "bun:test";
import {
  blocksPreviewWorkspaceReducer,
  INITIAL_BLOCKS_PREVIEW_WORKSPACE,
} from "./blocks-preview-workspace-state";

describe("blocksPreviewWorkspaceReducer", () => {
  test("selects a page without changing preview visibility", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      { type: "select", target: { kind: "page", key: "pages-home", path: "/" } },
    );
    expect(next.target).toEqual({ kind: "page", key: "pages-home", path: "/" });
    expect(next.previewRevision).toBe(0);
  });

  test("save requests exactly one preview refresh", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      { type: "saved" },
    );
    expect(next.previewRevision).toBe(1);
  });

  test("edit SEO records both target and intent", () => {
    const next = blocksPreviewWorkspaceReducer(
      INITIAL_BLOCKS_PREVIEW_WORKSPACE,
      { type: "edit-seo", target: { kind: "page", key: "pages-home", path: "/" } },
    );
    expect(next.editSeoPageKey).toBe("pages-home");
    expect(next.target?.key).toBe("pages-home");
  });
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-state.test.ts
```

Expected: FAIL because the state module does not exist.

- [ ] **Step 3: Implement the pure reducer and provider**

Use this state contract:

```ts
export type BlocksTarget =
  | { kind: "page"; key: string; path: string }
  | { kind: "section"; key: string };

export interface BlocksPreviewWorkspaceState {
  target: BlocksTarget | null;
  editSeoPageKey: string | null;
  previewRevision: number;
}

export type BlocksPreviewWorkspaceAction =
  | { type: "select"; target: BlocksTarget }
  | { type: "edit-seo"; target: Extract<BlocksTarget, { kind: "page" }> }
  | { type: "consume-edit-seo" }
  | { type: "saved" };
```

The context exposes `state`, `selectTarget`, `editSeo`, `consumeEditSeo`, and `notifySaved`. Implement actions with `useReducer`; do not put Chat/Main/Blocks visibility in this provider.

- [ ] **Step 4: Run the pure test**

```bash
bun test apps/mesh/src/web/components/sandbox/blocks/blocks-preview-workspace-state.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit shared workspace state**

```bash
bun run fmt
git add apps/mesh/src/web/components/sandbox/blocks
git commit -m "feat(blocks): add preview workspace coordination"
```

## Task 4: Build an editor-only persistent Blocks panel

**Files:**

- Create: `apps/mesh/src/web/components/sandbox/blocks/blocks-panel.tsx`
- Modify: `apps/mesh/src/web/components/sandbox/content/content-browser.tsx`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab.tsx`

- [ ] **Step 1: Add the BlocksPanel state-boundary component**

Move the lifecycle/query-state logic from `blocks-tab.tsx` into `blocks-panel.tsx`. For the content state, render the existing editor browser rather than `PreviewContent`:

```tsx
if (state.kind === "loading") return <MainPanelLoading />;
if (state.kind === "empty") return <BlocksEmptyState />;
if (state.kind === "error") {
  return <BlocksErrorState source={state.source} onRetry={retry} />;
}
return (
  <div data-testid="blocks-panel" className="h-full min-h-0 overflow-hidden">
    <ContentBrowser mode="blocks" />
  </div>
);
```

Keep `blocks-tab.tsx` as a one-line compatibility wrapper during this task:

```tsx
export { BlocksPanel as BlocksTab } from "@/web/components/sandbox/blocks/blocks-panel";
```

- [ ] **Step 2: Add a Blocks mode to ContentBrowser**

Add this public contract:

```ts
export interface ContentBrowserProps {
  mode?: "content" | "blocks";
}

export function ContentBrowser({ mode = "content" }: ContentBrowserProps) {
  const workspace = useBlocksPreviewWorkspace();
  // existing sandbox setup
}
```

In `mode="blocks"`, initialize on `pages`, keep the page/section navigator and `SectionsEditor`, and omit non-Blocks collections (`apps`, `site`, `seo`, `calendar`, blog, loaders, and actions). When a page or saved section is selected, dispatch:

```ts
if (next?.collection === "pages") {
  workspace.selectTarget({
    kind: "page",
    key: next.key,
    path: next.path,
  });
}
if (next?.collection === "sections") {
  workspace.selectTarget({ kind: "section", key: next.key });
}
```

Pass `onSaved={workspace.notifySaved}` and the context's SEO intent into `SectionsEditor`. Consume the SEO intent after the matching page editor opens.

- [ ] **Step 3: Verify Blocks/content pure tests and types locally**

Run:

```bash
bun test apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab-state.test.ts apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab.test.tsx apps/mesh/src/web/components/sandbox/content
bun run --cwd=apps/mesh check
```

Expected: tests PASS and TypeScript reports no errors.

- [ ] **Step 4: Commit the editor-only Blocks panel**

```bash
bun run fmt
git add apps/mesh/src/web/components/sandbox/blocks apps/mesh/src/web/components/sandbox/content/content-browser.tsx apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab.tsx
git commit -m "feat(blocks): render editor-only panel"
```

## Task 5: Make Preview independent of Blocks

**Files:**

- Modify: `apps/mesh/src/web/components/sandbox/preview/preview.tsx`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/preview-tab.tsx`
- Delete: `apps/mesh/src/web/components/sandbox/preview/preview-surface.ts`
- Delete: `apps/mesh/src/web/components/sandbox/preview/preview-surface.test.ts`
- Delete: `apps/mesh/src/web/components/sandbox/preview/tab-intent.ts`

- [ ] **Step 1: Convert PreviewContent to a Preview-only component**

Remove the `surface` prop and CMS-only branches. The view mode becomes:

```ts
type PreviewViewMode = "preview" | "visual";
const [viewMode, setViewMode] = useState<PreviewViewMode>("preview");
```

Remove `createPortal`, `useSecondaryPanel`, `useColumnResize`, lazy `SectionsEditor`, `CMS_EDITOR_SCRIPT`, CMS selection/variant state, and the inline/portaled Sections editor JSX. Keep the iframe, page picker, visual editor, device controls, sandbox state cards, and drawer behavior unchanged.

- [ ] **Step 2: Consume shared target and save revision**

Read `useBlocksPreviewWorkspace()`. When a shared page target changes, drive the existing Preview navigation state; when a section target changes, use the existing global-section preview URL builder. Synchronize `previewRevision` to the iframe with one narrowly scoped effect:

```ts
const [handledRevision, setHandledRevision] = useState(
  workspace.state.previewRevision,
);
// oxlint-disable-next-line ban-use-effect/ban-use-effect -- synchronizes persisted Block saves with the mounted preview iframe
useEffect(() => {
  if (handledRevision === workspace.state.previewRevision) return;
  setHandledRevision(workspace.state.previewRevision);
  reloadPreviewPreservingScroll();
}, [handledRevision, workspace.state.previewRevision]);
```

When Preview's own page picker changes, call `workspace.selectTarget` as well, so reopening Blocks lands on the same page.

- [ ] **Step 3: Replace Preview-to-Blocks navigation**

For actions such as Edit SEO, dispatch the context intent and open Blocks without changing Main:

```ts
workspace.editSeo({ kind: "page", key: currentPageKey, path: currentPath });
navigate({
  to: ".",
  search: (prev: Record<string, unknown>) => ({ ...prev, blocks: 1 }),
  replace: true,
});
```

Delete `preview-surface.ts`, its test, and the module-global `tab-intent.ts` after `rg` confirms they have no consumers.

- [ ] **Step 4: Run Preview and Blocks tests**

```bash
bun test apps/mesh/src/web/components/sandbox/preview apps/mesh/src/web/components/sandbox/blocks apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab-state.test.ts
bun run --cwd=apps/mesh check
```

Expected: all tests PASS and type checking succeeds.

- [ ] **Step 5: Commit the component separation**

```bash
bun run fmt
git add apps/mesh/src/web/components/sandbox/preview apps/mesh/src/web/components/sandbox/blocks apps/mesh/src/web/layouts/main-panel-tabs/preview-tab.tsx
git commit -m "refactor(preview): separate Blocks editor from iframe"
```

## Task 6: Remove Blocks from Main tabs and add its shell toggle

**Files:**

- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/index.tsx`
- Delete: `apps/mesh/src/web/layouts/main-panel-tabs/blocks-tab.tsx`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.test.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/tab-id.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/tab-id.test.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/resolve-tab-icon.ts`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/resolve-tab-icon.test.ts`
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx`

- [ ] **Step 1: Write failing Main-tab registry tests**

Change the source-tab expectation to:

```ts
test("returns Preview and Code for clonable source", () => {
  expect(getSourceSystemTabs(true)).toEqual([
    { id: "preview", title: "Preview" },
    { id: "code", title: "Code" },
  ]);
});
```

Change the fixed-tab assertion so `FIXED_SYSTEM_TABS` excludes `blocks`, while keeping a dedicated legacy predicate test:

```ts
expect(FIXED_SYSTEM_TABS).not.toContain("blocks");
expect(isLegacyBlocksTab("blocks")).toBe(true);
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
bun test apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.test.ts apps/mesh/src/web/layouts/main-panel-tabs/tab-id.test.ts apps/mesh/src/web/layouts/main-panel-tabs/resolve-tab-icon.test.ts
```

Expected: FAIL because Blocks is still registered as a Main system tab.

- [ ] **Step 3: Remove Blocks from Main**

Delete the Blocks branch and wrapper file. Change the source tab type to `"preview" | "code"`, remove Blocks from `FIXED_SYSTEM_TABS` and `SystemTabId`, and add:

```ts
export function isLegacyBlocksTab(tabId: string | undefined): boolean {
  return tabId === "blocks";
}
```

Legacy layout state continues to consume this value; new Main tab lists never emit it.

- [ ] **Step 4: Add the Blocks toolbar toggle**

Use `TextInput` with the same `HeaderTabButton` chrome as Chat:

```tsx
<HeaderTabButton
  title="Blocks"
  icon={{ kind: "component", Component: TextInput }}
  active={blocksOpen}
  disabled={disableBlocksToggle}
  onClick={toggleBlocks}
/>
```

Expose props `blocksAvailable`, `blocksOpen`, `toggleBlocks`, and `disableBlocksToggle`. Render the control only for clonable-source agents. Keep order `Chat`, `Blocks`, `Library`.

- [ ] **Step 5: Run focused tests and commit**

```bash
bun test apps/mesh/src/web/layouts/main-panel-tabs/source-system-tabs.test.ts apps/mesh/src/web/layouts/main-panel-tabs/tab-id.test.ts apps/mesh/src/web/layouts/main-panel-tabs/resolve-tab-icon.test.ts
bun run fmt
git add apps/mesh/src/web/layouts/main-panel-tabs apps/mesh/src/web/layouts/agent-shell-layout/toggle-buttons.tsx
git commit -m "feat(blocks): promote Blocks to shell toggle"
```

## Task 7: Render Chat, Blocks, and Main as persistent resizable panels

**Files:**

- Create: `apps/mesh/src/web/layouts/agent-shell-layout/workspace-panel-group.tsx`
- Delete: `apps/mesh/src/web/layouts/agent-shell-layout/chat-main-panel-group.tsx`
- Delete: `apps/mesh/src/web/layouts/agent-shell-layout/secondary-panel-context.tsx`
- Create: `apps/mesh/src/web/hooks/use-blocks-panel-width.ts`
- Modify: `apps/mesh/src/web/hooks/use-layout-state.ts`
- Modify: `apps/mesh/src/web/hooks/use-layout-state.test.ts`
- Modify: `apps/mesh/src/web/lib/localstorage-keys.ts`
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`

- [ ] **Step 1: Write failing panel-size tests**

Replace `computeChatMainSizes` coverage with:

```ts
test.each([
  [{ chatOpen: true, blocksOpen: false, mainOpen: false }, { chat: 100, blocks: 0, main: 0 }],
  [{ chatOpen: false, blocksOpen: true, mainOpen: false }, { chat: 0, blocks: 100, main: 0 }],
  [{ chatOpen: false, blocksOpen: false, mainOpen: true }, { chat: 0, blocks: 0, main: 100 }],
  [{ chatOpen: true, blocksOpen: false, mainOpen: true }, { chat: 33, blocks: 0, main: 67 }],
  [{ chatOpen: false, blocksOpen: true, mainOpen: true }, { chat: 0, blocks: 40, main: 60 }],
  [{ chatOpen: true, blocksOpen: true, mainOpen: false }, { chat: 40, blocks: 60, main: 0 }],
  [{ chatOpen: true, blocksOpen: true, mainOpen: true }, { chat: 25, blocks: 35, main: 40 }],
])("computes workspace sizes", (visibility, expected) => {
  expect(computeWorkspacePanelSizes(visibility)).toEqual(expected);
});
```

- [ ] **Step 2: Run the test and verify it fails**

```bash
bun test apps/mesh/src/web/hooks/use-layout-state.test.ts
```

Expected: FAIL because `computeWorkspacePanelSizes` is not implemented.

- [ ] **Step 3: Implement sizing and persisted Blocks width**

Implement the exact table above as a pure helper. Add `blocksPanelWidth` to `LOCALSTORAGE_KEYS` and mirror `use-chat-panel-width.ts` in `use-blocks-panel-width.ts` with a 40 percent default and numeric normalization.

- [ ] **Step 4: Build WorkspacePanelGroup**

Keep all three contents mounted in collapsible panels. Use an outer Chat/workspace split and an inner Blocks/Main split so a collapsed middle panel never breaks resize handles:

```tsx
<ResizablePanelGroup direction="horizontal">
  <PersistentChatPanel>{chatContent}</PersistentChatPanel>
  <ResizableHandle className="bg-sidebar" />
  <ResizablePanel>
    <ResizablePanelGroup direction="horizontal">
      <PersistentBlocksPanel>
        <BlocksPanel virtualMcpId={virtualMcpId} />
      </PersistentBlocksPanel>
      <ResizableHandle className="bg-sidebar" />
      <PersistentMainPanel>
        <MainPanelWithDrawer taskId={taskId} virtualMcpId={virtualMcpId} />
      </PersistentMainPanel>
    </ResizablePanelGroup>
  </ResizablePanel>
</ResizablePanelGroup>
```

The outer workspace is open when `blocksOpen || mainOpen`; the inner split applies Blocks/Main sizes. Set `data-testid="chat-panel"`, `data-testid="blocks-panel-shell"`, and `data-testid="main-panel"` on the three cards. Remove `SecondaryPanelProvider` and its portal slot.

- [ ] **Step 5: Wire the provider, controls, and final-panel guards**

Mount `BlocksPreviewWorkspaceProvider` inside `VmEventsBridge` and above the toolbar portals plus `WorkspacePanelGroup`. Pass:

```tsx
<ToggleButtons
  chatOpen={layout.chatOpen}
  blocksAvailable={hasClonableSource}
  blocksOpen={layout.blocksOpen}
  toggleChat={layout.toggleChat}
  toggleBlocks={layout.toggleBlocks}
  disableChatToggle={
    layout.chatOpen && !layout.blocksOpen && !layout.mainOpen
  }
  disableBlocksToggle={
    layout.blocksOpen && !layout.chatOpen && !layout.mainOpen
  }
/>
```

Pass `disableActiveMainToggle={!layout.chatOpen && !layout.blocksOpen}` to `MainPanelTabsBar` so clicking the final visible Main tab cannot close it.

- [ ] **Step 6: Run layout tests, typecheck, and commit**

```bash
bun test apps/mesh/src/web/hooks/use-layout-state.test.ts apps/mesh/src/web/layouts/main-panel-tabs
bun run --cwd=apps/mesh check
bun run fmt
git add apps/mesh/src/web/layouts/agent-shell-layout apps/mesh/src/web/hooks apps/mesh/src/web/lib/localstorage-keys.ts apps/mesh/src/web/layouts/main-panel-tabs/main-panel-tabs-bar.tsx
git commit -m "feat(layout): add Chat Blocks Main workspace"
```

## Task 8: Implement mutually exclusive mobile surfaces

**Files:**

- Modify: `apps/mesh/src/web/hooks/use-layout-state.ts`
- Modify: `apps/mesh/src/web/hooks/use-layout-state.test.ts`
- Modify: `apps/mesh/src/web/layouts/agent-shell-layout/index.tsx`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/mobile-main-panel-tab-select.tsx`
- Modify: `apps/mesh/src/web/layouts/main-panel-tabs/mobile-main-panel-tab-select.test.ts`

- [ ] **Step 1: Write failing mobile transition tests**

Add a pure helper and tests:

```ts
expect(mobileSurfaceSearch("chat", "preview")).toEqual({
  chat: 1,
  blocks: 0,
  main: "0",
});
expect(mobileSurfaceSearch("blocks", "preview")).toEqual({
  chat: 0,
  blocks: 1,
  main: "0",
});
expect(mobileSurfaceSearch("main", "preview")).toEqual({
  chat: 0,
  blocks: 0,
  main: "preview",
});
```

- [ ] **Step 2: Run the tests and verify they fail**

```bash
bun test apps/mesh/src/web/hooks/use-layout-state.test.ts apps/mesh/src/web/layouts/main-panel-tabs/mobile-main-panel-tab-select.test.ts
```

Expected: FAIL because mobile has no Blocks surface transition.

- [ ] **Step 3: Implement single-surface mobile rendering**

Render exactly one branch:

```tsx
const mobileSurface = layout.blocksOpen
  ? "blocks"
  : layout.mainOpen
    ? "main"
    : "chat";

{mobileSurface === "blocks" ? (
  <BlocksPanel virtualMcpId={virtualMcpId} />
) : mobileSurface === "main" ? (
  <MainPanelWithDrawer taskId={layout.taskId} virtualMcpId={virtualMcpId} />
) : (
  <ActiveTaskBoundary />
)}
```

Mobile Chat and Blocks controls use `mobileSurfaceSearch`. Selecting any item in `MobileMainPanelTabSelect` writes `{ blocks: 0, chat: 0, main: target }`.

- [ ] **Step 4: Run mobile tests and commit**

```bash
bun test apps/mesh/src/web/hooks/use-layout-state.test.ts apps/mesh/src/web/layouts/main-panel-tabs/mobile-main-panel-tab-select.test.ts
bun run --cwd=apps/mesh check
bun run fmt
git add apps/mesh/src/web/hooks/use-layout-state.ts apps/mesh/src/web/hooks/use-layout-state.test.ts apps/mesh/src/web/layouts/agent-shell-layout/index.tsx apps/mesh/src/web/layouts/main-panel-tabs/mobile-main-panel-tab-select.tsx apps/mesh/src/web/layouts/main-panel-tabs/mobile-main-panel-tab-select.test.ts
git commit -m "feat(blocks): add mobile standalone surface"
```

## Task 9: Add black-box regression coverage

**Files:**

- Create: `packages/e2e/tests/standalone-blocks-panel.spec.ts`

- [ ] **Step 1: Write the desktop E2E scenario**

Use the clonable-agent setup from `sandbox-drawer-everywhere.spec.ts`. Start at `?chat=1&blocks=0&main=preview`, then assert:

```ts
await expect(page.getByTestId("chat-panel")).toBeVisible();
await expect(page.getByTestId("main-panel")).toBeVisible();
await page.getByRole("button", { name: "Blocks" }).click();
await expect(page).toHaveURL(/blocks=1/);
await expect(page).toHaveURL(/main=preview/);
await expect(page.getByTestId("blocks-panel-shell")).toBeVisible();
await expect(page.getByTestId("chat-panel")).toBeVisible();
await expect(page.getByTestId("main-panel")).toBeVisible();
```

Switch Main to Code and Settings and assert Blocks remains visible and `blocks=1` remains in the URL. Collapse and reopen Blocks and assert its editor selection remains.

- [ ] **Step 2: Add final-panel and mobile scenarios**

For desktop, open Blocks-only through legacy `?main=blocks` and assert its active Blocks toggle is disabled. For mobile, set a phone viewport and assert only one of the three panel test IDs is visible after each Chat, Blocks, and Main selection.

- [ ] **Step 3: Run the E2E file**

```bash
bun run --cwd=packages/e2e test:e2e tests/standalone-blocks-panel.spec.ts
```

Expected: all scenarios PASS.

- [ ] **Step 4: Commit E2E coverage**

```bash
bun run fmt
git add packages/e2e/tests/standalone-blocks-panel.spec.ts
git commit -m "test(blocks): cover standalone workspace panel"
```

## Task 10: Final cleanup and verification

**Files:**

- Modify only files identified by formatting, type, lint, or test failures caused by this change.

- [ ] **Step 1: Confirm obsolete coupling is gone**

Run:

```bash
rg -n "PreviewBlocksTab|PreviewSurface|surface=\"blocks\"|SecondaryPanelProvider|useSecondaryPanel|main=blocks|goToTab\(\"blocks\"\)" apps/mesh/src packages/e2e
```

Expected: no live Preview/Blocks coupling. `main=blocks` may appear only in legacy migration tests and E2E compatibility coverage.

- [ ] **Step 2: Run formatting and static checks**

```bash
bun run fmt
bun run check
bun run lint
bun run fmt:check
```

Expected: every command exits 0.

- [ ] **Step 3: Run the relevant unit and E2E suites**

```bash
bun test apps/mesh/src/web/hooks/use-layout-state.test.ts apps/mesh/src/web/layouts/main-panel-tabs apps/mesh/src/web/components/sandbox/blocks apps/mesh/src/web/components/sandbox/preview apps/mesh/src/web/components/sandbox/content
bun run --cwd=packages/e2e test:e2e tests/standalone-blocks-panel.spec.ts tests/sandbox-drawer-everywhere.spec.ts tests/tab-error-boundary-recovery.spec.ts
```

Expected: all tests PASS.

- [ ] **Step 4: Review the final diff for scope and generated files**

```bash
git status --short
git diff --check
git diff --stat HEAD~9..HEAD
```

Expected: only source, tests, and the approved design/plan are present; no `*.gen.*` files are modified; `git diff --check` exits 0.

- [ ] **Step 5: Commit any verification-only corrections**

If static checks required source corrections, commit only those corrections:

```bash
git add apps/mesh/src/web packages/e2e/tests/standalone-blocks-panel.spec.ts
git commit -m "fix(blocks): address workspace verification"
```

If no corrections were needed, do not create an empty commit.
