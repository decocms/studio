# Private Connections — Phase 2: Slot Resolver + Runtime Wiring

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make typed slots actually resolve at runtime. When an agent with a slot child is invoked, the slot is filled with the caller's own `user`-private connection of that `app_id` (falling back to an `org`-shared one if present). Includes Phase 1 follow-ups: clean up the latent `child_connection_id` type drift in `virtual.ts`.

**Architecture:** Storage exposes slot rows as a separate `slots` array on `VirtualMCPEntity`, parallel to the existing concrete `connections` array. A new pure-function resolver module (`apps/mesh/src/core/slot-resolver.ts`) translates a slot into a concrete connection ID given `{ db, organizationId, invokerUserId, appId }`. The virtual-MCP client (`createVirtualClientFrom` in `apps/mesh/src/mcp-clients/virtual-mcp/index.ts`) calls the resolver per slot before constructing the `PassthroughClient`, appending resolved connections to the existing concrete list. Unresolved slots throw a typed `SlotUnresolvedError` that the agent run path surfaces as a recoverable error. OTel attributes are emitted per resolution. The trigger/automation path already passes `automation.created_by` as the userId into `meshContextFactory` (see `apps/mesh/src/automations/dbos-workflow.ts:169-179`), so the T1 rule needs no extra plumbing.

**Tech Stack:** Kysely + raw `sql\`\`` for the resolver query, Zod for SDK type updates, Bun test runner, OpenTelemetry tracing already wired into `defineTool`.

**Spec reference:** `docs/superpowers/specs/2026-05-27-private-connections-design.md` (sections "Concepts → Typed slots in agents", "Slot resolution", "Rollout → Phase 2").

**Prior phase:** `docs/superpowers/plans/2026-05-27-private-connections-phase-1-schema.md` — schema landed in commit `f97d1201e`.

---

## File Structure

**Create:**
- `apps/mesh/src/core/slot-resolver.ts` — pure resolver function + `SlotUnresolvedError` + simple Map-based cache class
- `apps/mesh/src/core/slot-resolver.test.ts` — unit tests against embedded postgres

**Modify:**
- `packages/mesh-sdk/src/types/virtual-mcp.ts` — add `slots` field to `VirtualMCPEntitySchema` (and the create/update input schemas)
- `apps/mesh/src/storage/virtual.ts` — `RawAggregationRow` becomes nullable on `child_connection_id` + gains `slot_app_id`; SELECTs include `slot_app_id`; `deserializeVirtualMCPEntity` partitions rows into `connections` (concrete) and `slots` (slot-only); the create/update paths support inserting slot rows
- `apps/mesh/src/mcp-clients/virtual-mcp/index.ts` — `createVirtualClientFrom` resolves slots before constructing the PassthroughClient
- `apps/mesh/src/mcp-clients/virtual-mcp/passthrough-client.ts` — accepts the resolved-and-appended connections array unchanged (no structural change needed if step above appends resolved connection_ids to `options.virtualMcp.connections` and the resolved entities to `options.connections`)

**Context the subagent should know without searching:**
- DB tables `connections`, `connection_aggregations`. Schema from Phase 1 commit `f97d1201e`.
- Existing aggregation walker: `VirtualMCPStorage.findById` in `apps/mesh/src/storage/virtual.ts` (around line 134-195). The SELECT lives ~lines 180-188. Deserialization at `deserializeVirtualMCPEntity` (~line 555-600).
- `RawAggregationRow` local type at `apps/mesh/src/storage/virtual.ts:46-56`. Phase 1 left `child_connection_id: string` non-nullable — this task corrects it.
- Read site `apps/mesh/src/storage/virtual.ts:589` currently does `connection_id: agg.child_connection_id` for every row regardless of whether it's a slot. After this task, only rows with `child_connection_id !== null` become entries in `connections`; rows with `slot_app_id !== null` go into the new `slots` array.
- The virtual-MCP client entry point: `createVirtualClient` at `apps/mesh/src/mcp-clients/virtual-mcp/index.ts:39-126` calls `createVirtualClientFrom`. The latter takes the loaded `VirtualMCPEntity` and an array of loaded `ConnectionEntity`s and constructs the `PassthroughClient`. This is where slot resolution must happen.
- `PassthroughClient` at `apps/mesh/src/mcp-clients/virtual-mcp/passthrough-client.ts:23-50` builds a `vmcpConnMap` keyed by `connection_id`. Resolved slots must produce entries in `options.virtualMcp.connections` (with the resolved `connection_id`) and the resolved `ConnectionEntity` must appear in `options.connections`.
- MeshContext shape: `apps/mesh/src/core/mesh-context.ts:179-198`. `ctx.auth.user?.id` and `ctx.auth.apiKey?.userId` are the two userId sources; prefer `user.id` and fall back to `apiKey.userId`.
- Trigger/automation path: `apps/mesh/src/automations/dbos-workflow.ts:169-179` (`prepareFireStep`) already calls `meshContextFactory(automation.organization_id, automation.created_by)`. The resulting `meshCtx.auth.user.id` is the automation creator's userId. **No code change needed** for triggers — the T1 rule (slot resolves to trigger owner's connection) falls out for free.
- `defineTool` (apps/mesh/src/core/define-tool.ts) wraps every tool call with an OTel span. Slot OTel attributes should be set on the agent's run span — find the closest span to the resolution point and call `span.setAttribute(...)`.
- For tests: same harness pattern as Phase 1. `createTestDatabase()` + `createTestSchema(db)` + `seedCommonTestFixtures(db)`. Seeded users: `user_1`, `user_123`, `user_test`, `test_user`. Seeded orgs: `org_1`, `org_123`, `org_456`, `org_test`.
- Pre-commit hooks: `bun run fmt`. Type gate: `bun run check`.

---

## Task 1: Surface slot rows in storage + clean up `RawAggregationRow` drift

**Files:**
- Modify: `apps/mesh/src/storage/virtual.ts`
- Modify: `packages/mesh-sdk/src/types/virtual-mcp.ts`
- Create: `apps/mesh/src/storage/virtual-slots.test.ts` (new focused test file; do not bloat the existing `virtual.test.ts` if one exists)

This task picks up the Phase 1 follow-ups (`RawAggregationRow` lying about nullability; read path returning null as a concrete connection_id) and surfaces slot rows on the entity for downstream consumers.

- [ ] **Step 1: Read the current state of virtual.ts and the SDK type**

Read the following before changing anything:
- `apps/mesh/src/storage/virtual.ts` lines 1–100 (imports, RawAggregationRow, top of class)
- `apps/mesh/src/storage/virtual.ts` lines 130–250 (findById and its SELECT)
- `apps/mesh/src/storage/virtual.ts` lines 380–470 (update path with previousIds handling — already null-filtered in Phase 1)
- `apps/mesh/src/storage/virtual.ts` lines 555–615 (deserializeVirtualMCPEntity)
- `packages/mesh-sdk/src/types/virtual-mcp.ts` lines 13–46 (VirtualMCPConnectionSchema and Input variant) and 386–500 (VirtualMCPEntitySchema, VirtualMCPCreateDataSchema, VirtualMCPUpdateDataSchema)

Confirm the line numbers above before editing — they may have drifted by a few lines.

- [ ] **Step 2: Add a `VirtualMCPSlotSchema` to the SDK types**

In `packages/mesh-sdk/src/types/virtual-mcp.ts`, immediately after the `VirtualMCPConnectionInputSchema` block (the one that ends at line ~46), insert:

```typescript
/**
 * Virtual MCP slot schema — a typed dependency declared without binding to a
 * specific connection. Resolved at runtime to the caller's user-private
 * connection of the matching app_id (falling back to an org-shared one).
 *
 * Slot uniqueness within a single agent is enforced by a partial unique index
 * on (parent_connection_id, slot_app_id) WHERE slot_app_id IS NOT NULL.
 */
const VirtualMCPSlotSchema = z.object({
  slot_app_id: z
    .string()
    .describe("app_id this slot is typed by (e.g. 'mcp-github')"),
  selected_tools: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected tool names. null = all tools, array = only these tools",
    ),
  selected_resources: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected resource URIs or patterns. null = all, array = only these",
    ),
  selected_prompts: z
    .array(z.string())
    .nullable()
    .describe(
      "Selected prompt names. null = all prompts, array = only these prompts",
    ),
});

export type VirtualMCPSlot = z.infer<typeof VirtualMCPSlotSchema>;

const VirtualMCPSlotInputSchema = VirtualMCPSlotSchema.extend({
  selected_tools: VirtualMCPSlotSchema.shape.selected_tools.optional(),
  selected_resources: VirtualMCPSlotSchema.shape.selected_resources.optional(),
  selected_prompts: VirtualMCPSlotSchema.shape.selected_prompts.optional(),
});
```

In `VirtualMCPEntitySchema` (line ~386), add `slots` right after `connections`:

```typescript
  slots: z
    .array(VirtualMCPSlotSchema)
    .default([])
    .describe(
      "Typed slots — resolved to the caller's connection of the matching app_id at runtime.",
    ),
```

In `VirtualMCPCreateDataSchema` (line ~448), add `slots` right after `connections`:

```typescript
  slots: z
    .array(VirtualMCPSlotInputSchema)
    .optional()
    .default([])
    .describe("Typed slots to declare on the new agent."),
```

In `VirtualMCPUpdateDataSchema` (line ~505), add `slots` right after `connections`:

```typescript
  slots: z
    .array(VirtualMCPSlotInputSchema)
    .optional()
    .describe("New slots (replaces existing slots if provided)."),
```

- [ ] **Step 3: Update `RawAggregationRow` in `apps/mesh/src/storage/virtual.ts`**

Replace the existing type (around line 46-56):

```typescript
type RawAggregationRow = {
  id: string;
  parent_connection_id: string;
  child_connection_id: string | null; // null for slot rows
  slot_app_id: string | null; // null for concrete rows; XOR with child_connection_id
  selected_tools: string | string[] | null;
  selected_resources: string | string[] | null;
  selected_prompts: string | string[] | null;
  dependency_mode: DependencyMode;
  created_at: Date | string;
};
```

- [ ] **Step 4: Update SELECTs to include `slot_app_id`**

Find every `.select(["id", "parent_connection_id", "child_connection_id", ...])` in `apps/mesh/src/storage/virtual.ts` (use the file structure described in step 1). For each one that returns `RawAggregationRow`-shaped data, add `"slot_app_id"` to the select list.

There should be at least 2 such selects (one in `findById`, one in `list` / `listByIds`). Check by greping `child_connection_id` in the file and looking at the surrounding `.select(...)` calls.

- [ ] **Step 5: Update `deserializeVirtualMCPEntity` to partition into `connections` and `slots`**

Find `deserializeVirtualMCPEntity` (around line 555-615). Locate the block where `connections` is built from aggregations (around line 588). Replace it with:

```typescript
    const connections: VirtualMCPConnection[] = [];
    const slots: VirtualMCPSlot[] = [];
    for (const agg of aggregationRows) {
      const selectedTools = parseJsonArray(agg.selected_tools);
      const selectedResources = parseJsonArray(agg.selected_resources);
      const selectedPrompts = parseJsonArray(agg.selected_prompts);
      if (agg.child_connection_id !== null) {
        connections.push({
          connection_id: agg.child_connection_id,
          selected_tools: selectedTools,
          selected_resources: selectedResources,
          selected_prompts: selectedPrompts,
        });
      } else if (agg.slot_app_id !== null) {
        slots.push({
          slot_app_id: agg.slot_app_id,
          selected_tools: selectedTools,
          selected_resources: selectedResources,
          selected_prompts: selectedPrompts,
        });
      }
      // XOR CHECK at DB level guarantees one of the two branches always fires.
    }
```

(If the existing code uses a different name for the JSON-array parser, use that. If it inlines `JSON.parse(...)` calls, keep them inline in both branches.)

Update the returned object to include the `slots` field. Look for the `return` statement near the bottom of `deserializeVirtualMCPEntity` and add `slots,` alongside `connections,`.

Import the `VirtualMCPSlot` type alongside `VirtualMCPConnection` at the top of the file.

- [ ] **Step 6: Handle slots in create/update paths**

In `VirtualMCPStorage.create` (around line 61-130) and `update` (around line ~290-450):

The `data.connections` and `data.slots` arrays must both produce rows in `connection_aggregations`. Existing code maps `data.connections` to rows with concrete `child_connection_id`. Add a parallel block that maps `data.slots` to rows with `slot_app_id` and `child_connection_id: null`.

Concretely, after the existing `data.connections.length > 0` insert block, add:

```typescript
    if (data.slots && data.slots.length > 0) {
      await this.db
        .insertInto("connection_aggregations")
        .values(
          data.slots.map((slot) => ({
            id: generatePrefixedId("agg"),
            parent_connection_id: id,
            child_connection_id: null,
            slot_app_id: slot.slot_app_id,
            selected_tools: slot.selected_tools
              ? JSON.stringify(slot.selected_tools)
              : null,
            selected_resources: slot.selected_resources
              ? JSON.stringify(slot.selected_resources)
              : null,
            selected_prompts: slot.selected_prompts
              ? JSON.stringify(slot.selected_prompts)
              : null,
            dependency_mode: "direct" as DependencyMode,
            created_at: now,
          })),
        )
        .execute();
    }
```

For `update`, mirror this in the same block where concrete `connections` are replaced. The current implementation likely deletes all `direct` aggregations and re-inserts; slots ride along the same delete/re-insert cycle.

- [ ] **Step 7: Write the failing storage test**

Create `apps/mesh/src/storage/virtual-slots.test.ts`:

```typescript
/**
 * Storage-layer tests for slot rows on Virtual MCPs.
 *
 * Verifies that the aggregations table can store both concrete child
 * connections and typed slots, and that VirtualMCPStorage round-trips
 * them into the new `slots` field on VirtualMCPEntity.
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
import { VirtualMCPStorage } from "./virtual";

const USER = "user_test";
const ORG = "org_test";

async function insertChildConnection(
  database: TestDatabase,
  id: string,
  appId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${USER}, 'child', 'HTTP',
      'https://example.com', ${appId}, 'org',
      'active', ${now}, ${now}
    )
  `.execute(database.db);
}

describe("VirtualMCPStorage — slots", () => {
  let database: TestDatabase;
  let storage: VirtualMCPStorage;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
    storage = new VirtualMCPStorage(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("creates an agent with a concrete child and a slot, round-trips both", async () => {
    await insertChildConnection(database, "conn_concrete", "mcp-linear");

    const entity = await storage.create(ORG, USER, {
      title: "test agent",
      connections: [
        {
          connection_id: "conn_concrete",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    expect(entity.connections).toHaveLength(1);
    expect(entity.connections[0]?.connection_id).toBe("conn_concrete");
    expect(entity.slots).toHaveLength(1);
    expect(entity.slots[0]?.slot_app_id).toBe("mcp-github");

    const reloaded = await storage.findById(ORG, entity.id);
    expect(reloaded?.connections).toHaveLength(1);
    expect(reloaded?.slots).toHaveLength(1);
    expect(reloaded?.slots[0]?.slot_app_id).toBe("mcp-github");
  });

  it("update replaces slots alongside connections", async () => {
    await insertChildConnection(database, "conn_a", "mcp-linear");
    await insertChildConnection(database, "conn_b", "mcp-notion");

    const entity = await storage.create(ORG, USER, {
      title: "test agent",
      connections: [
        {
          connection_id: "conn_a",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    const updated = await storage.update(ORG, entity.id, USER, {
      connections: [
        {
          connection_id: "conn_b",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-slack",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    expect(updated?.connections.map((c) => c.connection_id)).toEqual([
      "conn_b",
    ]);
    expect(updated?.slots.map((s) => s.slot_app_id)).toEqual(["mcp-slack"]);
  });

  it("XOR enforced by DB: slot row + concrete child in same agent is OK on separate rows", async () => {
    await insertChildConnection(database, "conn_x", "mcp-linear");
    const entity = await storage.create(ORG, USER, {
      title: "test",
      connections: [
        {
          connection_id: "conn_x",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });
    expect(entity.connections).toHaveLength(1);
    expect(entity.slots).toHaveLength(1);
  });
});
```

- [ ] **Step 8: Run the test, verify failure (slots field doesn't exist yet on VirtualMCPCreateData)**

Run: `bun test apps/mesh/src/storage/virtual-slots.test.ts`

Expected: type errors or runtime failures saying `slots` is not assignable or `entity.slots` is undefined.

- [ ] **Step 9: Run the test again after steps 2-6 are complete, verify pass**

Run: `bun test apps/mesh/src/storage/virtual-slots.test.ts`

Expected: all 3 tests pass.

- [ ] **Step 10: Run typecheck and existing storage tests**

Run: `bun run check`

Run: `bun test apps/mesh/src/storage`

Expected: clean. Some existing `virtual.test.ts` cases (if any) may need a trivial `slots: []` addition where `VirtualMCPCreateData` is constructed in fixtures. If so, update them.

- [ ] **Step 11: Run formatter**

Run: `bun run fmt`

- [ ] **Step 12: Commit**

```bash
git add apps/mesh/src/storage/virtual.ts \
        apps/mesh/src/storage/virtual-slots.test.ts \
        packages/mesh-sdk/src/types/virtual-mcp.ts
git commit -m "$(cat <<'EOF'
feat(connections): surface slot rows on VirtualMCPEntity

Adds VirtualMCPSlot to the mesh-sdk type and a parallel `slots` array
on VirtualMCPEntity / Create / Update inputs. VirtualMCPStorage
partitions connection_aggregations rows into concrete `connections`
(child_connection_id set) and `slots` (slot_app_id set), using the
XOR CHECK from migration 097. Also fixes the Phase 1 follow-ups:
RawAggregationRow.child_connection_id is now properly typed as
string | null, and the deserialization read path no longer treats
null as a concrete connection_id.

Storage layer only — runtime resolution lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Implement the slot resolver module

**Files:**
- Create: `apps/mesh/src/core/slot-resolver.ts`
- Create: `apps/mesh/src/core/slot-resolver.test.ts`

- [ ] **Step 1: Write the failing test file**

Create `apps/mesh/src/core/slot-resolver.test.ts`:

```typescript
/**
 * Unit tests for slot-resolver. Given a Kysely DB plus a context
 * (organizationId, invokerUserId, appId), the resolver returns the
 * caller's user-private connection of the matching shape, falling back
 * to an org-shared one. Returns null when nothing matches.
 *
 * Resolution rules (from spec section "Slot resolution"):
 *  1. Match connections in the same organization with the same app_id.
 *  2. Only consider connections with status='active'.
 *  3. Prefer access='user' AND created_by=invokerUserId.
 *  4. Fall back to access='org' when no private match exists.
 *  5. Return null when neither matches.
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
} from "../storage/test-helpers";
import {
  SlotUnresolvedError,
  resolveSlot,
  SlotResolutionCache,
} from "./slot-resolver";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";
const OTHER_ORG = "org_1";

async function insertConn(
  database: TestDatabase,
  id: string,
  opts: {
    appId: string;
    access: "user" | "org";
    createdBy?: string;
    organizationId?: string;
    status?: "active" | "inactive";
  },
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${opts.organizationId ?? ORG}, ${opts.createdBy ?? USER_A},
      'test', 'HTTP', 'https://example.com', ${opts.appId},
      ${opts.access}, ${opts.status ?? "active"}, ${now}, ${now}
    )
  `.execute(database.db);
}

describe("resolveSlot", () => {
  let database: TestDatabase;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("prefers user-private when both user-private and org-shared exist", async () => {
    await insertConn(database, "conn_org", {
      appId: "mcp-github",
      access: "org",
    });
    await insertConn(database, "conn_user", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toEqual({
      connectionId: "conn_user",
      access: "user",
    });
  });

  it("falls back to org-shared when caller has no private connection", async () => {
    await insertConn(database, "conn_org", {
      appId: "mcp-github",
      access: "org",
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_B, // no private connection
      appId: "mcp-github",
    });

    expect(resolved).toEqual({
      connectionId: "conn_org",
      access: "org",
    });
  });

  it("returns null when nothing matches", async () => {
    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });
    expect(resolved).toBeNull();
  });

  it("does not resolve inactive connections", async () => {
    await insertConn(database, "conn_dead", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
      status: "inactive",
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toBeNull();
  });

  it("does not leak across organizations", async () => {
    await insertConn(database, "conn_other_org", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
      organizationId: OTHER_ORG,
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toBeNull();
  });

  it("does not match another user's user-private connection", async () => {
    await insertConn(database, "conn_other_user", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_B,
    });

    const resolved = await resolveSlot(database.db, {
      organizationId: ORG,
      invokerUserId: USER_A,
      appId: "mcp-github",
    });

    expect(resolved).toBeNull();
  });
});

describe("SlotResolutionCache", () => {
  it("returns cached result without hitting the DB on repeated calls", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    const result1 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "conn_user_a", access: "user" as const };
    });
    const result2 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "different_id", access: "user" as const };
    });

    expect(result1).toEqual({ connectionId: "conn_user_a", access: "user" });
    expect(result2).toEqual({ connectionId: "conn_user_a", access: "user" }); // cached
    expect(hitCount).toBe(1);
  });

  it("caches null results too", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    const result1 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return null;
    });
    const result2 = await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "conn_new", access: "user" as const };
    });

    expect(result1).toBeNull();
    expect(result2).toBeNull(); // cached null
    expect(hitCount).toBe(1);
  });

  it("scopes cache by (userId, appId)", async () => {
    const cache = new SlotResolutionCache();
    let hitCount = 0;

    await cache.resolve("user_a", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "ga", access: "user" as const };
    });
    await cache.resolve("user_b", "mcp-github", async () => {
      hitCount++;
      return { connectionId: "gb", access: "user" as const };
    });
    await cache.resolve("user_a", "mcp-linear", async () => {
      hitCount++;
      return { connectionId: "la", access: "user" as const };
    });

    expect(hitCount).toBe(3);
  });
});

describe("SlotUnresolvedError", () => {
  it("carries app_id for the UI to surface", () => {
    const err = new SlotUnresolvedError("mcp-github");
    expect(err.appId).toBe("mcp-github");
    expect(err.name).toBe("SlotUnresolvedError");
    expect(err.message).toContain("mcp-github");
  });
});
```

- [ ] **Step 2: Run the test, verify failure**

Run: `bun test apps/mesh/src/core/slot-resolver.test.ts`

Expected: module-not-found error.

- [ ] **Step 3: Implement the resolver module**

Create `apps/mesh/src/core/slot-resolver.ts`:

```typescript
/**
 * Slot resolver — translates a typed slot on an agent into a concrete
 * connection_id at runtime, given the invoking user's identity.
 *
 * See: docs/superpowers/specs/2026-05-27-private-connections-design.md
 *      (section "Slot resolution")
 *
 * Resolution rules:
 *   1. Same organization as the agent.
 *   2. Same app_id as the slot.
 *   3. Active connections only.
 *   4. Prefer (access='user' AND created_by=invokerUserId).
 *   5. Fall back to (access='org').
 *   6. Return null when neither matches; callers decide whether to throw
 *      SlotUnresolvedError or propagate null.
 *
 * The resolver is a pure function over the DB + context; no global state.
 * For one agent run, callers should reuse a SlotResolutionCache instance
 * so repeated slot lookups inside the run don't re-hit the DB.
 */

import { sql, type Kysely } from "kysely";

export interface SlotResolveContext {
  organizationId: string;
  invokerUserId: string;
  appId: string;
}

export interface ResolvedSlot {
  connectionId: string;
  access: "user" | "org";
}

export class SlotUnresolvedError extends Error {
  readonly appId: string;
  constructor(appId: string) {
    super(
      `Slot for app_id '${appId}' could not be resolved — the caller has no matching connection.`,
    );
    this.name = "SlotUnresolvedError";
    this.appId = appId;
  }
}

interface ResolvedRow {
  id: string;
  access: "user" | "org";
}

export async function resolveSlot(
  db: Kysely<unknown>,
  ctx: SlotResolveContext,
): Promise<ResolvedSlot | null> {
  const result = (await sql<ResolvedRow>`
    SELECT id, access
    FROM connections
    WHERE organization_id = ${ctx.organizationId}
      AND app_id = ${ctx.appId}
      AND status = 'active'
      AND (
        (access = 'user' AND created_by = ${ctx.invokerUserId})
        OR access = 'org'
      )
    ORDER BY (access = 'user') DESC
    LIMIT 1
  `.execute(db)) as unknown as { rows: ResolvedRow[] };

  const row = result.rows[0];
  if (!row) return null;
  return { connectionId: row.id, access: row.access };
}

/**
 * Per-run resolution cache. Reuse one instance for the duration of a
 * single agent run so the same (userId, appId) lookup hits the DB once.
 *
 * Caches null results too — a missing connection won't appear mid-run
 * unless the user creates one, and the cache lifetime is intentionally
 * short (one run), so that race is acceptable.
 */
export class SlotResolutionCache {
  private cache = new Map<string, ResolvedSlot | null>();

  async resolve(
    userId: string,
    appId: string,
    loader: () => Promise<ResolvedSlot | null>,
  ): Promise<ResolvedSlot | null> {
    const key = `${userId}::${appId}`;
    if (this.cache.has(key)) {
      return this.cache.get(key) ?? null;
    }
    const value = await loader();
    this.cache.set(key, value);
    return value;
  }
}
```

- [ ] **Step 4: Run the tests, verify pass**

Run: `bun test apps/mesh/src/core/slot-resolver.test.ts`

Expected: all describe blocks pass (6 + 3 + 1 = 10 tests).

- [ ] **Step 5: Run typecheck and formatter**

Run: `bun run check`
Run: `bun run fmt`

- [ ] **Step 6: Commit**

```bash
git add apps/mesh/src/core/slot-resolver.ts \
        apps/mesh/src/core/slot-resolver.test.ts
git commit -m "$(cat <<'EOF'
feat(connections): slot resolver module

Pure-function resolver that translates a typed slot
(organizationId, invokerUserId, app_id) into a concrete connection_id:
prefers caller's user-private connection, falls back to org-shared,
returns null when neither matches. Includes SlotUnresolvedError for
callers that want to throw, and SlotResolutionCache for per-run
deduplication.

No runtime caller yet — wiring lands in the next commit.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Wire resolver into virtual MCP client + OpenTelemetry

**Files:**
- Modify: `apps/mesh/src/mcp-clients/virtual-mcp/index.ts`
- Create: `apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver-integration.test.ts`

- [ ] **Step 1: Read the current `createVirtualClient` / `createVirtualClientFrom`**

Read `apps/mesh/src/mcp-clients/virtual-mcp/index.ts` lines 1-150 to understand the current signature, what context is in scope, and how the passthrough client is constructed.

Read `apps/mesh/src/mcp-clients/virtual-mcp/passthrough-client.ts` lines 1-60 to understand what `options.virtualMcp.connections` and `options.connections` look like at construction time.

Find where `MeshContext` (or the storage / db handle) is in scope at the point of construction.

- [ ] **Step 2: Add slot resolution between entity load and passthrough construction**

Inside `createVirtualClientFrom` (or wherever the entity + connections are assembled), insert resolution of every slot before the PassthroughClient is constructed. Sketch:

```typescript
// After: entity is loaded, options.connections array is the list of loaded ConnectionEntity[]
const invokerUserId =
  ctx.auth.user?.id ?? ctx.auth.apiKey?.userId ?? null;

const slotCache = new SlotResolutionCache();
const resolvedConnections: ConnectionEntity[] = [...options.connections];
const resolvedVMCPConnections: VirtualMCPConnection[] = [
  ...entity.connections,
];

for (const slot of entity.slots) {
  if (!invokerUserId) {
    throw new SlotUnresolvedError(slot.slot_app_id);
  }
  const resolved = await slotCache.resolve(
    invokerUserId,
    slot.slot_app_id,
    () =>
      resolveSlot(ctx.db, {
        organizationId: entity.organization_id,
        invokerUserId,
        appId: slot.slot_app_id,
      }),
  );
  if (!resolved) {
    throw new SlotUnresolvedError(slot.slot_app_id);
  }
  // Load the resolved ConnectionEntity (use the existing connection-storage
  // method already used to populate options.connections — find it by reading
  // a few lines above the loop).
  const resolvedEntity = await ctx.storage.connections.findById(
    resolved.connectionId,
    entity.organization_id,
  );
  if (!resolvedEntity) {
    // Shouldn't happen: resolver returned an id that doesn't exist.
    throw new SlotUnresolvedError(slot.slot_app_id);
  }
  resolvedConnections.push(resolvedEntity);
  resolvedVMCPConnections.push({
    connection_id: resolved.connectionId,
    selected_tools: slot.selected_tools,
    selected_resources: slot.selected_resources,
    selected_prompts: slot.selected_prompts,
  });

  // OpenTelemetry span attributes — emit on the current active span so
  // anyone debugging the agent run sees whose creds were used.
  const span = trace.getActiveSpan();
  span?.setAttribute(`slot.${slot.slot_app_id}.app_id`, slot.slot_app_id);
  span?.setAttribute(
    `slot.${slot.slot_app_id}.connection_id`,
    resolved.connectionId,
  );
  span?.setAttribute(`slot.${slot.slot_app_id}.access`, resolved.access);
}

// Then construct PassthroughClient with the resolved arrays:
return new PassthroughClient({
  ...options,
  virtualMcp: { ...entity, connections: resolvedVMCPConnections },
  connections: resolvedConnections,
});
```

Adapt names to match the actual code — the actual variable names for `ctx`, `options`, `entity`, and `storage` may differ. The structural change is:

1. Compute `invokerUserId` from MeshContext.
2. For each `entity.slots[]`, call the resolver, throw `SlotUnresolvedError` on miss, load the resolved `ConnectionEntity`.
3. Append resolved entries to BOTH `options.connections` (loaded entities) AND `entity.connections` (VirtualMCPConnection metadata).
4. Pass the combined arrays into `PassthroughClient`.
5. Emit OTel span attributes for each resolved slot.

Add the imports at the top:

```typescript
import { trace } from "@opentelemetry/api";
import {
  resolveSlot,
  SlotResolutionCache,
  SlotUnresolvedError,
} from "../../core/slot-resolver";
```

- [ ] **Step 3: Write the integration test**

Create `apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver-integration.test.ts`:

```typescript
/**
 * Integration tests for slot resolution inside the virtual MCP client.
 *
 * Scenarios:
 *   1. Agent has a slot. Caller has a matching user-private connection.
 *      → Slot resolves to caller's connection; PassthroughClient is
 *        constructed with the resolved connection appended.
 *   2. Agent has a slot. Caller has only an org-shared matching connection.
 *      → Slot resolves to the org-shared one.
 *   3. Agent has a slot. Caller has nothing matching.
 *      → createVirtualClient throws SlotUnresolvedError carrying app_id.
 *   4. Agent triggered by automation (invoker = automation.created_by).
 *      → Slot resolves to the automation owner's private connection.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { sql } from "kysely";
import {
  closeTestDatabase,
  createTestDatabase,
  type TestDatabase,
} from "../../database/test-db";
import {
  createTestSchema,
  seedCommonTestFixtures,
} from "../../storage/test-helpers";
import { SlotUnresolvedError } from "../../core/slot-resolver";
import { VirtualMCPStorage } from "../../storage/virtual";

// NOTE: import paths for createVirtualClient and the MeshContext factory
// must match the actual source — adjust during implementation.
import { createVirtualClient } from "./index";

const USER_A = "user_test";
const USER_B = "user_1";
const ORG = "org_test";

async function insertConn(
  database: TestDatabase,
  id: string,
  opts: {
    appId: string;
    access: "user" | "org";
    createdBy?: string;
  },
): Promise<void> {
  const now = new Date().toISOString();
  await sql`
    INSERT INTO connections (
      id, organization_id, created_by, title, connection_type,
      connection_url, app_id, access, status, created_at, updated_at
    ) VALUES (
      ${id}, ${ORG}, ${opts.createdBy ?? USER_A}, 'test', 'HTTP',
      'https://example.com', ${opts.appId},
      ${opts.access}, 'active', ${now}, ${now}
    )
  `.execute(database.db);
}

/**
 * Build a minimal MeshContext shim for createVirtualClient.
 * NOTE: The exact MeshContext factory and the fields createVirtualClient
 * reads must be matched here. Read createVirtualClient's signature and
 * adjust this helper accordingly. Worst case: stub a minimal context
 * inline that satisfies just `auth.user.id`, `db`, and `storage.connections`.
 */
function buildContext(
  database: TestDatabase,
  invokerUserId: string,
  storage: VirtualMCPStorage,
) {
  // TODO during impl: match createVirtualClient's actual context expectation.
  // The relevant fields are: auth.user.id, db (the kysely instance),
  // storage.connections (with findById(id, orgId)). Everything else can
  // be left undefined or stubbed.
  return {
    auth: { user: { id: invokerUserId } },
    db: database.db,
    organizationId: ORG,
    storage,
  } as unknown as Parameters<typeof createVirtualClient>[0];
}

describe("slot resolution at virtual MCP client construction", () => {
  let database: TestDatabase;
  let storage: VirtualMCPStorage;

  beforeEach(async () => {
    database = await createTestDatabase();
    await createTestSchema(database.db);
    await seedCommonTestFixtures(database.db);
    storage = new VirtualMCPStorage(database.db);
  });

  afterEach(async () => {
    await closeTestDatabase(database);
  });

  it("slot resolves to caller's user-private connection", async () => {
    await insertConn(database, "conn_user_a_gh", {
      appId: "mcp-github",
      access: "user",
      createdBy: USER_A,
    });
    const agent = await storage.create(ORG, USER_A, {
      title: "agent",
      connections: [],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    // The construction should succeed and the resolved connection should
    // be wired into the passthrough client. Exact assertion depends on the
    // public surface of createVirtualClient — at minimum the call must not
    // throw, and inspecting the client's exposed connections list must
    // include 'conn_user_a_gh'.
    const client = await createVirtualClient(
      buildContext(database, USER_A, storage),
      agent,
    );
    expect(client).toBeDefined();
    // If the client exposes the connections it's wired to, assert here:
    // expect(client.connections.map(c => c.id)).toContain("conn_user_a_gh");
  });

  it("falls back to org-shared when caller has no private connection", async () => {
    await insertConn(database, "conn_org_gh", {
      appId: "mcp-github",
      access: "org",
    });
    const agent = await storage.create(ORG, USER_A, {
      title: "agent",
      connections: [],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    const client = await createVirtualClient(
      buildContext(database, USER_B, storage),
      agent,
    );
    expect(client).toBeDefined();
  });

  it("throws SlotUnresolvedError when no matching connection exists", async () => {
    const agent = await storage.create(ORG, USER_A, {
      title: "agent",
      connections: [],
      slots: [
        {
          slot_app_id: "mcp-github",
          selected_tools: null,
          selected_resources: null,
          selected_prompts: null,
        },
      ],
    });

    await expect(
      createVirtualClient(buildContext(database, USER_B, storage), agent),
    ).rejects.toThrow(SlotUnresolvedError);
  });
});
```

- [ ] **Step 4: Run the integration test, verify failure (driver not yet wired)**

Run: `bun test apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver-integration.test.ts`

Expected: tests fail because slot resolution isn't yet plugged in.

- [ ] **Step 5: After Step 2's wiring is complete, re-run the integration tests, verify pass**

Run: `bun test apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver-integration.test.ts`

Expected: 3 tests pass.

If the test helper `buildContext` doesn't match the actual `createVirtualClient` signature, fix the helper rather than the implementation.

- [ ] **Step 6: Run typecheck**

Run: `bun run check`

Expected: clean.

- [ ] **Step 7: Run formatter**

Run: `bun run fmt`

- [ ] **Step 8: Commit**

```bash
git add apps/mesh/src/mcp-clients/virtual-mcp/index.ts \
        apps/mesh/src/mcp-clients/virtual-mcp/slot-resolver-integration.test.ts
git commit -m "$(cat <<'EOF'
feat(connections): wire slot resolver into virtual MCP client

createVirtualClient now resolves every slot on the agent before
constructing the PassthroughClient. Slot resolution uses
ctx.auth.user.id (or ctx.auth.apiKey.userId) as the invoker. Resolved
connections are appended to the passthrough's children, so downstream
tool dispatch is unchanged. Unresolved slots throw SlotUnresolvedError
carrying the missing app_id so the UI can prompt the user to connect.

OpenTelemetry span attributes (slot.<app>.connection_id,
slot.<app>.access) are emitted per resolution for debuggability.

Trigger/automation runs already pass automation.created_by as the
identity into meshContextFactory (dbos-workflow.ts:171), so the T1
rule (slot resolves to trigger owner) requires no extra wiring.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Regression sweep + final verification

**Files:** No code changes expected. If regressions surface, fix them in this task with a follow-up commit.

- [ ] **Step 1: Run full test suite for mesh**

Run: `bun test apps/mesh`

Expected: all green (or only pre-existing skips). Pay attention to tests in:
- `apps/mesh/src/storage/` — virtual-mcp round trips, connection storage, downstream-token
- `apps/mesh/src/mcp-clients/virtual-mcp/` — any existing client tests
- `apps/mesh/src/tools/virtual/` — agent-related tools
- `apps/mesh/src/automations/` — trigger/automation execution

- [ ] **Step 2: Run typecheck across the workspace**

Run: `bun run check`

Expected: clean.

- [ ] **Step 3: Run lint**

Run: `bun run lint`

Expected: no new errors. (3 pre-existing warnings in chat-context.tsx are unrelated noise; ignore.)

- [ ] **Step 4: Run formatter check**

Run: `bun run fmt:check`

Expected: no diff.

- [ ] **Step 5: Spot-check the agent run path manually (optional)**

Start the dev server:

```bash
bun run dev
```

If a dev environment is available and time allows: create an agent with a slot, hit it from the web UI as the agent's creator, verify the run uses their connection. Switch to a different account, verify SlotUnresolvedError surfaces in the UI as the expected error (raw error is fine for Phase 2 — friendly UI lands in Phase 3).

This step is **optional** — skip if dev environment is not running.

- [ ] **Step 6: Commit any fixes from steps 1-4 if needed**

Only commit if anything was modified. If everything passed, skip this step entirely.

```bash
git add -p
git commit -m "$(cat <<'EOF'
fix: post-Phase-2 adjustments

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```
