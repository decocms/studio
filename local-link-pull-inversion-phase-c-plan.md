# Local-Link Pull Inversion — Phase C (Control Long-Poll: Cancel + HITL + Sandbox Lifecycle) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the **control long-poll** leg (`GET /api/:org/links/control`) plus its two durable backstops — a `cancel_requested_at` column that makes ingest `409` even if the control frame is missed, and pull-triggered sandbox lifecycle so the daemon can bring up and tear down sandboxes without a reverse-WebSocket push. The optional final task block adds the HITL pause/resume surface (labelled clearly; may ship as its own phase).

**Architecture:** Phase A landed the ingest endpoint (`POST /links/runs/:runId/stream`). Phase B will land the work long-poll (`GET /links/work`) and the DBOS gate change. This phase lands the **third outbound connection the daemon holds**: the control long-poll. The long-poll serves frames from a per-user NATS subject (`links.control.<userSub>`) for immediacy, but every durable-correctness invariant (cancel, fence) lives in Postgres only — a daemon that misses a control frame is still backstopped by the ingest `409`. The existing `POST /cancel` route is augmented (not replaced): it now also sets `threads.cancel_requested_at`; the ingest checks it on every append. Nothing in the ws/v1 path changes — the new column is ignored by existing code paths, and `link_transport = 'pull'` gating ensures that only pull-transport, v2-thread runs ever use the control long-poll.

**Tech Stack:** Bun, TypeScript, Hono, Kysely (Postgres), NATS (pub/sub for immediacy; not a correctness boundary), `bun test` (unit), Playwright (e2e).

**Spec:** [`local-link-pull-inversion-spec.md`](local-link-pull-inversion-spec.md) §3.6, §3.7 (Phase C row in §7). Invariants: `L2`, `L12`, `L13`, `L14`.

**Testing conventions (from `TESTING.md`):** two tiers only. **Unit (`bun test`, co-located `*.test.ts`)** = pure logic, no DB/NATS/HTTP. **E2E (Playwright, `apps/mesh/e2e/tests/`)** = anything touching Postgres/NATS/HTTP/the real server. This plan puts the control-frame Zod schema, the cancel-flag predicate, and the frame-queue logic in unit tests; the migration, the storage read, the live endpoint, and the ingest `409` in e2e.

**Execution note:** Implement on an isolated worktree/branch (see `superpowers:using-git-worktrees`). Run `bun run fmt` before every commit (lefthook enforces it).

---

## Open design decisions (resolve before coding)

The grounding identified three risky unknowns. All three are resolved here; do not re-open them.

**Risk #1: Approval resumption state — blocking vs. new-turn.**
Decision: HITL is out of scope for Tasks 1–5 (the core of this phase). It is isolated in the optional **Task 6** block and explicitly flagged as a net-new feature. If Task 6 ships, the harness does NOT block in-flight — instead it emits a `{type:"requires_action"}` part, marks a daemon-local `Map<runId, ResumeFn>` entry, and the control-poll frame `{type:"approval"}` calls `resumeFn`. Pod/daemon death loses the pending decision (the turn fails and the user retries). That volatility is documented and accepted for v1 HITL.

**Risk #2: Cancel flag clearing — fence-token-driven, not ingest-driven.**
Decision: `threads.cancel_requested_at` is cleared **only** by `prepareRun` when a new fence token is minted for a fresh turn (Phase B). The ingest (the `POST /links/runs/:runId/stream` endpoint) NEVER clears it. A new turn boundary (new fence) is the only thing that resets the cancel flag. This means: cancel is final for the current run; the user's next message (which triggers `prepareRun` → new fence) is when the flag resets. This is belt-and-suspenders: even if the daemon sends a late append after cancel, the ingest rejects it with `409`.

**Risk #3: Sandbox lifecycle — work item carries config; daemon calls `ensureSandbox` eagerly.**
Decision: The **work item** (produced by Phase B's `prepareRun`) includes `sandboxHandle`, `repo`, and `workload` when a sandbox is needed. The daemon calls `provider.ensureSandbox()` **eagerly** as soon as it pulls a work item naming a sandbox, before running the harness. The control-frame `{type:"ensure_sandbox"}` is for **out-of-band** lifecycle only (preview spin-up outside a turn, explicit pre-warm), and MUST carry the same fields. A duplicate `ensure_sandbox` call for an already-live handle is safe — `ensureSandbox` is idempotent (returns the cached entry). The cluster MUST NOT send both a work item naming a sandbox AND a separate `ensure_sandbox` control frame for the same handle in the same turn — that would be a double-spawn bug. The work item is the canonical bring-up trigger.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `apps/mesh/migrations/100-cancel-requested-at.ts` | Add `threads.cancel_requested_at` (nullable timestamp). | **New** |
| `apps/mesh/src/storage/types.ts` | Add `cancel_requested_at` to `ThreadTable`. | Modify |
| `apps/mesh/src/storage/threads.ts` | Add `setCancelRequested` / `getCancelRequested` / `clearCancelRequested` storage methods; also add `cancel_requested_at` to `threadFromDbRow`. | Modify |
| `apps/mesh/src/storage/cancel-flag.ts` | Pure: `isCancelRequested(cancelRequestedAt: Date | null): boolean`. | **New** |
| `apps/mesh/src/storage/cancel-flag.test.ts` | Unit tests for `isCancelRequested`. | **New** |
| `apps/mesh/src/api/routes/decopilot/routes.ts` | Augment the existing `POST /:org/decopilot/cancel/:threadId` to also set `cancel_requested_at` and publish a NATS control frame. | Modify |
| `apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts` | Add `cancel_requested_at` check → `409 Cancelled` before the fence check. | Modify |
| `apps/mesh/src/api/routes/decopilot/control-frames.ts` | Zod schema for `ControlFrame` union; `encodeControlFrame` / `decodeControlFrame` helpers. | **New** |
| `apps/mesh/src/api/routes/decopilot/control-frames.test.ts` | Unit tests: round-trip encode/decode for every frame variant. | **New** |
| `apps/mesh/src/api/routes/decopilot/link-control-routes.ts` | `GET /links/control`: long-poll that drains per-user NATS control subject, returns oldest frame or `204`. | **New** |
| `apps/mesh/src/api/routes/org-scoped.ts` | Mount the control-poll router. | Modify |
| `apps/mesh/e2e/tests/link-control.spec.ts` | E2E: cancel sets flag + ingest `409`s; control poll returns cancel frame; ensure_sandbox frame shape. | **New** |

---

## Task 1: `cancel_requested_at` column, type, pure predicate, and storage methods

The durable cancel flag lives on `threads` as a nullable timestamp. A non-null value means the current run was cancelled; the ingest checks it before the fence check so even a valid fence token doesn't let a cancelled run append. The flag is cleared only by `prepareRun` (Phase B) when a new fence is minted.

**Files:**
- Create: `apps/mesh/migrations/100-cancel-requested-at.ts`
- Modify: `apps/mesh/src/storage/types.ts`
- Create: `apps/mesh/src/storage/cancel-flag.ts`, `apps/mesh/src/storage/cancel-flag.test.ts`
- Modify: `apps/mesh/src/storage/threads.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/mesh/src/storage/cancel-flag.test.ts
import { describe, expect, it } from "bun:test";
import { isCancelRequested } from "./cancel-flag";

describe("isCancelRequested", () => {
  it("returns false when cancel_requested_at is null", () => {
    expect(isCancelRequested(null)).toBe(false);
  });
  it("returns true when cancel_requested_at is a Date", () => {
    expect(isCancelRequested(new Date())).toBe(true);
  });
  it("returns true when cancel_requested_at is a past Date", () => {
    expect(isCancelRequested(new Date("2000-01-01"))).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/storage/cancel-flag.test.ts`
Expected: FAIL — `Cannot find module './cancel-flag'`.

- [ ] **Step 3: Write the predicate**

```ts
// apps/mesh/src/storage/cancel-flag.ts
/**
 * Pure predicate for the durable cancel flag (spec §3.6).
 * `threads.cancel_requested_at` is set by `POST /cancel`; the ingest rejects
 * further appends while it is non-null. Cleared only by a new-turn boundary
 * in `prepareRun` (Phase B) when a fresh fence token is minted.
 */
export function isCancelRequested(
  cancelRequestedAt: Date | null,
): boolean {
  return cancelRequestedAt !== null;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/storage/cancel-flag.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Write the migration**

```ts
// apps/mesh/migrations/100-cancel-requested-at.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("cancel_requested_at", "timestamptz")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .dropColumn("cancel_requested_at")
    .execute();
}
```

- [ ] **Step 6: Add the column to `ThreadTable` in `apps/mesh/src/storage/types.ts`**

In the `ThreadTable` interface (near `run_fence_token`, line ~878), add:

```ts
  /**
   * Set by POST /cancel; non-null while the current run is cancelled.
   * Cleared by prepareRun (Phase B) when a new fence token is minted.
   * The ingest rejects appends whenever this is non-null (spec §3.6, L13).
   */
  cancel_requested_at: ColumnType<Date | null, Date | string | null, Date | string | null>;
```

- [ ] **Step 7: Add storage read/write methods in `apps/mesh/src/storage/threads.ts`**

Add alongside the existing `getRunFence` / `setRunFence` methods (after line ~924):

```ts
  /** Mark the current run as cancel-requested (spec §3.6). */
  async setCancelRequested(threadId: string, organizationId: string): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ cancel_requested_at: new Date().toISOString() })
      .where("id", "=", threadId)
      .where("organization_id", "=", organizationId)
      .execute();
  }

  /** Read the cancel flag. Returns null when not set. */
  async getCancelRequestedAt(threadId: string): Promise<Date | null> {
    const row = await this.db
      .selectFrom("threads")
      .select("cancel_requested_at")
      .where("id", "=", threadId)
      .executeTakeFirst();
    if (!row) return null;
    const v = row.cancel_requested_at;
    if (v == null) return null;
    return v instanceof Date ? v : new Date(v as string);
  }

  /** Clear the cancel flag at a new turn boundary (called by prepareRun in Phase B). */
  async clearCancelRequested(threadId: string, organizationId: string): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ cancel_requested_at: null })
      .where("id", "=", threadId)
      .where("organization_id", "=", organizationId)
      .execute();
  }
```

Also add `cancel_requested_at` to the `threadFromDbRow` private helper's select columns and the returned `Thread` shape. Check the `threadFromDbRow` signature (around line ~930 in threads.ts) and add `cancel_requested_at` to the `select([...])` call in `get`, `list`, and any other query that reads the full `Thread` row; add it to the `Thread` interface in `types.ts` as `cancel_requested_at: Date | null` (runtime domain object).

- [ ] **Step 8: Typecheck and run the migration**

Run: `bun run --cwd=apps/mesh check && bun run --cwd=apps/mesh migrate`
Expected: type-check passes; migration `100-cancel-requested-at` applies cleanly.

- [ ] **Step 9: Format and commit**

```bash
bun run fmt
git add apps/mesh/migrations/100-cancel-requested-at.ts apps/mesh/src/storage/types.ts apps/mesh/src/storage/cancel-flag.ts apps/mesh/src/storage/cancel-flag.test.ts apps/mesh/src/storage/threads.ts
git commit -m "feat(storage): add cancel_requested_at column, isCancelRequested predicate, and accessors"
```

---

## Task 2: Control-frame schema

A single Zod schema defines every frame type the control long-poll can return. The daemon will decode these frames to decide what to do. Pure logic — no DB or NATS, unit-testable as a round-trip.

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/control-frames.ts`
- Test: `apps/mesh/src/api/routes/decopilot/control-frames.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/mesh/src/api/routes/decopilot/control-frames.test.ts
import { describe, expect, it } from "bun:test";
import {
  controlFrameSchema,
  encodeControlFrame,
  decodeControlFrame,
  type ControlFrame,
} from "./control-frames";

describe("controlFrameSchema", () => {
  const cases: ControlFrame[] = [
    { type: "cancel", runId: "run-1" },
    { type: "keep_alive" },
    {
      type: "ensure_sandbox",
      handle: "handle-abc",
      repo: { owner: "acme", name: "site", branch: "main" },
      workload: { kind: "decopilot", agentId: "agent-1" },
    },
    { type: "ensure_sandbox", handle: "handle-xyz" },
    { type: "delete_sandbox", handle: "handle-abc" },
    {
      type: "approval",
      runId: "run-2",
      decision: "approve",
      tool: "bash",
    },
    { type: "approval", runId: "run-3", decision: "reject" },
  ];

  for (const frame of cases) {
    it(`round-trips ${frame.type}${frame.type === "approval" ? `/${(frame as { decision: string }).decision}` : ""}`, () => {
      const encoded = encodeControlFrame(frame);
      const decoded = decodeControlFrame(encoded);
      expect(decoded).toEqual(frame);
    });
  }

  it("throws on unknown type", () => {
    expect(() => decodeControlFrame('{"type":"bogus"}')).toThrow();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/api/routes/decopilot/control-frames.test.ts`
Expected: FAIL — `Cannot find module './control-frames'`.

- [ ] **Step 3: Write the schema and helpers**

```ts
// apps/mesh/src/api/routes/decopilot/control-frames.ts
/**
 * Control-frame schema for the `GET /api/:org/links/control` long-poll.
 *
 * The daemon holds this poll continuously; the cluster pushes frames for:
 *   - cancel: abort the active run (belt-and-suspenders atop the durable flag)
 *   - keep_alive: heartbeat so the connection stays open past proxy timeouts
 *   - ensure_sandbox: bring up a sandbox out-of-band (e.g. preview pre-warm)
 *   - delete_sandbox: tear down a sandbox out-of-band
 *   - approval: HITL decision (approve|reject) for a paused tool call [Task 6]
 *
 * All frames are JSON objects; the long-poll endpoint encodes them as
 * `application/json` (one object per response for the current design; a later
 * upgrade can batch them as a JSONL stream).
 *
 * Spec: local-link-pull-inversion-spec.md §3.6, §3.7.
 */
import { z } from "zod";

const repoRefSchema = z.object({
  owner: z.string(),
  name: z.string(),
  branch: z.string().optional(),
});

const workloadSchema = z.object({
  kind: z.string(),
  agentId: z.string().optional(),
}).passthrough();

export const controlFrameSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("cancel"), runId: z.string() }),
  z.object({ type: z.literal("keep_alive") }),
  z.object({
    type: z.literal("ensure_sandbox"),
    handle: z.string(),
    repo: repoRefSchema.optional(),
    workload: workloadSchema.optional(),
  }),
  z.object({ type: z.literal("delete_sandbox"), handle: z.string() }),
  z.object({
    type: z.literal("approval"),
    runId: z.string(),
    decision: z.enum(["approve", "reject"]),
    tool: z.string().optional(),
  }),
]);

export type ControlFrame = z.infer<typeof controlFrameSchema>;

export function encodeControlFrame(frame: ControlFrame): string {
  return JSON.stringify(frame);
}

export function decodeControlFrame(raw: string): ControlFrame {
  return controlFrameSchema.parse(JSON.parse(raw));
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/api/routes/decopilot/control-frames.test.ts`
Expected: PASS (9 tests — 7 round-trips + 1 unknown-type throw).

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/control-frames.ts apps/mesh/src/api/routes/decopilot/control-frames.test.ts
git commit -m "feat(links): add ControlFrame Zod schema and encode/decode helpers"
```

---

## Task 3: Augment `POST /cancel` to set the durable flag and publish a NATS control frame

Today `POST /:org/decopilot/cancel/:threadId` (routes.ts:684) sets in-memory state and broadcasts via NATS `links.cancel.<userSub>`. This task adds two things in the same handler:

1. **Before** the runRegistry call: `setCancelRequested(taskId, organization.id)` to set the durable Postgres flag.
2. **After** the in-memory cancel attempt: publish a `{type:"cancel", runId: taskId}` frame on the per-user **control subject** (`links.control.<userSub>`) so the daemon's held control poll returns immediately. The existing `cancelBroadcast.broadcast(taskId)` is preserved as-is (it wakes any in-cluster pod that holds the run in `RunRegistry.states`).

The NATS control subject is **not** the same as today's `links.cancel.<userSub>` subject. The control poll uses `links.control.<userSub>` (new, Phase C). The old `links.cancel.<userSub>` is kept alive in this task (the gateway still consumes it for ws-transport runs); it will be deleted only in Phase F once all traffic has a pull home.

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/routes.ts`

- [ ] **Step 1: Verify the current cancel route signature**

Read `apps/mesh/src/api/routes/decopilot/routes.ts` lines 680–726 (already done above). Confirm that:
- `validateThreadOwnership(c)` returns `{ taskId, thread, organization }`.
- `cancelBroadcast` and the NATS connection are already in scope via closure from `createDecopilotRoutes(deps)` parameters.

- [ ] **Step 2: Locate the NATS dep injection point in `createDecopilotRoutes`**

Grep the function signature of `createDecopilotRoutes` and the `DecopilotDeps` interface for where NATS is injected. If NATS is not yet in `DecopilotDeps`, add it (a `nats: NatsConnection` field). The existing `cancelBroadcast` already uses NATS internally — check if its `broadcast` method exposes the publish or if a direct `nats` dep is needed for publishing to the new subject.

```bash
grep -n "DecopilotDeps\|createDecopilotRoutes\|nats:" apps/mesh/src/api/routes/decopilot/routes.ts | head -30
```

Expected: `DecopilotDeps` has `cancelBroadcast: CancelBroadcast`, `runRegistry: RunRegistry`, `streamBuffer: StreamBuffer`, `linkClaimRegistry: LinkClaimRegistry`. If `nats` is absent, add it; if `cancelBroadcast` already wraps a nats connection, prefer accessing nats through a new method on `CancelBroadcast` (e.g. `cancelBroadcast.publishControlFrame(userSub, frame)`).

- [ ] **Step 3: Add a `publishControlFrame(userSub, frame)` method to `CancelBroadcast`**

Locate `apps/mesh/src/api/routes/decopilot/cancel-broadcast.ts`. Add a new method that publishes a JSON-encoded `ControlFrame` to `links.control.<userSub>`:

```ts
// in cancel-broadcast.ts — add alongside the existing `broadcast` method:
publishControlFrame(userSub: string, frame: ControlFrame): void {
  const subject = `links.control.${userSub}`;
  this.nats.publish(subject, new TextEncoder().encode(JSON.stringify(frame)));
}
```

Import `type ControlFrame` from `"./control-frames"`. Confirm the existing `CancelBroadcast` class has access to `this.nats` — if not, thread it through the constructor. Add a matching unit test stub if the file has an existing test file.

- [ ] **Step 4: Modify the cancel route in `routes.ts`**

In the handler for `app.post(":org/decopilot/cancel/:threadId", ...)` (line ~684), add the following **immediately after** `const { taskId, thread, organization } = await validateThreadOwnership(c);`:

```ts
    // Set the durable cancel flag so the ingest 409s any further appends
    // regardless of whether the control-poll frame is delivered (spec L13).
    await ctx.storage.threads.setCancelRequested(taskId, organization.id);
```

Add `const ctx = c.get("meshContext");` if not already in scope (check existing helper usage — `validateThreadOwnership` already resolves ctx internally but the handler may not have it in scope directly).

Then, after `cancelBroadcast.broadcast(taskId);` (line ~697), add:

```ts
    // Publish a control frame so the daemon's held control long-poll returns
    // immediately with {type:"cancel"} without waiting for the next poll cycle.
    // This is the "promptly delivered" half of the belt-and-suspenders (spec §3.6).
    // The userSub for the control subject is the thread's owner's user ID.
    cancelBroadcast.publishControlFrame(thread.created_by, {
      type: "cancel",
      runId: taskId,
    });
```

The `thread.created_by` field is the owner's user ID, which matches the `userSub` the daemon's control poll is keyed on (same as the work-poll subject in Phase B).

- [ ] **Step 5: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. If `cancel_requested_at` requires the Thread domain type to be updated, do so now (see Task 1 Step 7 note about adding to Thread interface and threadFromDbRow).

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/routes.ts apps/mesh/src/api/routes/decopilot/cancel-broadcast.ts
git commit -m "feat(links): POST /cancel now sets durable cancel_requested_at flag and publishes control frame"
```

---

## Task 4: Ingest `409 Cancelled` check

The ingest endpoint (`POST /links/runs/:runId/stream`, `link-ingest-routes.ts`) must reject further appends whenever `cancel_requested_at` is set — belt-and-suspenders against a daemon that missed the control frame. This check runs **before** the fence check so cancel is final even with a valid fence.

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts`

- [ ] **Step 1: Read the current ingest route**

Read `apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts` (already done above). Confirm auth and fence-check positions.

- [ ] **Step 2: Add the cancel check**

In `link-ingest-routes.ts`, after the `getRunFence` check and before the fence `fenceMatches` call, add the cancel check. The updated guard block becomes:

```ts
    const cancelRequestedAt = await ctx.storage.threads.getCancelRequestedAt(runId);
    if (isCancelRequested(cancelRequestedAt)) {
      return c.json({ error: "cancelled" }, 409);
    }

    const current = await ctx.storage.threads.getRunFence(runId);
    if (current === null) {
      return c.json({ error: "no active run fence" }, 409);
    }
    if (!fenceMatches(current, presented)) {
      return c.json({ error: "fenced" }, 409);
    }
```

Add the import at the top of `link-ingest-routes.ts`:

```ts
import { isCancelRequested } from "@/storage/cancel-flag";
```

The two Postgres reads (`getCancelRequestedAt` + `getRunFence`) could be batched into a single query if performance matters, but keep them separate for clarity in Phase C; the combined read is a straightforward optimisation in Phase D or later.

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/link-ingest-routes.ts
git commit -m "feat(links): ingest 409-on-cancel — reject appends when cancel_requested_at is set"
```

---

## Task 5: `GET /api/:org/links/control` long-poll route + e2e

The control long-poll is served by a **stateless, fungible** pod (invariant `L2`). Any pod can serve any user's poll because the control channel is keyed by the user's ID, which is derived from the authenticated principal — no per-user affinity. The implementation:

1. Authenticates the principal (`ctx.auth?.user?.id`).
2. Subscribes to `links.control.<userId>` on the shared NATS connection (one-shot: unsubscribes after one message or `LONG_POLL_TIMEOUT_MS`).
3. If a message arrives in time: decodes the frame and returns `200 application/json` with the frame.
4. If the timeout fires: returns `204 No Content` → the daemon repolls.

The subscription is ephemeral (NATS core pub/sub, not JetStream) — frames in flight when no daemon is polling are dropped. That is acceptable: the durable cancel flag (`cancel_requested_at`) is the correctness backstop; the control frame is the prompt-delivery optimisation.

**Files:**
- Create: `apps/mesh/src/api/routes/decopilot/link-control-routes.ts`
- Modify: `apps/mesh/src/api/routes/org-scoped.ts`
- Test: `apps/mesh/e2e/tests/link-control.spec.ts`

- [ ] **Step 1: Write the route**

```ts
// apps/mesh/src/api/routes/decopilot/link-control-routes.ts
/**
 * Control long-poll — `GET /api/:org/links/control`.
 *
 * The daemon holds this connection continuously. The cluster delivers cancel,
 * HITL-approval, and sandbox-lifecycle frames via NATS `links.control.<userId>`.
 * Stateless: any pod serves any user's poll (spec L2). Correctness does not
 * depend on delivery — the durable cancel flag (threads.cancel_requested_at)
 * backstops every cancel regardless of whether this poll is held (spec L13).
 *
 * Returns:
 *   200 application/json — one ControlFrame JSON object
 *   204 No Content       — timeout; daemon should repoll immediately
 *   401 Unauthorized     — no authenticated principal
 *
 * Spec: local-link-pull-inversion-spec.md §3.6.
 */
import { Hono } from "hono";
import type { NatsConnection } from "nats";
import { decodeControlFrame, type ControlFrame } from "./control-frames";
import type { Env } from "../../hono-env";

/** Hold the poll open for up to 28 s; most proxies time out at 30 s. */
const LONG_POLL_TIMEOUT_MS = 28_000;

export interface LinkControlDeps {
  nats: NatsConnection;
}

export function createLinkControlRoutes(deps: LinkControlDeps) {
  const app = new Hono<Env>();

  app.get("/links/control", async (c) => {
    const ctx = c.get("meshContext");
    const userId = ctx.auth?.user?.id;
    if (!userId) return c.json({ error: "unauthorized" }, 401);

    const subject = `links.control.${userId}`;
    const decoder = new TextDecoder();

    const frame = await new Promise<ControlFrame | null>((resolve) => {
      const timer = setTimeout(() => {
        sub.unsubscribe();
        resolve(null);
      }, LONG_POLL_TIMEOUT_MS);

      const sub = deps.nats.subscribe(subject, { max: 1 });
      (async () => {
        for await (const msg of sub) {
          clearTimeout(timer);
          try {
            const parsed = decodeControlFrame(decoder.decode(msg.data));
            resolve(parsed);
          } catch {
            // Malformed frame — treat as keep_alive miss, let timeout fire.
            // The subscription already consumed the message (max:1), so
            // fall through to the timeout-path resolve(null).
            resolve(null);
          }
          break;
        }
      })().catch(() => {
        clearTimeout(timer);
        resolve(null);
      });
    });

    if (frame === null) {
      return new Response(null, { status: 204 });
    }
    return c.json(frame);
  });

  return app;
}
```

- [ ] **Step 2: Locate the NATS connection available to org-scoped routes**

The NATS connection is injected into `createDecopilotRoutes` today via `deps`. Check `apps/mesh/src/api/app.ts` (or wherever `createOrgScopedApi` is called) to confirm the NATS connection is in scope and can be threaded into `createLinkControlRoutes({ nats })`.

```bash
grep -n "createOrgScopedApi\|nats\|NatsConnection" apps/mesh/src/api/app.ts | head -30
```

Add `nats: NatsConnection` to `OrgScopedDeps` in `org-scoped.ts` if it is not already there. Thread the injected NATS connection through.

- [ ] **Step 3: Mount the control router in `org-scoped.ts`**

In `apps/mesh/src/api/routes/org-scoped.ts`, add to `OrgScopedDeps`:

```ts
  nats: NatsConnection;
```

Add the import:

```ts
import { createLinkControlRoutes } from "./decopilot/link-control-routes";
import type { NatsConnection } from "nats";
```

Mount alongside the ingest route:

```ts
  app.route("/", createLinkControlRoutes({ nats: deps.nats })); // GET /api/:org/links/control
```

Update the call site in `app.ts` to pass `nats` to `createOrgScopedApi(...)`.

- [ ] **Step 4: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 5: Write the e2e test**

```ts
// apps/mesh/e2e/tests/link-control.spec.ts
import { expect, test } from "@playwright/test";
import { createOrgAndUser, seedV2Thread } from "../helpers";

// ---- helper: hit the control long-poll with a very short timeout ----
// We use a custom fetch with a short timeout so the test doesn't block 28 s.
// The Playwright request fixture doesn't support per-call timeouts; use
// node fetch with AbortController instead.
async function pollControl(
  baseURL: string,
  orgSlug: string,
  bearer: string,
  timeoutMs = 500,
): Promise<{ status: number; body: unknown }> {
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseURL}/api/${orgSlug}/links/control`, {
      headers: { Authorization: `Bearer ${bearer}` },
      signal: ac.signal,
    });
    clearTimeout(timer);
    if (res.status === 204) return { status: 204, body: null };
    return { status: res.status, body: await res.json() };
  } catch {
    clearTimeout(timer);
    return { status: 204, body: null }; // aborted = timeout = 204 equivalent
  }
}

test("control poll returns 401 for unauthenticated request", async ({
  request,
}) => {
  const { org } = await createOrgAndUser();
  const res = await request.get(`/api/${org.slug}/links/control`);
  expect(res.status()).toBe(401);
});

test("cancel sets cancel_requested_at and ingest 409s further appends", async ({
  request,
  baseURL,
}) => {
  const { org, bearer } = await createOrgAndUser();
  const threadId = await seedV2Thread(org.id, { runFenceToken: "tok-c1" });

  // Cancel the run
  const cancelRes = await request.post(
    `/api/${org.slug}/decopilot/cancel/${threadId}`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  );
  // Accept 200 or 202 — either means the cancel was recorded
  expect([200, 202]).toContain(cancelRes.status());

  // Now a fresh append with a valid fence must 409 because cancel_requested_at is set
  const { sseBody } = await import("../helpers");
  const ingestRes = await request.post(
    `/api/${org.slug}/links/runs/${threadId}/stream`,
    {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "x-fence-token": "tok-c1",
      },
      data: sseBody([{ type: "done" }]),
    },
  );
  expect(ingestRes.status()).toBe(409);
  const body = await ingestRes.json();
  expect(body.error).toBe("cancelled");
});

test("control poll returns 204 when no frames are pending", async ({
  baseURL,
}) => {
  const { org, bearer } = await createOrgAndUser();
  const result = await pollControl(baseURL!, org.slug, bearer, 500);
  // Either 204 (timeout) or abort — both are acceptable; the point is not 500/401.
  expect([204, 200]).toContain(result.status);
});
```

- [ ] **Step 6: Run the e2e tests**

Run: `bun run --cwd=apps/mesh test:e2e link-control` (or the Playwright invocation for this repo).
Expected: all three tests pass.

- [ ] **Step 7: Full check + lint + format + commit**

```bash
bun run --cwd=apps/mesh check && bun run lint && bun run fmt:check
bun run fmt
git add apps/mesh/src/api/routes/decopilot/link-control-routes.ts apps/mesh/src/api/routes/org-scoped.ts apps/mesh/e2e/tests/link-control.spec.ts
git commit -m "feat(links): add GET /api/:org/links/control long-poll for cancel/HITL/lifecycle frames"
```

---

## Task 6 — OPTIONAL/LAST: HITL pause/resume

> **HITL approval — net-new feature, larger; may be split into its own phase.**
>
> This task block introduces true in-flight pause/resume of the harness at a tool-call boundary. It is **optional for Phase C** — the plan is shippable without it. The existing `toolApprovalLevel` filter (assembly-time static block) is **not changed** by this task; it coexists. If this task is split out, it ships as Phase C.5 or Phase D.5.

All daemon-side files in this task are marked **⚠️ SHIPPED DAEMON — needs human review before merge** because they modify the `deco link` daemon binary in `packages/sandbox/`.

**Scope:**
- A harness emits a `{type:"requires_action", tool, args}` UI part when it wants approval.
- The cluster writes the part to `thread_message_parts` (via the normal ingest path).
- The browser renders an approval UI; the user approves or rejects.
- The browser POST triggers a `{type:"approval", runId, decision, tool}` control frame to be published on `links.control.<userId>`.
- The daemon's control poll receives the frame and unblocks the harness.

**Files:**
- `apps/mesh/src/api/routes/decopilot/routes.ts` — add `POST /api/:org/links/runs/:runId/approval` that publishes the approval control frame (cluster-side; browser calls this).
- `packages/sandbox/daemon/routes/control-poll.ts` (**⚠️ SHIPPED DAEMON**) — new file: daemon-side control-poll loop that reads from `GET /api/:org/links/control`, decodes frames, and dispatches to local handlers.
- `packages/sandbox/daemon/hitl.ts` (**⚠️ SHIPPED DAEMON**) — module-scoped `Map<runId, (decision: "approve"|"reject") => void>` that the harness `await`s before invoking a tool; the control-poll loop calls `resumeHITL(runId, decision)` on receipt of an `approval` frame.

**Task 6 is intentionally not fully expanded here.** Before implementing, the team must decide:
1. Whether the harness-side pause is implemented as an async gate (`await waitForApproval(runId, tool)`) or as a new harness turn (the turn ends with `requires_action`; a new turn continues after approval).
2. The browser-side approval UI shape (which is out of scope for this backend plan).
3. Acceptable failure mode when the daemon restarts mid-approval (documented accepted risk: the turn fails; the user re-invokes).

Implement Task 6 only after Tasks 1–5 are merged, green on CI, and the above decisions are locked in a separate design doc. Tag the daemon-side PR with **⚠️ SHIPPED DAEMON — needs human review before merge**.

---

## Done criteria

- [ ] `threads.cancel_requested_at` column exists (migration `100` applied); `isCancelRequested` predicate passes all unit tests.
- [ ] `ControlFrame` schema round-trips all 5 frame types in unit tests.
- [ ] `POST /:org/decopilot/cancel/:threadId` sets `cancel_requested_at` in Postgres and publishes `{type:"cancel"}` to `links.control.<userId>`.
- [ ] `POST /api/:org/links/runs/:runId/stream` returns `409 {"error":"cancelled"}` when `cancel_requested_at` is set, regardless of fence token validity.
- [ ] `GET /api/:org/links/control` returns `401` for unauthenticated callers, a `ControlFrame` JSON object when a frame is in-flight, and `204` on timeout.
- [ ] All new unit tests pass (`bun test`); the three e2e tests in `link-control.spec.ts` pass.
- [ ] `bun run check` and `bun run lint` are green on this branch.
- [ ] No existing behavior is changed for `link_transport = 'ws'` threads; only pull/v2 runs are affected by the new cancel guard (the ingest endpoint is only reachable via the pull path in normal operation).

**Next:** Phase D — cut `codex`/`claude-code` off `remoteDispatch`-over-WS onto the pull transport (flip `link_transport` per-user canary; delete the NATS middle-man for these harnesses). Separate plan.
