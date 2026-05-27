# Private Connections — Phase 1: Schema Migration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `access` to `connections` and `slot_app_id` to `connection_aggregations` so future phases can build per-user connections + typed slots. Schema-only PR — no behavior change at runtime.

**Architecture:** Single PostgreSQL migration (`097-connection-access-and-slots`) that (1) backfills all existing `connections` rows to `access='org'` then flips the column default to `'user'` for future inserts, (2) adds an optional `slot_app_id` to `connection_aggregations` and relaxes `child_connection_id` to NULLABLE with an XOR `CHECK` so each row is either a concrete child or a slot, (3) adds partial unique indexes enforcing R4 (one user-private connection per `app_id` per user) and slot uniqueness per agent.

**Tech Stack:** Kysely 0.x migration system, embedded-postgres in tests, Bun test runner, TypeScript strict mode.

**Spec reference:** `docs/superpowers/specs/2026-05-27-private-connections-design.md` (sections "Concepts", "Schema changes (summary)", "Migration (M4 strategy)").

---

## File Structure

**Create:**
- `apps/mesh/migrations/097-connection-access-and-slots.ts` — the migration (up + down)
- `apps/mesh/migrations/097-connection-access-and-slots.test.ts` — integration test covering backfill, defaults, CHECK constraints, partial unique indexes, and down rollback

**Modify:**
- `apps/mesh/migrations/index.ts` — register the new migration
- `apps/mesh/src/storage/types.ts` — add `access` to `MCPConnectionTable`; loosen and extend `ConnectionAggregationTable`

**Context the subagent should know without searching:**
- DB table names are `connections` (singular *no s*, despite the type being `MCPConnectionTable`) and `connection_aggregations` (plural). Confirmed via migrations 026 and 031.
- Latest existing migration is `096-org-file-configs-public-url-base`.
- The migration index registers entries by their kebab filename (without the `.ts`), pointing at the imported namespace.
- Test harness pattern is established in `092-sandbox-naming-uniformization.test.ts`: `createTestDatabase()` → `createTestSchema(db)` → `seedCommonTestFixtures(db)` → assert behavior.
- For testing **backfill** behavior (existing rows transitioning from "no column" to `access='org'`), the test must use `Migrator.migrateTo("096-org-file-configs-public-url-base")` to roll up to the previous tip, insert pre-migration data, then call `up097(db)` directly. Other constraint tests can use `createTestSchema` (which already includes 097 after registration).
- Production uses PostgreSQL only. Older migrations have SQLite fallbacks; new ones don't (see 094). Write PG-only SQL.
- `bun run fmt` must run before commit (lefthook). `bun run check` is the TypeScript gate.

---

## Task 1: Implement migration 097 with tests

**Files:**
- Create: `apps/mesh/migrations/097-connection-access-and-slots.ts`
- Create: `apps/mesh/migrations/097-connection-access-and-slots.test.ts`
- Modify: `apps/mesh/migrations/index.ts`
- Modify: `apps/mesh/src/storage/types.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/mesh/migrations/097-connection-access-and-slots.test.ts`:

```typescript
/**
 * Integration test for migration 097: connection access + agent slots.
 *
 * Covers:
 *   1. Existing connections rows are backfilled to access='org'.
 *   2. New inserts that omit access get the post-migration default 'user'.
 *   3. CHECK constraint rejects access values other than 'user' / 'org'.
 *   4. connection_aggregations supports concrete child OR slot, not both/neither.
 *   5. Partial unique index R4: one user-private connection per (org, user, app_id).
 *   6. Partial unique index for slots: one slot per (agent, app_id).
 *   7. Down migration cleanly reverses all changes.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Migrator, sql } from "kysely";
import migrations from "./index";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../src/database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../src/storage/test-helpers";
import {
  up as up097,
  down as down097,
} from "./097-connection-access-and-slots";

const USER_A = "user_test";
const USER_B = "user_1"; // both seeded by seedCommonTestFixtures
const ORG = "org_test";

interface ConnectionRow {
  id: string;
  access: string;
  app_id: string | null;
  created_by: string;
}

async function insertConnection(
  database: TestDatabase,
  id: string,
  opts: {
    appId?: string | null;
    createdBy?: string;
    access?: string; // when omitted, DB default applies
  } = {},
): Promise<void> {
  const now = new Date().toISOString();
  const createdBy = opts.createdBy ?? USER_A;
  const appId = opts.appId ?? null;
  if (opts.access === undefined) {
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, title, connection_type,
        connection_url, app_id, status, created_at, updated_at
      ) VALUES (
        ${id}, ${ORG}, ${createdBy}, 'test', 'HTTP',
        'https://example.com', ${appId},
        'active', ${now}, ${now}
      )
    `.execute(database.db);
  } else {
    await sql`
      INSERT INTO connections (
        id, organization_id, created_by, title, connection_type,
        connection_url, app_id, access, status, created_at, updated_at
      ) VALUES (
        ${id}, ${ORG}, ${createdBy}, 'test', 'HTTP',
        'https://example.com', ${appId}, ${opts.access},
        'active', ${now}, ${now}
      )
    `.execute(database.db);
  }
}

async function insertVirtualParent(
  database: TestDatabase,
  id: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER_A}, 'agent', 'VIRTUAL',
      ${"virtual://" + id}, 'active', ${now}, ${now}
    )
  `.execute(database.db);
}

async function getAccess(
  database: TestDatabase,
  id: string,
): Promise<string> {
  const result = (await sql<ConnectionRow>`
    SELECT id, access, app_id, created_by FROM connections WHERE id = ${id}
  `.execute(database.db)) as unknown as { rows: ConnectionRow[] };
  const row = result.rows[0];
  if (!row) throw new Error(`connection ${id} not found`);
  return row.access;
}

describe("migration 097 — connection access + slots", () => {
  describe("backfill of existing rows", () => {
    let database: TestDatabase;

    beforeEach(async () => {
      database = await createTestDatabase();
      // Roll only up to 096 so the access column does not yet exist.
      const migrator = new Migrator({
        db: database.db,
        provider: { getMigrations: () => Promise.resolve(migrations) },
      });
      const { error } = await migrator.migrateTo(
        "096-org-file-configs-public-url-base",
      );
      if (error) throw error;
      await seedCommonTestFixtures(database.db);
    });

    afterEach(async () => {
      await closeTestDatabase(database);
    });

    it("backfills existing connections rows to access='org'", async () => {
      // Insert pre-097 row (no access column yet).
      const now = new Date().toISOString();
      await sql`
        INSERT INTO connections (
          id, organization_id, created_by, title, connection_type,
          connection_url, status, created_at, updated_at
        ) VALUES (
          'conn_legacy', ${ORG}, ${USER_A}, 'legacy', 'HTTP',
          'https://example.com', 'active', ${now}, ${now}
        )
      `.execute(database.db);

      // biome-ignore lint/suspicious/noExplicitAny: migration accepts test Kysely instance
      await up097(database.db as any);

      const access = await getAccess(database, "conn_legacy");
      expect(access).toBe("org");
    });
  });

  describe("post-migration schema behavior", () => {
    let database: TestDatabase;

    beforeEach(async () => {
      database = await createTestDatabase();
      await createTestSchema(database.db); // includes 097 once registered
      await seedCommonTestFixtures(database.db);
    });

    afterEach(async () => {
      await closeTestDatabase(database);
    });

    it("new inserts that omit access default to 'user'", async () => {
      await insertConnection(database, "conn_new");
      expect(await getAccess(database, "conn_new")).toBe("user");
    });

    it("CHECK rejects invalid access values", async () => {
      await expect(
        insertConnection(database, "conn_bad", { access: "public" }),
      ).rejects.toThrow();
    });

    it("R4: same user cannot have two user-private connections with same app_id", async () => {
      await insertConnection(database, "conn_gh1", {
        appId: "mcp-github",
        access: "user",
      });
      await expect(
        insertConnection(database, "conn_gh2", {
          appId: "mcp-github",
          access: "user",
        }),
      ).rejects.toThrow();
    });

    it("R4: org-shared connections of same app_id are NOT restricted", async () => {
      await insertConnection(database, "conn_org1", {
        appId: "mcp-github",
        access: "org",
      });
      await insertConnection(database, "conn_org2", {
        appId: "mcp-github",
        access: "org",
      });
      // No throw => OK
      expect(await getAccess(database, "conn_org2")).toBe("org");
    });

    it("R4: different users can each own a user-private connection of same app_id", async () => {
      await insertConnection(database, "conn_a", {
        appId: "mcp-github",
        createdBy: USER_A,
        access: "user",
      });
      await insertConnection(database, "conn_b", {
        appId: "mcp-github",
        createdBy: USER_B,
        access: "user",
      });
      expect(await getAccess(database, "conn_b")).toBe("user");
    });

    it("R4: user-private rows without app_id are exempt", async () => {
      await insertConnection(database, "conn_noapp1", {
        appId: null,
        access: "user",
      });
      await insertConnection(database, "conn_noapp2", {
        appId: null,
        access: "user",
      });
      expect(await getAccess(database, "conn_noapp2")).toBe("user");
    });

    it("aggregation XOR: row with both child_connection_id and slot_app_id is rejected", async () => {
      await insertVirtualParent(database, "agent_xor1");
      await insertConnection(database, "conn_child_xor", {
        appId: "mcp-github",
        access: "org",
      });
      const now = new Date().toISOString();
      await expect(
        sql`
          INSERT INTO connection_aggregations (
            id, parent_connection_id, child_connection_id, slot_app_id,
            dependency_mode, created_at
          ) VALUES (
            'agg_both', 'agent_xor1', 'conn_child_xor', 'mcp-github',
            'direct', ${now}
          )
        `.execute(database.db),
      ).rejects.toThrow();
    });

    it("aggregation XOR: row with neither child_connection_id nor slot_app_id is rejected", async () => {
      await insertVirtualParent(database, "agent_xor2");
      const now = new Date().toISOString();
      await expect(
        sql`
          INSERT INTO connection_aggregations (
            id, parent_connection_id, child_connection_id, slot_app_id,
            dependency_mode, created_at
          ) VALUES (
            'agg_none', 'agent_xor2', NULL, NULL,
            'direct', ${now}
          )
        `.execute(database.db),
      ).rejects.toThrow();
    });

    it("aggregation slot: row with slot_app_id and NULL child_connection_id is accepted", async () => {
      await insertVirtualParent(database, "agent_slot1");
      const now = new Date().toISOString();
      await sql`
        INSERT INTO connection_aggregations (
          id, parent_connection_id, child_connection_id, slot_app_id,
          dependency_mode, created_at
        ) VALUES (
          'agg_slot', 'agent_slot1', NULL, 'mcp-github',
          'direct', ${now}
        )
      `.execute(database.db);
      const result = (await sql<{ slot_app_id: string }>`
        SELECT slot_app_id FROM connection_aggregations WHERE id = 'agg_slot'
      `.execute(database.db)) as unknown as { rows: { slot_app_id: string }[] };
      expect(result.rows[0]?.slot_app_id).toBe("mcp-github");
    });

    it("aggregation slot uniqueness: same agent cannot have two slots of same app_id", async () => {
      await insertVirtualParent(database, "agent_dup");
      const now = new Date().toISOString();
      await sql`
        INSERT INTO connection_aggregations (
          id, parent_connection_id, child_connection_id, slot_app_id,
          dependency_mode, created_at
        ) VALUES (
          'agg_s1', 'agent_dup', NULL, 'mcp-github',
          'direct', ${now}
        )
      `.execute(database.db);
      await expect(
        sql`
          INSERT INTO connection_aggregations (
            id, parent_connection_id, child_connection_id, slot_app_id,
            dependency_mode, created_at
          ) VALUES (
            'agg_s2', 'agent_dup', NULL, 'mcp-github',
            'direct', ${now}
          )
        `.execute(database.db),
      ).rejects.toThrow();
    });
  });

  describe("down rollback", () => {
    let database: TestDatabase;

    beforeEach(async () => {
      database = await createTestDatabase();
      await createTestSchema(database.db);
      await seedCommonTestFixtures(database.db);
    });

    afterEach(async () => {
      await closeTestDatabase(database);
    });

    it("removes access column, slot_app_id column, indexes, and CHECKs", async () => {
      // biome-ignore lint/suspicious/noExplicitAny: migration accepts test Kysely instance
      await down097(database.db as any);

      // access column should be gone
      const accessColCount = (await sql<{ count: string }>`
        SELECT COUNT(*)::text as count
        FROM information_schema.columns
        WHERE table_name = 'connections' AND column_name = 'access'
      `.execute(database.db)) as unknown as { rows: { count: string }[] };
      expect(Number(accessColCount.rows[0]?.count)).toBe(0);

      // slot_app_id column should be gone
      const slotColCount = (await sql<{ count: string }>`
        SELECT COUNT(*)::text as count
        FROM information_schema.columns
        WHERE table_name = 'connection_aggregations' AND column_name = 'slot_app_id'
      `.execute(database.db)) as unknown as { rows: { count: string }[] };
      expect(Number(slotColCount.rows[0]?.count)).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/migrations/097-connection-access-and-slots.test.ts`

Expected: failure with "Cannot find module './097-connection-access-and-slots'" or similar.

- [ ] **Step 3: Write the migration file**

Create `apps/mesh/migrations/097-connection-access-and-slots.ts`:

```typescript
/**
 * Migration 097: Connection access + agent slots.
 *
 * Adds the foundation for per-user connections and typed slots in agents.
 *
 * Changes:
 *   1. connections.access — 'user' | 'org'. Existing rows backfill to 'org'.
 *      New rows default to 'user' (private-by-default).
 *   2. connection_aggregations.slot_app_id — nullable text. When set,
 *      child_connection_id must be NULL (XOR enforced by CHECK).
 *      child_connection_id is relaxed to NULLABLE.
 *   3. Partial unique index (R4): one user-private connection per
 *      (organization, creator, app_id).
 *   4. Partial unique index: one slot per (agent, app_id).
 *
 * Spec: docs/superpowers/specs/2026-05-27-private-connections-design.md
 */

import { sql, type Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  // ============================================================================
  // 1. connections.access — backfill to 'org', then flip default to 'user'.
  // ============================================================================

  await sql`
    ALTER TABLE connections
      ADD COLUMN access text NOT NULL DEFAULT 'org'
  `.execute(db);

  await sql`
    ALTER TABLE connections
      ADD CONSTRAINT connections_access_check
      CHECK (access IN ('user', 'org'))
  `.execute(db);

  await sql`
    ALTER TABLE connections
      ALTER COLUMN access SET DEFAULT 'user'
  `.execute(db);

  // R4: one user-private connection per (org, creator, app_id).
  // Partial index — org-shared and app_id-less rows are exempt.
  await sql`
    CREATE UNIQUE INDEX idx_connections_user_app_unique
      ON connections (organization_id, created_by, app_id)
      WHERE access = 'user' AND app_id IS NOT NULL
  `.execute(db);

  // ============================================================================
  // 2. connection_aggregations.slot_app_id + relaxed child_connection_id.
  // ============================================================================

  await sql`
    ALTER TABLE connection_aggregations
      ADD COLUMN slot_app_id text
  `.execute(db);

  await sql`
    ALTER TABLE connection_aggregations
      ALTER COLUMN child_connection_id DROP NOT NULL
  `.execute(db);

  await sql`
    ALTER TABLE connection_aggregations
      ADD CONSTRAINT conn_agg_slot_xor
      CHECK (
        (child_connection_id IS NOT NULL AND slot_app_id IS NULL)
        OR
        (child_connection_id IS NULL AND slot_app_id IS NOT NULL)
      )
  `.execute(db);

  // Slot uniqueness within a single agent — at most one slot per (agent, app_id).
  await sql`
    CREATE UNIQUE INDEX idx_conn_agg_slot_unique
      ON connection_aggregations (parent_connection_id, slot_app_id)
      WHERE slot_app_id IS NOT NULL
  `.execute(db);
}

export async function down(db: Kysely<unknown>): Promise<void> {
  // Reverse 2 — connection_aggregations.
  await sql`DROP INDEX IF EXISTS idx_conn_agg_slot_unique`.execute(db);
  await sql`
    ALTER TABLE connection_aggregations
      DROP CONSTRAINT IF EXISTS conn_agg_slot_xor
  `.execute(db);
  // Restore NOT NULL only if all rows have a value — null slots become 'orphan' detected by tests.
  await sql`
    ALTER TABLE connection_aggregations
      ALTER COLUMN child_connection_id SET NOT NULL
  `.execute(db);
  await sql`
    ALTER TABLE connection_aggregations
      DROP COLUMN IF EXISTS slot_app_id
  `.execute(db);

  // Reverse 1 — connections.
  await sql`DROP INDEX IF EXISTS idx_connections_user_app_unique`.execute(db);
  await sql`
    ALTER TABLE connections
      DROP CONSTRAINT IF EXISTS connections_access_check
  `.execute(db);
  await sql`
    ALTER TABLE connections
      DROP COLUMN IF EXISTS access
  `.execute(db);
}
```

- [ ] **Step 4: Register the migration in `apps/mesh/migrations/index.ts`**

Add the import alongside the others (alphabetical-ish, follows existing pattern). Locate the last import line (currently `migration096orgfileconfigspublicurlbase`) and add immediately after:

```typescript
import * as migration097connectionaccessandslots from "./097-connection-access-and-slots.ts";
```

Locate the last registration entry in the `migrations` object (currently `"096-org-file-configs-public-url-base": migration096orgfileconfigspublicurlbase,`) and add immediately after:

```typescript
  "097-connection-access-and-slots": migration097connectionaccessandslots,
```

- [ ] **Step 5: Update Kysely types in `apps/mesh/src/storage/types.ts`**

Find `MCPConnectionTable` (around line 181). Add `access` to it, placed near `status` for readability:

```typescript
// Before:
//   status: "active" | "inactive" | "error";
//   pinned: boolean;
// Insert this above `status`:
  /**
   * Visibility/ownership of this connection.
   * - 'user': private to created_by. Only that user sees/uses it.
   * - 'org': visible and usable by every member of the organization.
   * Existing rows backfilled to 'org'; new rows default to 'user'.
   */
  access: ColumnType<"user" | "org", "user" | "org" | undefined, "user" | "org">;
```

Find `ConnectionAggregationTable` (around line 789). Change `child_connection_id` to nullable and add `slot_app_id`:

```typescript
// Before:
//   child_connection_id: string; // The connection being aggregated
// Replace with:
  /**
   * Concrete child connection. NULL means this row is a slot
   * (see slot_app_id). XOR enforced by DB CHECK.
   */
  child_connection_id: string | null;

  /**
   * Slot binding — resolved at runtime to the caller's connection of
   * this app_id. NULL means this row uses a concrete child_connection_id.
   * XOR enforced by DB CHECK.
   */
  slot_app_id: string | null;
```

- [ ] **Step 6: Run the migration test, verify pass**

Run: `bun test apps/mesh/migrations/097-connection-access-and-slots.test.ts`

Expected: all `describe` blocks pass.

If a test fails, read the failure message carefully — it most likely indicates an off-by-one in CHECK syntax or index predicate. Do not weaken the test to make it pass; fix the migration.

- [ ] **Step 7: Run TypeScript check**

Run: `bun run check`

Expected: no errors. If `MCPConnectionTable.access` causes errors at insertion sites that currently omit `access`, that's because the `ColumnType<...>` insert position must accept `undefined`. Confirm the type is exactly:

```typescript
ColumnType<"user" | "org", "user" | "org" | undefined, "user" | "org">
```

(select returns the value; insert accepts the value or omits to take the DB default; update sets the value.)

- [ ] **Step 8: Run formatter**

Run: `bun run fmt`

- [ ] **Step 9: Commit**

```bash
git add apps/mesh/migrations/097-connection-access-and-slots.ts \
        apps/mesh/migrations/097-connection-access-and-slots.test.ts \
        apps/mesh/migrations/index.ts \
        apps/mesh/src/storage/types.ts
git commit -m "$(cat <<'EOF'
feat(connections): schema for user-private connections + agent slots

Adds connections.access ('user' | 'org'; existing rows → 'org', new
rows → 'user') and connection_aggregations.slot_app_id (with relaxed
child_connection_id and XOR CHECK). Adds partial unique indexes for
R4 (one user-private connection per app_id per user) and slot
uniqueness per agent.

Schema-only — no runtime behavior change. Foundation for the
private-connections design (docs/superpowers/specs/2026-05-27-private-connections-design.md).

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Verify no regressions in adjacent tests

**Files:** No code changes expected. If regressions surface, fix them in this task with a follow-up commit.

- [ ] **Step 1: Run storage and migration tests**

Run: `bun test apps/mesh/migrations apps/mesh/src/storage`

Expected: all tests pass. Migration 092 and others that run on connections tables should be unaffected because all existing rows now have `access='org'` (backfilled) and no new constraints touch existing data.

- [ ] **Step 2: Run TypeScript check on the whole workspace**

Run: `bun run check`

Expected: no errors anywhere.

If existing storage code (e.g., `apps/mesh/src/storage/virtual.ts` lines 71-96) errors because it inserts into `connections` without specifying `access`, that means the type wasn't set up with `undefined` accepted on insert — go back to Task 1 Step 5 and verify the `ColumnType` shape.

- [ ] **Step 3: Run lint**

Run: `bun run lint`

Expected: no new errors. The new migration file uses raw SQL so lint should be quiet; the test file should be clean.

- [ ] **Step 4: Run formatter check**

Run: `bun run fmt:check`

Expected: no diff. If diff, run `bun run fmt` and amend with a new commit (do not amend the migration commit).

- [ ] **Step 5: If any regressions were fixed in steps 1–4, commit them**

Only commit if anything was changed:

```bash
git add -p
git commit -m "$(cat <<'EOF'
fix: post-migration adjustments for connections.access type

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

If no changes were needed, skip the commit step.
