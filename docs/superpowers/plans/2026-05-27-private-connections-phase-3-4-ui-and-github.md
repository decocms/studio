# Private Connections — Phases 3+4: Tool surface & GitHub-import refactor

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]` checkboxes.

**Goal:** Land just enough of Phases 3 and 4 to ship the motivating bug fix. The "Import from GitHub" picker must show only the calling user's GitHub installations.

**Architecture:** Surface the existing `connections.access` column through the tool surface (CREATE/UPDATE accept it; default `user`). Filter `ctx.storage.connections.list` so callers don't see other users' private connections. Add a new app-only `CONNECTION_RESOLVE_FOR_USER` tool that returns the caller's user-private connection for a given `app_id`, falling back to org-shared. Refactor `github-repo-picker` to use the resolver instead of "find any connection with slug='mcp-github'." Phase 3b (tabs/badges/promote-demote UI), Phase 3 demote-deletes-token, and Phase 5 admin banner are **deferred to a follow-up plan** — they're polish, not required for the browser test.

**Tech Stack:** Kysely, Zod, Hono/Bun for tools; React 19 for the picker.

**Spec reference:** `docs/superpowers/specs/2026-05-27-private-connections-design.md` (sections "UI / tool surface changes → Connection create/update", "Connection list UI", "GitHub-import flow refactor").

**Prior phases:**
- Phase 1: `docs/superpowers/plans/2026-05-27-private-connections-phase-1-schema.md`. Schema commit `f97d1201e`.
- Phase 2: `docs/superpowers/plans/2026-05-27-private-connections-phase-2-resolver.md`. Resolver wired commits `f3bb9e6f0`, `59403a0bb`, `6e65b4bb0`, `d12fc9059`.

---

## File Structure

**Create:**
- `apps/mesh/src/tools/connection/resolve-for-user.ts` — new `CONNECTION_RESOLVE_FOR_USER` tool

**Modify:**
- `packages/mesh-sdk/src/types/connection.ts` — add `access` to ConnectionEntitySchema (with `.default("user")`); already covered as optional in derived Create/Update via `.partial()`.
- `apps/mesh/src/storage/connection.ts` — extend `RawConnectionRow` with `access: 'user' | 'org'`; `list()` accepts `viewerUserId` to filter out other users' private connections; `findById` similarly enforces visibility.
- `apps/mesh/src/tools/connection/list.ts` — pass `ctx.auth.user?.id ?? ctx.auth.apiKey?.userId` to `storage.connections.list`.
- `apps/mesh/src/tools/connection/get.ts` — pass viewer userId through.
- `apps/mesh/src/tools/connection/create.ts` — input schema accepts optional `access` (defaults to `"user"` if omitted, since DB also defaults; explicit pass-through is fine).
- `apps/mesh/src/tools/connection/update.ts` — input schema accepts optional `access`.
- `apps/mesh/src/tools/index.ts` — register `CONNECTION_RESOLVE_FOR_USER`.
- `apps/mesh/src/web/components/github-repo-picker.tsx` — `InstallationPicker` no longer takes a `connectionId` prop; it resolves via `CONNECTION_RESOLVE_FOR_USER({ app_id: 'mcp-github' })`. The parent component (`GithubRepoPicker`) also stops doing `useConnections({slug:'mcp-github'})` for picking; it still uses it to know "does the user have one yet?" to decide between rendering the install flow vs. the picker.

**Context the subagent should know:**
- DB tables: `connections`, `connection_aggregations`. Schema from Phase 1; runtime wiring from Phase 2.
- `RawConnectionRow` at `apps/mesh/src/storage/connection.ts:46-70` — needs `access` added.
- `list()` at `apps/mesh/src/storage/connection.ts:251-315` — uses `.selectAll()` so `access` is auto-picked once added to the type.
- `COLLECTION_CONNECTIONS_LIST` calls `ctx.storage.connections.list(organizationId, ...)` at `apps/mesh/src/tools/connection/list.ts:152-161`. After adding viewerUserId param, this call must pass it.
- `useConnections({slug:"mcp-github"})` in `apps/mesh/src/web/components/github-repo-picker.tsx:179` returns the list visible to the current user — once the LIST tool filters, this naturally only sees the user's own + org-shared.
- The `effectiveConnection` logic at `github-repo-picker.tsx:185-188` picks ambiguously when there are multiple connections; we want determinism via the resolver.
- `install-github-mcp-dialog.tsx` calls into `useAutoInstallGitHub`. Inspect that hook to confirm whether it explicitly passes `access` on create. If it doesn't, the DB default `user` applies — no change needed beyond verification.
- App-only tool pattern: `_meta: { ui: { visibility: "app" } }`. See `apps/mesh/src/tools/github/list-user-orgs.ts` for an example.
- Pre-commit hook: `bun run fmt`. Type gate: `bun run check`.

---

## Task 1: Add `access` to connection schemas + tools + storage list filtering

**Files:**
- Modify: `packages/mesh-sdk/src/types/connection.ts`
- Modify: `apps/mesh/src/storage/connection.ts`
- Modify: `apps/mesh/src/storage/ports.ts` (if `ConnectionStoragePort.list` signature is declared there)
- Modify: `apps/mesh/src/tools/connection/list.ts`
- Modify: `apps/mesh/src/tools/connection/get.ts`
- Modify: `apps/mesh/src/tools/connection/create.ts` (only if the input schema is explicitly built without `access` — if it derives from `ConnectionCreateDataSchema`, no edit needed)
- Modify: `apps/mesh/src/tools/connection/update.ts` (same)
- Create: `apps/mesh/src/storage/connection-access.test.ts`

- [ ] **Step 1: Add `access` to `ConnectionEntitySchema` in mesh-sdk**

In `packages/mesh-sdk/src/types/connection.ts` inside `ConnectionEntitySchema` (line ~85-155), add right after `status`:

```typescript
  access: z
    .enum(["user", "org"])
    .default("user")
    .describe(
      "Visibility/ownership. 'user' = private to created_by; 'org' = shared with everyone in the organization.",
    ),
```

`.default("user")` makes the output type include `access: "user" | "org"` while keeping it optional on input. Since `ConnectionCreateDataSchema` derives via `.omit({...}).partial({...})` and `ConnectionUpdateDataSchema` derives via `.partial()`, both automatically pick it up as optional.

- [ ] **Step 2: Update `RawConnectionRow` and storage**

In `apps/mesh/src/storage/connection.ts:46-70`, add `access: "user" | "org"` to `RawConnectionRow`. In `deserializeConnection`, make sure `access` is passed through to the returned `ConnectionEntity` (likely already the case if it's a `...row` spread).

- [ ] **Step 3: Extend `ConnectionStoragePort.list` and `findById` with `viewerUserId`**

In `apps/mesh/src/storage/ports.ts`, update the `list` method signature to accept an optional `viewerUserId: string | null` parameter and similarly for `findById` if it currently only takes `id`. Then in `apps/mesh/src/storage/connection.ts`:

- `list(organizationId, options)` becomes `list(organizationId, options & { viewerUserId?: string | null })`. After the `where("organization_id", "=", organizationId)`, add:

```typescript
    // Per-user visibility: hide other users' user-private connections.
    if (options?.viewerUserId !== undefined && options?.viewerUserId !== null) {
      const viewerUserId = options.viewerUserId;
      query = query.where((eb) =>
        eb.or([
          eb("access", "=", "org"),
          eb.and([
            eb("access", "=", "user"),
            eb("created_by", "=", viewerUserId),
          ]),
        ]),
      );
    } else {
      // No viewer (system / unauthenticated) → only org-shared rows.
      query = query.where("access", "=", "org");
    }
```

- `findById(id, organizationId?, viewerUserId?)`: after the row is loaded, if `row.access === "user" && row.created_by !== viewerUserId`, return null (treat as not found from the caller's perspective).

- [ ] **Step 4: Plumb `viewerUserId` through callers**

In `apps/mesh/src/tools/connection/list.ts`, where `ctx.storage.connections.list(organization.id, {...})` is called (~line 152), add `viewerUserId: ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null` to the options.

In `apps/mesh/src/tools/connection/get.ts`, do the same when calling `findById`.

There are likely other callers of `storage.connections.list` / `findById` in the codebase. Grep for them. Pass `viewerUserId` through where the caller is acting on behalf of a user (most tool handlers). For internal callers that legitimately need to see all rows (e.g. the slot resolver from Phase 2, or migration scripts), pass `viewerUserId: undefined` with a brief code comment explaining why. **Do not change** the slot resolver's behavior — it already filters by `(access='user' AND created_by=invokerUserId) OR access='org'` directly in its SQL.

- [ ] **Step 5: Write the failing storage test**

Create `apps/mesh/src/storage/connection-access.test.ts`:

```typescript
/**
 * Verifies that ConnectionStorage.list and findById honor the access column:
 *   - Org-shared rows are visible to everyone.
 *   - User-private rows are visible only to their creator.
 *   - When viewerUserId is undefined/null, only org-shared rows are returned.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "./test-helpers";
import { ConnectionStorage } from "./connection";
import type { CredentialVault } from "../encryption/credential-vault";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";

// Minimal CredentialVault stub — only the round-trip methods are used here.
const noopVault: CredentialVault = {
  encrypt: async (s: string) => s,
  decrypt: async (s: string) => s,
} as unknown as CredentialVault;

async function seed(database: TestDatabase): Promise<void> {
  const now = new Date().toISOString();
  for (const [id, createdBy, access] of [
    ["conn_a_private", USER_A, "user"],
    ["conn_a_org", USER_A, "org"],
    ["conn_b_private", USER_B, "user"],
  ] as const) {
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, title, connection_type,
        connection_url, app_id, access, status, created_at, updated_at
      ) VALUES (
        ${id}, ${ORG}, ${createdBy}, ${id}, 'HTTP',
        'https://example.com', 'mcp-test', ${access},
        'active', ${now}, ${now}
      )
    `.execute(database.db);
  }
}

describe("ConnectionStorage — access filtering", () => {
  let database: TestDatabase;
  let storage: ConnectionStorage;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
    await seed(database);
    storage = new ConnectionStorage(database.db, noopVault);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("list as USER_A: returns own private + org-shared, not USER_B's private", async () => {
    const { items } = await storage.list(ORG, { viewerUserId: USER_A });
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(["conn_a_org", "conn_a_private"]);
  });

  it("list as USER_B: returns own private + org-shared, not USER_A's private", async () => {
    const { items } = await storage.list(ORG, { viewerUserId: USER_B });
    const ids = items.map((c) => c.id).sort();
    expect(ids).toEqual(["conn_a_org", "conn_b_private"]);
  });

  it("list with viewerUserId=null returns only org-shared", async () => {
    const { items } = await storage.list(ORG, { viewerUserId: null });
    expect(items.map((c) => c.id)).toEqual(["conn_a_org"]);
  });

  it("findById hides another user's private connection", async () => {
    const visible = await storage.findById(
      "conn_b_private",
      ORG,
      USER_A,
    );
    expect(visible).toBeNull();
  });

  it("findById returns own private connection", async () => {
    const own = await storage.findById("conn_a_private", ORG, USER_A);
    expect(own?.id).toBe("conn_a_private");
  });
});
```

If the existing `ConnectionStorage` constructor or `findById` signature is different from what the test assumes, adjust the test (not the implementation) to match. The test's intent is what matters.

- [ ] **Step 6: Run tests, expect failures, then fix**

Run: `bun test apps/mesh/src/storage/connection-access.test.ts`

Expected first run: failures (filtering not yet applied).

Implement step 3's filtering. Re-run, expect 5 passes.

- [ ] **Step 7: Verify CREATE/UPDATE tools forward `access`**

Open `apps/mesh/src/tools/connection/create.ts:43` and `apps/mesh/src/tools/connection/update.ts:125`. The input schemas should already accept `access` (via `ConnectionCreateDataSchema.partial()` which keeps `access` as optional). Confirm by reading. If the handler explicitly drops fields, add `access` to the kept list. The `created_by` is set by the handler from `ctx.auth.user.id`, so for new rows we want the DB default `user` to apply when `data.access` is undefined.

- [ ] **Step 8: Run full storage + tools tests**

Run: `bun test apps/mesh/src/storage apps/mesh/src/tools/connection`

Expected: all green. If existing tests fail, the most likely cause is they construct `ConnectionEntity` literals without `access` — add `access: "user"` to fix.

- [ ] **Step 9: Typecheck + format**

Run: `bun run check`
Run: `bun run fmt`

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(connections): surface access field through tools + per-user list filtering

ConnectionEntitySchema now has access ('user' | 'org', default 'user').
ConnectionStorage.list and findById accept a viewerUserId; user-private
connections are hidden from other users. CONNECTION_CREATE and
CONNECTION_UPDATE accept access via the existing partial schemas.

Backend foundation for the GitHub-import refactor — the picker can now
trust that 'connections this user can see' excludes teammates' private
GitHub accounts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Add `CONNECTION_RESOLVE_FOR_USER` tool

**Files:**
- Create: `apps/mesh/src/tools/connection/resolve-for-user.ts`
- Modify: `apps/mesh/src/tools/connection/index.ts` (re-export the new tool)
- Modify: `apps/mesh/src/tools/index.ts` (register if needed)
- Create: `apps/mesh/src/tools/connection/resolve-for-user.test.ts`

- [ ] **Step 1: Read existing tool patterns**

Read `apps/mesh/src/tools/github/list-user-orgs.ts` end-to-end for the app-only visibility pattern.
Read `apps/mesh/src/core/slot-resolver.ts` for the resolution SQL — the new tool is a thin wrapper.

- [ ] **Step 2: Write the failing test**

Create `apps/mesh/src/tools/connection/resolve-for-user.test.ts`:

```typescript
/**
 * Resolves the caller's connection for a given app_id at runtime.
 * Same rules as the Phase 2 slot resolver: prefer user-private, fall
 * back to org-shared, return null when nothing matches.
 */
import { describe, expect, it } from "bun:test";
import { CONNECTION_RESOLVE_FOR_USER } from "./resolve-for-user";

describe("CONNECTION_RESOLVE_FOR_USER", () => {
  it("has app-only visibility (not exposed to AI)", () => {
    expect(CONNECTION_RESOLVE_FOR_USER._meta?.ui?.visibility).toBe("app");
  });

  it("declares input { app_id } and output { connectionId | null }", () => {
    // Smoke test that the schemas exist; full behavioral testing happens
    // via the slot-resolver unit tests already in place.
    expect(CONNECTION_RESOLVE_FOR_USER.inputSchema).toBeDefined();
    expect(CONNECTION_RESOLVE_FOR_USER.outputSchema).toBeDefined();
  });
});
```

(Deeper behavioral tests are unnecessary because the underlying `resolveSlot` is already covered in `slot-resolver.test.ts`. This tool is a thin adapter.)

- [ ] **Step 3: Implement the tool**

Create `apps/mesh/src/tools/connection/resolve-for-user.ts`:

```typescript
/**
 * CONNECTION_RESOLVE_FOR_USER
 *
 * App-only tool that returns the calling user's connection for a given
 * app_id, using the same resolution rules as the agent slot resolver
 * (prefer user-private, fall back to org-shared). Returns null when
 * nothing matches.
 *
 * Powers the GitHub-import picker (and any future per-user picker) so
 * the UI doesn't have to do the resolution itself.
 */

import { z } from "zod";
import { defineTool } from "../../core/define-tool";
import { resolveSlot } from "../../core/slot-resolver";

export const CONNECTION_RESOLVE_FOR_USER = defineTool({
  name: "CONNECTION_RESOLVE_FOR_USER",
  description:
    "Return the calling user's connection for a given app_id (user-private preferred, org-shared fallback). Returns null when nothing matches.",
  annotations: {
    title: "Resolve Connection For User",
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  _meta: { ui: { visibility: "app" } },
  inputSchema: z.object({
    app_id: z.string().describe("app_id to resolve (e.g. 'mcp-github')"),
  }),
  outputSchema: z.object({
    connectionId: z.string().nullable(),
    access: z.enum(["user", "org"]).nullable(),
  }),
  handler: async (input, ctx) => {
    await ctx.access.check();

    const organizationId = ctx.organization?.id;
    if (!organizationId) {
      throw new Error("Organization context required");
    }

    const invokerUserId =
      ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;
    if (!invokerUserId) {
      return { connectionId: null, access: null };
    }

    const resolved = await resolveSlot(ctx.db, {
      organizationId,
      invokerUserId,
      appId: input.app_id,
    });
    return {
      connectionId: resolved?.connectionId ?? null,
      access: resolved?.access ?? null,
    };
  },
});
```

- [ ] **Step 4: Register**

In `apps/mesh/src/tools/connection/index.ts`, add `export { CONNECTION_RESOLVE_FOR_USER } from "./resolve-for-user";`.

In `apps/mesh/src/tools/index.ts`, add `CONNECTION_RESOLVE_FOR_USER` to wherever the connection tools are aggregated (look at how `COLLECTION_CONNECTIONS_*` are listed and follow the same pattern).

- [ ] **Step 5: Run tests + typecheck + format**

```bash
bun test apps/mesh/src/tools/connection/resolve-for-user.test.ts
bun run check
bun run fmt
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
feat(connections): CONNECTION_RESOLVE_FOR_USER app-only tool

Thin wrapper around the Phase 2 slot resolver that lets UI surfaces
fetch the caller's user-private connection for a given app_id (with
org-shared fallback). Powers the upcoming GitHub-import picker
refactor.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Refactor `github-repo-picker` + `install-github-mcp-dialog`

**Files:**
- Modify: `apps/mesh/src/web/components/github-repo-picker.tsx`
- Modify: `apps/mesh/src/web/components/install-github-mcp-dialog.tsx` (if it explicitly sets `access`)
- Modify: `apps/mesh/src/web/hooks/use-auto-install-github.ts` (if it explicitly sets `access` on create — likely doesn't, in which case DB default applies)

- [ ] **Step 1: Inspect current flow**

Read these files end-to-end:
- `apps/mesh/src/web/components/github-repo-picker.tsx` (whole file)
- `apps/mesh/src/web/components/install-github-mcp-dialog.tsx`
- `apps/mesh/src/web/hooks/use-auto-install-github.ts`

Identify:
- Where `useConnections({ slug: 'mcp-github' })` is used to pick a connection (`effectiveConnection` at line 185-188).
- Where `InstallationPicker` is called with a `connectionId` prop.
- Where the GitHub MCP connection is initially created (in `useAutoInstallGitHub`).

- [ ] **Step 2: Refactor the picker to use `CONNECTION_RESOLVE_FOR_USER`**

In `github-repo-picker.tsx`:
- Replace the `effectiveConnection` resolution (lines 185-188) with a call to `CONNECTION_RESOLVE_FOR_USER({ app_id: 'mcp-github' })` via a `useQuery` against `selfClient`. Store the result as `resolvedConnectionId`.
- `useMCPClient({ connectionId: resolvedConnectionId ?? "", ... })` for the github client.
- If `resolvedConnectionId === null` AND `useConnections({slug:'mcp-github'}).length === 0`, render the install flow (`AutoInstallGitHubUI`) instead of the picker.
- Remove the `selectedConnection` state and the dropdown that lets the user pick between multiple connections — the resolver makes that determination unambiguous.

In `InstallationPicker` (around line 485-610):
- Drop the `connectionId` prop. Inside, call `CONNECTION_RESOLVE_FOR_USER({ app_id: 'mcp-github' })` itself if it needs to know the connection id (likely just passes the resolved id to `GITHUB_LIST_USER_ORGS`).
- The query key (`KEYS.githubUserOrgs(orgId, connectionId)`) should still be keyed by the resolved connectionId — when the user re-resolves, the query is invalidated.

- [ ] **Step 3: Verify install dialog still works**

Open `install-github-mcp-dialog.tsx` and `use-auto-install-github.ts`. The install creates a new mcp-github connection — with Phase 3 Task 1 changes, the DB default for `access` is `'user'`, so it's automatically private to whoever clicks "Connect GitHub." If `use-auto-install-github.ts` explicitly sets `access: 'org'` for some reason, change it to `'user'` (or simply omit, letting the default apply).

If the create call already omits `access`, no change is needed beyond confirming this.

- [ ] **Step 4: Run typecheck + format**

```bash
bun run check
bun run fmt
```

- [ ] **Step 5: Run any related tests**

```bash
bun test apps/mesh/src/web
```

(If the test suite is large and slow, just run any directly-related files: `github-repo`, `install-github`, `use-auto-install-github`. Skip if no such tests exist.)

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "$(cat <<'EOF'
fix(github-import): use CONNECTION_RESOLVE_FOR_USER for picker

The 'Import from GitHub' picker now resolves the caller's own
mcp-github connection via the new app-only resolver tool, instead of
picking ambiguously from useConnections({slug:'mcp-github'}). Each
user sees only their own GitHub installations — the cross-contamination
bug where teammates' personal accounts appeared in the picker is now
fixed at the source.

New mcp-github connections are created with the DB default
access='user' (private to creator) so this fix takes effect without
any explicit caller-side change.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Regression sweep

Same shape as Phase 1 Task 2 and Phase 2 Task 4. Expected outcome: no commit needed.

- [ ] **Step 1: Run mesh test suite**

```bash
bun test apps/mesh
```

(Bun may segfault during shutdown on the full suite — run by subdirectory if needed.)

- [ ] **Step 2: Typecheck**

```bash
bun run check
```

- [ ] **Step 3: Lint**

```bash
bun run lint
```

- [ ] **Step 4: Format check**

```bash
bun run fmt:check
```

- [ ] **Step 5: Commit fixes only if needed**

If anything was modified, commit as a fix. Expected: no commit.
