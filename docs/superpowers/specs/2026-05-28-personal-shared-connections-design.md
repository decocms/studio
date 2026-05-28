# Personal / Shared connections split

**Date:** 2026-05-28
**Status:** Approved (design)

## Problem

Connections carry an `access` field — `"user"` (private to the creator) or
`"org"` (shared org-wide) — but the UI has no way to distinguish or filter by
it. A user who sets up a personal connection (e.g. a Gmail install via a
per-user flow) sees it mixed into the same "Connected" list as org-shared
connections, with no dedicated view for "just mine".

The connections settings page (`/:org/settings/connections`) and the
`AddConnectionDialog` (opened from the home-page sidebar "Connections" button
and reused for adding connections to agents) both expose only **All** and
**Connected** tabs.

## Goal

Split the connection views by `access` into a mutually-exclusive, business-user
friendly model:

- **All** — discovery/install view: every connection you can see (Personal +
  Shared) plus the registry catalog. Unchanged behavior.
- **Shared** — only `access === "org"` connections.
- **Personal** — only `access === "user"` connections (your own).

"Private" was rejected in favor of "Personal" (reads as "just mine" rather than
a security/technical term); "Shared" reads more clearly than "Connected" once
"Personal" sits beside it.

## Background / existing model (no backend changes)

- `connections.access` is `'user' | 'org'`, added in migration
  `097-connection-access-and-slots`. Existing rows backfilled to `'org'`; new
  rows default to `'user'` (private-by-default). So custom connections created
  via the dialog already land in **Personal**.
- Server-side visibility is already enforced (`apps/mesh/src/storage/connection.ts`
  `list`/`findById`): a viewer only sees org-shared rows plus their *own*
  user-private rows. The split is therefore purely a client-side
  presentation/filter concern — there is no risk of surfacing a teammate's
  private connection.
- `access` is already exposed on the client `ConnectionEntity`
  (`packages/mesh-sdk/src/types/connection.ts`).
- `CollectionTabs` (`apps/mesh/src/web/components/collections/collection-tabs.tsx`)
  already supports an optional `count` badge per tab.

## Out of scope

- No backend/schema/tool changes.
- No ability to flip a connection between Personal and Shared (promote/demote).
  This is a natural follow-up but is not part of this change.
- No count badges in the `AddConnectionDialog` (see rationale below).

## Surface 1 — Connections settings page

File: `apps/mesh/src/web/routes/orgs/connections.tsx`

### Tabs

Replace **All | Connected** with **All | Shared | Personal**.

| Tab | Connections shown | Catalog (install) cards |
|-----|-------------------|-------------------------|
| All | Every connected connection (Personal + Shared) | Yes |
| Shared | `access === "org"` only | No |
| Personal | `access === "user"` only | No |

Each tab shows a **count badge** via `CollectionTabs`' `count` prop, e.g.
`Shared 4`, `Personal 2`, `All 6`. Counts reflect connected connections per
access and are independent of the search box.

### State & filtering

- Tab type changes `"connected" | "all"` → `"all" | "shared" | "personal"`.
- `ConnectionResults` gains an access-filter step: on **Shared** / **Personal**
  it filters `filteredConnections` by `c.access` (`"org"` / `"user"`
  respectively); on **All** it shows the full set (current behavior).
- Catalog cards render only on **All** (and continue to appear while searching
  on **All**). On Shared/Personal, search filters only within that tab's
  connected subset — no catalog.
- localStorage (`LOCALSTORAGE_KEYS.connectionsTab(org.slug)`) and the `?tab=`
  search param accept the new values; any stale `"connected"` value coerces to
  `"all"`.

### Counts mechanics

The parent (`OrgMcpsContent`) derives `{ all, shared, personal }` counts from a
**search-independent** `useConnections()` call (no search term) so the badges
stay stable while the user types and the toolbar/tabs do not re-suspend on each
keystroke. The searched/paginated display list stays in `ConnectionResults` as
today. Org connection lists are small and both queries are cached by
react-query, so the extra call is cheap.

### Analytics

Keep `track("connections_page_tab_changed", { to_tab })`; `to_tab` now emits
`"all" | "shared" | "personal"`.

## Surface 2 — AddConnectionDialog

File: `apps/mesh/src/web/views/virtual-mcp/add-connection-dialog.tsx`
Callers: `apps/mesh/src/web/components/sidebar/footer/inbox.tsx` (home sidebar,
`mode="browse"`), `apps/mesh/src/web/views/virtual-mcp/index.tsx` (agent add,
`mode="add"`).

Apply the same **All | Shared | Personal** tab model, with two surface-specific
differences driven by how this dialog already works:

1. **Server-side access filter.** The dialog paginates connections via
   `useSuspenseInfiniteQuery` → `COLLECTION_CONNECTIONS_LIST`. Shared/Personal
   filtering is therefore added to the tool's `where` expression
   (`access = "org"` / `access = "user"`), the same mechanism already used for
   title/description search, so infinite-scroll pagination stays correct.
   Client-side filtering would under-count across not-yet-loaded pages.
   (Confirm during planning that the `where`/`applyWhereToSql` layer supports an
   equality condition on the `access` field.) Catalog items continue to show
   only on **All** and while searching.

2. **Default tab & stored-value migration.** The `defaultTab` prop becomes
   `"all" | "shared" | "personal"`. Home-sidebar / inbox callers keep
   `defaultTab="all"`; the agent-add caller (currently `"connected"`) maps to
   `"all"`. The per-modal localStorage keys (`:home-modal` / `:agent-modal`)
   coerce any stale `"connected"` value → `"all"`. Tabs remain hidden while
   searching, as today.

**No count badges in the dialog.** Live per-access counts there would require
extra count queries on top of the paginated list — not worth it for a transient
modal. Counts live only on the settings page, the canonical "manage my
connections" surface. Keep `track("connections_dialog_tab_changed", { to_tab })`
emitting the new values.

## Shared piece

The common element across both surfaces is the `access`-based tab model — the
tab ids `"all" | "shared" | "personal"` and their labels. Everything else
(counts, catalog placement, pagination strategy, default-tab handling) stays
surface-specific.

## Testing

Per `TESTING.md`, UI behavior is covered by Playwright e2e, not unit tests.

- e2e (`apps/mesh/e2e/`): on the settings page, with one org-shared and one
  user-private connection, assert that **Shared** shows only the org connection,
  **Personal** shows only the user connection, **All** shows both, and the count
  badges match. Reuse/extend `apps/mesh/e2e/pages/settings-connections.ts`.
- Manual verification: open the home-sidebar Connections dialog and confirm the
  three tabs filter correctly and the catalog appears only on **All** / while
  searching.
