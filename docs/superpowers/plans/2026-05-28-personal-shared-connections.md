# Personal / Shared Connections Split — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split connection views by the `access` field into **All / Shared / Personal** tabs on the connections settings page and in the home-sidebar `AddConnectionDialog`.

**Architecture:** Pure, unit-tested helpers in a shared module own the tab model (labels, coercion, filter, count, and access→`where` mapping). The settings page filters its already-loaded connection list client-side and shows search-independent count badges via a small Suspense-wrapped sub-component. The dialog, which paginates server-side, pushes the access filter into the `COLLECTION_CONNECTIONS_LIST` `where` expression. No backend changes — `access` already exists, is visibility-filtered server-side, and defaults correctly (`org` for existing rows, `user` for new ones).

**Tech Stack:** React 19, TanStack Query (suspense), TanStack Router, Bun test, Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-05-28-personal-shared-connections-design.md`

---

## File Structure

- **Create** `apps/mesh/src/shared/utils/connection-access-tab.ts` — pure tab-model helpers (type, coercion, filter, count, access→where mapping). Shared by both surfaces.
- **Create** `apps/mesh/src/shared/utils/connection-access-tab.test.ts` — unit tests for the helpers.
- **Modify** `apps/mesh/src/web/routes/orgs/connections.tsx` — three tabs, count badges, client-side access filter, localStorage migration.
- **Modify** `apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx` — three tabs, server-side access `where` filter, localStorage keyed by `mode`, default tab `"all"`.
- **Modify** `apps/mesh/e2e/pages/settings-connections.ts` — tab navigation + card-visibility helpers.
- **Create** `apps/mesh/e2e/tests/connections-access-tabs.spec.ts` — e2e: a new connection lands under Personal, not Shared.

No change is needed in `apps/mesh/src/web/views/virtual-mcp/index.tsx` (the agent-add caller) — it does not pass `defaultTab`, so it inherits the new `"all"` default. The home callers (`components/sidebar/footer/inbox.tsx`, `components/chat/input.tsx`) already pass `defaultTab="all"`, which stays valid.

---

## Task 1: Pure tab-model helpers

**Files:**
- Create: `apps/mesh/src/shared/utils/connection-access-tab.ts`
- Test: `apps/mesh/src/shared/utils/connection-access-tab.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/mesh/src/shared/utils/connection-access-tab.test.ts`:

```ts
import { describe, expect, it } from "bun:test";
import {
  accessTabWhereValue,
  coerceConnectionAccessTab,
  countConnectionsByAccess,
  filterConnectionsByAccessTab,
} from "./connection-access-tab";

const conns = [
  { access: "org" as const },
  { access: "user" as const },
  { access: "user" as const },
];

describe("coerceConnectionAccessTab", () => {
  it("keeps valid tabs", () => {
    expect(coerceConnectionAccessTab("all")).toBe("all");
    expect(coerceConnectionAccessTab("shared")).toBe("shared");
    expect(coerceConnectionAccessTab("personal")).toBe("personal");
  });

  it("maps legacy and unknown values to all", () => {
    expect(coerceConnectionAccessTab("connected")).toBe("all");
    expect(coerceConnectionAccessTab(undefined)).toBe("all");
    expect(coerceConnectionAccessTab("bogus")).toBe("all");
  });
});

describe("accessTabWhereValue", () => {
  it("maps tabs to the access column value", () => {
    expect(accessTabWhereValue("all")).toBeNull();
    expect(accessTabWhereValue("shared")).toBe("org");
    expect(accessTabWhereValue("personal")).toBe("user");
  });
});

describe("filterConnectionsByAccessTab", () => {
  it("returns everything for the all tab", () => {
    expect(filterConnectionsByAccessTab(conns, "all")).toHaveLength(3);
  });

  it("returns only org connections for shared", () => {
    expect(filterConnectionsByAccessTab(conns, "shared")).toEqual([
      { access: "org" },
    ]);
  });

  it("returns only user connections for personal", () => {
    expect(filterConnectionsByAccessTab(conns, "personal")).toEqual([
      { access: "user" },
      { access: "user" },
    ]);
  });
});

describe("countConnectionsByAccess", () => {
  it("counts each bucket", () => {
    expect(countConnectionsByAccess(conns)).toEqual({
      all: 3,
      shared: 1,
      personal: 2,
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/shared/utils/connection-access-tab.test.ts`
Expected: FAIL — `Cannot find module './connection-access-tab'`.

- [ ] **Step 3: Write the implementation**

Create `apps/mesh/src/shared/utils/connection-access-tab.ts`:

```ts
/**
 * Tab model that splits connections by their `access` field.
 *
 *   "all"      → no filter (every connection the viewer can see)
 *   "shared"   → access === "org"  (shared org-wide)
 *   "personal" → access === "user" (private to the creator)
 *
 * Shared by the connections settings page and the AddConnectionDialog so the
 * tab ids, labels, coercion, and filtering stay in sync across surfaces.
 */
export type ConnectionAccessTab = "all" | "shared" | "personal";

/** Minimal shape needed to bucket a connection by visibility. */
type HasAccess = { access: "user" | "org" };

/**
 * Coerce an arbitrary stored/URL value into a valid tab. Unknown values —
 * including the legacy "connected" tab — fall back to "all".
 */
export function coerceConnectionAccessTab(value: unknown): ConnectionAccessTab {
  return value === "shared" || value === "personal" || value === "all"
    ? value
    : "all";
}

/**
 * Map a tab to the `access` column value used for server-side `where`
 * filtering. "all" → null (no filter); "shared" → "org"; "personal" → "user".
 */
export function accessTabWhereValue(
  tab: ConnectionAccessTab,
): "org" | "user" | null {
  if (tab === "shared") return "org";
  if (tab === "personal") return "user";
  return null;
}

/** Client-side filter of connections for a given tab. */
export function filterConnectionsByAccessTab<T extends HasAccess>(
  connections: T[],
  tab: ConnectionAccessTab,
): T[] {
  const value = accessTabWhereValue(tab);
  if (value === null) return connections;
  return connections.filter((c) => c.access === value);
}

/** Count connections per access bucket. */
export function countConnectionsByAccess<T extends HasAccess>(
  connections: T[],
): { all: number; shared: number; personal: number } {
  let shared = 0;
  let personal = 0;
  for (const c of connections) {
    if (c.access === "org") shared++;
    else if (c.access === "user") personal++;
  }
  return { all: connections.length, shared, personal };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/shared/utils/connection-access-tab.test.ts`
Expected: PASS — all 4 describe blocks green.

- [ ] **Step 5: Commit**

```bash
git add apps/mesh/src/shared/utils/connection-access-tab.ts apps/mesh/src/shared/utils/connection-access-tab.test.ts
git commit -m "feat(connections): add Personal/Shared access-tab helpers"
```

---

## Task 2: Settings page — three tabs, filter, counts

**Files:**
- Modify: `apps/mesh/src/web/routes/orgs/connections.tsx`

This task is wired by hand (UI behavior is verified by e2e in Task 4, per `TESTING.md`). Make the edits below in order, then run typecheck.

- [ ] **Step 1: Add the helper imports**

In `apps/mesh/src/web/routes/orgs/connections.tsx`, add this import near the other `@/shared/utils` imports (the file already imports `groupConnections` from `@/shared/utils/group-connections`):

```ts
import {
  type ConnectionAccessTab,
  coerceConnectionAccessTab,
  countConnectionsByAccess,
  filterConnectionsByAccessTab,
} from "@/shared/utils/connection-access-tab";
```

- [ ] **Step 2: Update the `ConnectionResultsProps.activeTab` type**

Find (around line 503):

```ts
interface ConnectionResultsProps {
  listState: ListState<ConnectionEntity>;
  activeTab: "connected" | "all";
```

Replace the `activeTab` line with:

```ts
  activeTab: ConnectionAccessTab;
```

- [ ] **Step 3: Apply the access filter and recompute display sets in `ConnectionResults`**

Find (around line 696):

```ts
  // Apply UI filters (VIRTUAL already excluded server-side)
  const filteredConnections = connections.filter((c) => {
    if (typeFilter !== "ALL" && c.connection_type !== typeFilter) return false;
    if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
    return true;
  });

  const grouped = groupConnections(filteredConnections);
```

Replace with:

```ts
  // Apply UI filters (VIRTUAL already excluded server-side)
  const filteredConnections = connections.filter((c) => {
    if (typeFilter !== "ALL" && c.connection_type !== typeFilter) return false;
    if (statusFilter !== "ALL" && c.status !== statusFilter) return false;
    return true;
  });

  // Narrow to the active access tab ("all" returns everything).
  const accessFiltered = filterConnectionsByAccessTab(
    filteredConnections,
    activeTab,
  );

  const grouped = groupConnections(accessFiltered);
```

- [ ] **Step 4: Update `catalogItems` and `groupedForDisplay` gating**

Find (around line 745):

```ts
  // Catalog items: show on "All" tab always, or on "Connected" tab when searching
  const catalogItems =
    activeTab === "all" || isSearching
      ? registryItems.filter((item) => {
```

Leave that `activeTab === "all" || isSearching` condition as-is (catalog still shows only on All / while searching).

Then find (around line 763):

```ts
  // Connected items: show on "Connected" tab always, or on "All" tab when searching
  // When both show, connected always appear first in the grid
  const groupedForDisplay =
    activeTab === "connected" || isSearching ? grouped : [];
```

Replace with:

```ts
  // Connected cards: shown on Shared/Personal always, and on All when
  // searching. On the All tab without a search the page stays catalog-first.
  const groupedForDisplay =
    activeTab !== "all" || isSearching ? grouped : [];
```

- [ ] **Step 5: Point the bulk "select all" / total at the access-filtered set**

Find (around line 1231) inside the `BulkActionBar` render:

```tsx
        <BulkActionBar
          count={selectedIds.size}
          total={filteredConnections.length}
          onSelectAll={() => {
            setSelectedIds(new Set(filteredConnections.map((c) => c.id)));
          }}
```

Replace the two `filteredConnections` references with `accessFiltered`:

```tsx
        <BulkActionBar
          count={selectedIds.size}
          total={accessFiltered.length}
          onSelectAll={() => {
            setSelectedIds(new Set(accessFiltered.map((c) => c.id)));
          }}
```

- [ ] **Step 6: Fix the empty-state condition to use the access-filtered set**

Find (around line 1040):

```tsx
          {(
            isSearching
              ? catalogItems.length === 0 && filteredConnections.length === 0
              : activeTab === "all"
                ? catalogItems.length === 0
                : filteredConnections.length === 0
          ) ? (
```

Replace the two `filteredConnections.length === 0` checks with `accessFiltered.length === 0`:

```tsx
          {(
            isSearching
              ? catalogItems.length === 0 && accessFiltered.length === 0
              : activeTab === "all"
                ? catalogItems.length === 0
                : accessFiltered.length === 0
          ) ? (
```

- [ ] **Step 7: Add the tab-bar sub-components (with search-independent counts)**

Add these two components just above `function OrgMcpsContent() {` (around line 1245). They keep the tabs visible while counts load: the Suspense fallback renders the same tabs without count badges.

```tsx
function ConnectionTabsBar({
  activeTab,
  onTabChange,
  counts,
}: {
  activeTab: ConnectionAccessTab;
  onTabChange: (tab: ConnectionAccessTab) => void;
  counts?: { all: number; shared: number; personal: number };
}) {
  return (
    <CollectionTabs
      tabs={[
        { id: "all", label: "All", count: counts?.all },
        { id: "shared", label: "Shared", count: counts?.shared },
        { id: "personal", label: "Personal", count: counts?.personal },
      ]}
      activeTab={activeTab}
      onTabChange={(id) => onTabChange(id as ConnectionAccessTab)}
    />
  );
}

// Search-independent counts: a separate useConnections() query (no search term)
// so the badges stay stable while the user types and the toolbar never
// re-suspends on keystroke. Org connection lists are small (single page).
function ConnectionTabsBarWithCounts(props: {
  activeTab: ConnectionAccessTab;
  onTabChange: (tab: ConnectionAccessTab) => void;
}) {
  const allConnections = useConnections({});
  const counts = countConnectionsByAccess(allConnections);
  return <ConnectionTabsBar {...props} counts={counts} />;
}
```

- [ ] **Step 8: Update tab state in `OrgMcpsContent`**

Find (around line 1265):

```ts
  // Tab state
  type ConnectionTab = "connected" | "all";
  const [activeTab, setActiveTab] = useLocalStorage<ConnectionTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug),
    (existing) =>
      search.tab === "all" || search.tab === "connected"
        ? search.tab
        : (existing ?? "all"),
  );
```

Replace with:

```ts
  // Tab state — legacy "connected" values coerce to "all".
  const [activeTab, setActiveTab] = useLocalStorage<ConnectionAccessTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug),
    (existing) => coerceConnectionAccessTab(search.tab ?? existing),
  );

  const handleTabChange = (next: ConnectionAccessTab) => {
    if (next !== activeTab) {
      track("connections_page_tab_changed", { to_tab: next });
    }
    setActiveTab(next);
  };
```

- [ ] **Step 9: Widen the `search.tab` search-param type**

Find (around line 1248):

```ts
  const search = useSearch({ strict: false }) as {
    action?: "create";
    tab?: "all" | "connected";
  };
```

Replace with:

```ts
  const search = useSearch({ strict: false }) as {
    action?: "create";
    tab?: string;
  };
```

(`coerceConnectionAccessTab` validates the value, so a loose `string` here is intentional.)

- [ ] **Step 10: Swap the `CollectionTabs` render for the new tab bar**

Find (around line 1992):

```tsx
              <CollectionTabs
                tabs={[
                  { id: "all", label: "All" },
                  { id: "connected", label: "Connected" },
                ]}
                activeTab={activeTab}
                onTabChange={(id) => {
                  const next = id as ConnectionTab;
                  if (next !== activeTab) {
                    track("connections_page_tab_changed", { to_tab: next });
                  }
                  setActiveTab(next);
                }}
              />
```

Replace with:

```tsx
              <Suspense
                fallback={
                  <ConnectionTabsBar
                    activeTab={activeTab}
                    onTabChange={handleTabChange}
                  />
                }
              >
                <ConnectionTabsBarWithCounts
                  activeTab={activeTab}
                  onTabChange={handleTabChange}
                />
              </Suspense>
```

(`Suspense` and `useConnections` are already imported in this file.)

- [ ] **Step 11: Typecheck**

Run: `bun run check`
Expected: PASS — no type errors. In particular, the old `ConnectionTab` type alias is gone and every `activeTab` consumer now uses `ConnectionAccessTab`.

- [ ] **Step 12: Format**

Run: `bun run fmt`
Expected: files reformatted with no diff afterward.

- [ ] **Step 13: Commit**

```bash
git add apps/mesh/src/web/routes/orgs/connections.tsx
git commit -m "feat(connections): split settings page into All/Shared/Personal tabs"
```

---

## Task 3: AddConnectionDialog — three tabs + server-side filter

**Files:**
- Modify: `apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx`

- [ ] **Step 1: Add helper imports**

Near the top of `add-connection-dialog.tsx` (with the other `@/shared/utils` / `@/web/...` imports), add:

```ts
import {
  type ConnectionAccessTab,
  accessTabWhereValue,
  coerceConnectionAccessTab,
} from "@/shared/utils/connection-access-tab";
```

- [ ] **Step 2: Widen the public `defaultTab` prop type**

Find (around line 73) in `ConnectionDialogProps`:

```ts
  defaultTab?: "all" | "connected";
```

Replace with:

```ts
  defaultTab?: ConnectionAccessTab;
```

- [ ] **Step 3: Remove the local `ConnectionTab` alias and update the inner component signature**

Find (around line 95):

```ts
type ConnectionTab = "all" | "connected";

function ConnectionDialogContent({
```

Replace with:

```ts
function ConnectionDialogContent({
```

Then find the inner prop default (around line 108) and type (around line 120):

```ts
  defaultTab = "connected",
}: {
```

Replace the default with `"all"`:

```ts
  defaultTab = "all",
}: {
```

And find:

```ts
  defaultTab?: "all" | "connected";
}) {
```

Replace with:

```ts
  defaultTab?: ConnectionAccessTab;
}) {
```

- [ ] **Step 4: Re-key localStorage on `mode` and coerce legacy values**

Find (around line 127):

```ts
  const [activeTab, setActiveTab] = useLocalStorage<ConnectionTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug) +
      (defaultTab === "all" ? ":home-modal" : ":agent-modal"),
    (existing) => existing ?? defaultTab,
  );

  const handleTabChange = (nextTab: ConnectionTab) => {
    if (nextTab !== activeTab) {
      track("connections_dialog_tab_changed", { to_tab: nextTab });
    }
    setActiveTab(nextTab);
  };
```

Replace with:

```ts
  // Key on `mode` (browse = home sidebar, add = agent) rather than defaultTab,
  // which now defaults to "all" for both. Legacy "connected" values coerce away.
  const [activeTab, setActiveTab] = useLocalStorage<ConnectionAccessTab>(
    LOCALSTORAGE_KEYS.connectionsTab(org.slug) +
      (mode === "browse" ? ":home-modal" : ":agent-modal"),
    (existing) => coerceConnectionAccessTab(existing ?? defaultTab),
  );

  const handleTabChange = (nextTab: ConnectionAccessTab) => {
    if (nextTab !== activeTab) {
      track("connections_dialog_tab_changed", { to_tab: nextTab });
    }
    setActiveTab(nextTab);
  };
```

(`mode` is already a parameter of `ConnectionDialogContent`, defaulting to `"add"`.)

- [ ] **Step 5: Fold the access filter into the server-side `where`**

Find (around line 148):

```ts
  const where = deferredSearch?.trim()
    ? {
        operator: "or" as const,
        conditions: [
          {
            field: ["title"],
            operator: "contains" as const,
            value: deferredSearch.trim(),
          },
          {
            field: ["description"],
            operator: "contains" as const,
            value: deferredSearch.trim(),
          },
        ],
      }
    : undefined;
```

Replace with:

```ts
  const searchWhere = deferredSearch?.trim()
    ? {
        operator: "or" as const,
        conditions: [
          {
            field: ["title"],
            operator: "contains" as const,
            value: deferredSearch.trim(),
          },
          {
            field: ["description"],
            operator: "contains" as const,
            value: deferredSearch.trim(),
          },
        ],
      }
    : undefined;

  // Tabs are hidden while searching, so search spans every access bucket;
  // otherwise filter by the active tab server-side to keep pagination correct.
  const accessValue = searchLower ? null : accessTabWhereValue(activeTab);
  const accessWhere = accessValue
    ? {
        field: ["access"],
        operator: "eq" as const,
        value: accessValue,
      }
    : undefined;

  const where =
    searchWhere && accessWhere
      ? { operator: "and" as const, conditions: [searchWhere, accessWhere] }
      : (searchWhere ?? accessWhere);
```

(`searchLower` is already defined above as `deferredSearch.trim().toLowerCase()`. The combined `where` flows into both `toolArguments` and the `queryFn` body unchanged, and into `argsKey`/`queryKey`, so switching tabs refetches the correct subset.)

- [ ] **Step 6: Render the three tabs**

Find (around line 494):

```tsx
          <CollectionTabs
            tabs={[
              { id: "all", label: "All" },
              { id: "connected", label: "Connected" },
            ]}
            activeTab={activeTab}
            onTabChange={(id) => handleTabChange(id as ConnectionTab)}
          />
```

Replace with:

```tsx
          <CollectionTabs
            tabs={[
              { id: "all", label: "All" },
              { id: "shared", label: "Shared" },
              { id: "personal", label: "Personal" },
            ]}
            activeTab={activeTab}
            onTabChange={(id) => handleTabChange(id as ConnectionAccessTab)}
          />
```

- [ ] **Step 7: Update the empty-state copy**

Find (around line 602):

```tsx
              {search
                ? `No connections match "${search}"`
                : activeTab === "connected"
                  ? "No connections yet"
                  : "No connections available"}
```

Replace with:

```tsx
              {search
                ? `No connections match "${search}"`
                : activeTab === "all"
                  ? "No connections available"
                  : "No connections yet"}
```

- [ ] **Step 8: Typecheck**

Run: `bun run check`
Expected: PASS. Confirms the removed `ConnectionTab` alias has no remaining references and the `defaultTab` callers still typecheck (`"all"` is a valid `ConnectionAccessTab`).

- [ ] **Step 9: Format**

Run: `bun run fmt`
Expected: no diff after formatting.

- [ ] **Step 10: Commit**

```bash
git add apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx
git commit -m "feat(connections): split AddConnectionDialog into All/Shared/Personal tabs"
```

---

## Task 4: e2e — new connection lands under Personal, not Shared

**Files:**
- Modify: `apps/mesh/e2e/pages/settings-connections.ts`
- Create: `apps/mesh/e2e/tests/connections-access-tabs.spec.ts`

A connection created through the dialog defaults to `access: "user"` (Personal). This e2e drives the real UI: create one, then assert the Personal tab shows it and the Shared tab does not.

- [ ] **Step 1: Add tab + visibility helpers to the page object**

In `apps/mesh/e2e/pages/settings-connections.ts`, add these methods inside the `SettingsConnectionsPage` class (after `submit()`):

```ts
  /** Click an access tab by its label (the button text also carries a count badge). */
  async clickTab(label: "All" | "Shared" | "Personal"): Promise<void> {
    await this.page
      .getByRole("button", { name: new RegExp(`^${label}\\b`) })
      .click();
  }

  /** Assert a connection card with the given title is visible. */
  async expectConnectionVisible(title: string): Promise<void> {
    await expect(this.page.getByText(title, { exact: true })).toBeVisible();
  }

  /** Assert no connection card with the given title is present. */
  async expectConnectionHidden(title: string): Promise<void> {
    await expect(this.page.getByText(title, { exact: true })).toHaveCount(0);
  }
```

- [ ] **Step 2: Write the e2e spec**

Create `apps/mesh/e2e/tests/connections-access-tabs.spec.ts`:

```ts
import { signUp } from "../fixtures/auth";
import { SettingsConnectionsPage } from "../pages/settings-connections";
import {
  expect,
  extractOrgSlugFromUrl,
  test,
  waitForPostSignupRedirect,
} from "../fixtures/test";

test.describe("Connections access tabs", () => {
  test("a new connection appears under Personal but not Shared", async ({
    page,
  }) => {
    await signUp(page);
    await waitForPostSignupRedirect(page);
    const orgSlug = extractOrgSlugFromUrl(page);

    const connections = new SettingsConnectionsPage(page);
    await connections.goto(orgSlug);

    // Create a custom HTTP connection — defaults to access "user" (Personal).
    await connections.openCreateDialog();
    await connections.fillHttpConnection({
      name: "Personal MCP",
      url: "https://personal.example.com/mcp",
    });
    await connections.submit();
    await page.waitForURL(/\/settings\/connections\/.+/, { timeout: 10_000 });

    // Back to the list and check the tabs.
    await connections.goto(orgSlug);

    await connections.clickTab("Personal");
    await connections.expectConnectionVisible("Personal MCP");

    await connections.clickTab("Shared");
    await connections.expectConnectionHidden("Personal MCP");
  });
});
```

- [ ] **Step 3: Run the e2e test**

Run: `bun run --cwd=apps/mesh test:e2e connections-access-tabs` (the `test:e2e` script is `playwright test`; the trailing arg filters by spec filename).
Expected: PASS — Personal shows "Personal MCP", Shared does not.

> The Playwright config provisions its own server/DB. If that harness can't start locally, note it and defer this step to CI, but still commit the spec.

- [ ] **Step 4: Commit**

```bash
git add apps/mesh/e2e/pages/settings-connections.ts apps/mesh/e2e/tests/connections-access-tabs.spec.ts
git commit -m "test(connections): e2e for Personal/Shared access tabs"
```

---

## Task 5: Final verification

- [ ] **Step 1: Unit tests**

Run: `bun test apps/mesh/src/shared/utils/connection-access-tab.test.ts`
Expected: PASS.

- [ ] **Step 2: Typecheck the whole workspace**

Run: `bun run check`
Expected: PASS.

- [ ] **Step 3: Lint**

Run: `bun run lint`
Expected: PASS — no new violations (note: no `useMemo`/`useEffect` were introduced; counts derive synchronously from query data).

- [ ] **Step 4: Format check**

Run: `bun run fmt:check`
Expected: PASS.

- [ ] **Step 5: Manual smoke (optional, if dev server is available)**

Run `bun run dev`, then:
1. Open `/<org>/settings/connections` → confirm **All / Shared / Personal** tabs with count badges; Shared shows org connections, Personal shows your own, All keeps the catalog/install view.
2. Open the home-sidebar **Connections** button → confirm the dialog shows **All / Shared / Personal**, that Shared/Personal filter correctly, and the catalog appears only on **All** / while searching.

---

## Self-Review notes

- **Spec coverage:** All tabs + labels (Tasks 2, 3); count badges page-only (Task 2 steps 7/10); client-side filter on page (Task 2 step 3); server-side `where` filter in dialog (Task 3 step 5); localStorage/`?tab=` migration via `coerceConnectionAccessTab` (Task 2 steps 8–9, Task 3 step 4); `defaultTab` migration + caller audit (Task 3 steps 2–3, File Structure note); analytics emit new values (Task 2 step 8, Task 3 step 4); no backend changes; testing via unit helpers + e2e (Tasks 1, 4).
- **No placeholders:** every code step contains full content.
- **Type consistency:** `ConnectionAccessTab` is the single tab type across both surfaces; `accessTabWhereValue` returns `"org" | "user" | null` and is consumed identically in page filter (Task 1) and dialog `where` (Task 3); `countConnectionsByAccess` returns `{ all, shared, personal }` matching the `ConnectionTabsBar` `counts` prop.
