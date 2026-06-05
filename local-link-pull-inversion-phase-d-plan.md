# Local-Link Pull Inversion — Phase D (Cut Codex/Claude-Code to Pull Transport) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Flip the `codex` and `claude-code` harnesses off `remoteDispatch`-over-WS onto the pull transport without any harness-code changes. The cluster dispatch path branches on a per-thread `link_transport` column and publishes a work item to the Phase-B JetStream WorkQueue instead of calling `remoteDispatch`. The daemon's link-daemon layer is replaced with a pull loop that long-polls for work items, calls the local sandbox `/dispatch`, and streams the SSE result to the Phase-A ingest endpoint. A canary env var (`LINK_PULL_TRANSPORT_PERCENT`) gates the flip; `pull ⊆ v2` is enforced at every decision point. The existing WS/v1 path stays byte-for-byte unchanged as the default.

**Architecture:**
- `resolveDispatchTarget` gains a `linkTransport` output field. For `user-desktop` + v2 + `link_transport = 'pull'` (or canary-selected), it returns `{ runsIn: "user-desktop", linkTransport: "pull", ... }`.
- `dispatch-run.ts` branches at the `target.runsIn === "user-desktop"` gate: when `target.linkTransport === "pull"`, it publishes the `HarnessStreamInput` wire shape (plus `runFenceToken`, minted by Phase B's `prepareRun`) to the JetStream WorkQueue (`link.work.<userSub>`) instead of calling `remoteDispatch`.
- The daemon's `cluster-connection.ts` is replaced with a pull-loop architecture: `holdWorkPoll()` (long-polls `GET /api/:org/links/work`, parses the work item) and `holdControlPoll()` (long-polls `GET /api/:org/links/control`) run in parallel. `holdWorkPoll` hands each item to a new `handleLocalDispatch()` in `control-handler.ts`, which calls the loopback sandbox `/dispatch` and POST-streams the SSE result to `POST /api/:org/links/runs/:runId/stream` with `x-fence-token`.
- All daemon-touching tasks carry "⚠️ SHIPPED DAEMON" banners (see below).
- The WS `connectToCluster` function stays in place (for the ws transport). The pull loop is a parallel new entry point gated on `LINK_TRANSPORT_MODE=pull` in the daemon startup.

**Tech Stack:** Bun, TypeScript, Hono, Kysely (Postgres), JetStream (Phase B substrate), `bun test` (unit), Playwright (e2e). Daemon: `apps/mesh/src/link-daemon/` + `packages/sandbox/daemon/`.

**Spec:** [`local-link-pull-inversion-spec.md`](local-link-pull-inversion-spec.md) §3, §7 (Phase D row), §8 invariants `L2`, `L3`, `L4`, `L5`, `L12`, `L13`.

**Testing conventions (from `TESTING.md`):** two tiers only. **Unit (`bun test`, co-located `*.test.ts`)** = pure logic, no DB/NATS/HTTP. **E2E (Playwright, `apps/mesh/e2e/tests/`)** = anything touching Postgres/NATS/HTTP. The canary bucketing logic, the transport-decision predicate, and the `harnessInput`-to-wire-shape conversion are unit-tested; the cluster dispatch branch, the ingest integration, and the full pull round-trip use e2e or the flagged integration-test caveat section below.

**Execution note:** Implement on an isolated worktree/branch (see `superpowers:using-git-worktrees`). Run `bun run fmt` before every commit (lefthook enforces it). **Phases A, B, and C MUST be merged first** — this phase calls the Phase-A ingest, the Phase-B WorkQueue publish API, and the Phase-C control-poll endpoint.

---

## Open design decisions (resolve before coding)

### Risk 1 — Fence token flow to the daemon  RESOLVED
**Decision:** Include `runFenceToken` in the work item payload (added to `HarnessStreamInputWire` in `apps/mesh/src/links/protocol/schemas.ts` and to `HarnessStreamInput` in `apps/mesh/src/harnesses/types.ts`). Phase B's `prepareRun` mints the token and includes it when constructing the work-item body. The daemon reads it from the parsed work item and includes it as `x-fence-token` on `POST /api/:org/links/runs/:runId/stream`. No new endpoint needed.

### Risk 2 — Workdir lock / tool idempotency on desktop re-run  RESOLVED (scope)
**Decision:** Out of Phase D scope per spec §6. Phase D ships with a comment in `handleLocalDispatch` noting the absence of the workdir lock and referencing the spec's "required follow-up" note. Production readiness requires Phase D + the workdir-lock follow-up before 100% rollout.

### Risk 3 — Control-poll delivery on cancel  RESOLVED (dependency)
**Decision:** Phase D ships with `cancel = durable-only, immediate-frame delivery depends on Phase C`. The ingest `409`s further appends on a cancelled run (Phase A fence), so cancel is always correct. If Phase C is deployed, the control long-poll provides prompt delivery — both work; Phase C is a prerequisite for the best cancel UX but not for correctness.

### pull ⊆ v2 gate placement  RESOLVED
**Decision:** The gate is enforced in two places: (a) `resolveDispatchTarget` refuses to return `linkTransport: 'pull'` unless `messageStorageVersion === 2`; (b) the `shouldUsePullTransport` predicate also checks `messageStorageVersion`. No v1 thread ever sees the pull path.

### Canary bucketing strategy  RESOLVED
**Decision:** Same FNV-1a bucketing pattern as `v2-canary.ts`, seeded on `threadId`. `LINK_PULL_TRANSPORT_PERCENT` (0–100, default 0) controls rollout. `LINK_TRANSPORT_MODE=pull` overrides to 100% for ops use. Both env vars read at decision time (not module-init time) for hot-rollout compatibility.

---

## File Structure

| File | Responsibility | New/Modify |
|---|---|---|
| `apps/mesh/migrations/100-link-transport.ts` | Add `threads.link_transport` column (`text`, nullable). | **New** |
| `apps/mesh/src/storage/types.ts` | Add `link_transport` to the `threads` table type. | Modify |
| `apps/mesh/src/storage/threads.ts` | Add `setLinkTransport` storage method. | Modify |
| `apps/mesh/src/links/pull-transport-canary.ts` | `shouldUsePullTransport(threadId, storageVersion, linkTransport, percent)` + `parsePullPercent`. | **New** |
| `apps/mesh/src/links/pull-transport-canary.test.ts` | Unit tests for the canary predicate. | **New** |
| `apps/mesh/src/links/resolve-dispatch-target.ts` | Add `linkTransport` to `DispatchTarget`; add `messageStorageVersion` + `linkTransport` to `Input`; gate pull ⊆ v2. | Modify |
| `apps/mesh/src/links/resolve-dispatch-target.test.ts` | Unit tests for the transport-decision branch. | **New** |
| `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` | Branch at `target.runsIn === "user-desktop"` + `target.linkTransport === "pull"` → publish work item to WorkQueue instead of calling `remoteDispatch`. | Modify |
| `apps/mesh/src/links/protocol/schemas.ts` | Add `runFenceToken` (optional string) to `harnessStreamInputSchema`. | Modify |
| `apps/mesh/src/harnesses/types.ts` | Add `runFenceToken?: string` to `HarnessStreamInput`. | Modify |
| `apps/mesh/src/api/routes/decopilot/routes.ts` | At first-message site: pin `link_transport` in DB alongside `message_storage_version`. | Modify |
| `apps/mesh/src/link-daemon/work-poller.ts` ⚠️ | Long-poll `GET /api/:org/links/work`: fetch, parse, retry-on-204/error. | **New** |
| `apps/mesh/src/link-daemon/cluster-connection.ts` ⚠️ | Add `connectToClusterPull()` entry point (parallel pull+control loops); keep existing `connectToCluster()` for WS transport untouched. | Modify |
| `apps/mesh/src/link-daemon/control-handler.ts` ⚠️ | Add `handleLocalDispatch(workItem, baseUrl, getToken)`: loopback `/dispatch` → chunked POST to ingest with fence token. | Modify |
| `apps/mesh/src/link-daemon/index.ts` ⚠️ | Branch on `LINK_TRANSPORT_MODE=pull` to launch the pull loop vs. the WS loop. | Modify |
| `apps/mesh/e2e/tests/link-dispatch-pull.spec.ts` | E2E: stub daemon that pulls work + posts SSE to ingest; assert parts land. | **New** |

---

## Task 1: `link_transport` column and canary predicate

Add the DB column, type, and the pure bucketing predicate that decides whether a thread uses pull transport.

**Files:**
- Create: `apps/mesh/migrations/100-link-transport.ts`
- Modify: `apps/mesh/src/storage/types.ts`
- Modify: `apps/mesh/src/storage/threads.ts`
- Create: `apps/mesh/src/links/pull-transport-canary.ts`
- Create: `apps/mesh/src/links/pull-transport-canary.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/mesh/src/links/pull-transport-canary.test.ts
import { describe, expect, it } from "bun:test";
import {
  parsePullPercent,
  shouldUsePullTransport,
} from "./pull-transport-canary";

describe("parsePullPercent", () => {
  it("returns 0 for missing/invalid", () => {
    expect(parsePullPercent(undefined)).toBe(0);
    expect(parsePullPercent("")).toBe(0);
    expect(parsePullPercent("abc")).toBe(0);
    expect(parsePullPercent("-5")).toBe(0);
  });
  it("clamps at 100", () => {
    expect(parsePullPercent("150")).toBe(100);
  });
  it("parses integers in range", () => {
    expect(parsePullPercent("50")).toBe(50);
    expect(parsePullPercent("0")).toBe(0);
    expect(parsePullPercent("100")).toBe(100);
  });
});

describe("shouldUsePullTransport", () => {
  it("always returns false for v1 threads regardless of column or percent", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 1,
        linkTransport: "pull",
        percent: 100,
      }),
    ).toBe(false);
  });

  it("returns false when percent=0 and column is null", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 2,
        linkTransport: null,
        percent: 0,
      }),
    ).toBe(false);
  });

  it("returns true when column is explicitly 'pull' and v2", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 2,
        linkTransport: "pull",
        percent: 0,
      }),
    ).toBe(true);
  });

  it("returns false when column is 'ws' even if v2 and percent=100", () => {
    expect(
      shouldUsePullTransport({
        threadId: "t1",
        messageStorageVersion: 2,
        linkTransport: "ws",
        percent: 100,
      }),
    ).toBe(false);
  });

  it("is deterministic for the same threadId (no flipping)", () => {
    const id = "thread-abc-123";
    const a = shouldUsePullTransport({
      threadId: id,
      messageStorageVersion: 2,
      linkTransport: null,
      percent: 50,
    });
    const b = shouldUsePullTransport({
      threadId: id,
      messageStorageVersion: 2,
      linkTransport: null,
      percent: 50,
    });
    expect(a).toBe(b);
  });

  it("percent=100 selects all null-column v2 threads", () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      shouldUsePullTransport({
        threadId: `thread-${i}`,
        messageStorageVersion: 2,
        linkTransport: null,
        percent: 100,
      }),
    );
    expect(results.every(Boolean)).toBe(true);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/links/pull-transport-canary.test.ts`
Expected: FAIL — `Cannot find module './pull-transport-canary'`.

- [ ] **Step 3: Write the canary module**

```ts
// apps/mesh/src/links/pull-transport-canary.ts
/**
 * Pull-transport canary gate (spec §7 Phase D).
 *
 * Decides whether a thread should use the pull transport (daemon-pull +
 * ingest-post) rather than the default WS remoteDispatch path.
 *
 * INVARIANT (L12): pull ⊆ v2. A thread with message_storage_version < 2
 * MUST NOT be switched to pull regardless of the column or the env var.
 *
 * Bucketing algorithm is identical to v2-canary.ts (FNV-1a, mod 100) so
 * the two canaries advance independently without coupling.
 */

/** FNV-1a hash → 32-bit unsigned, mod 100. Same algorithm as v2-canary. */
function hashToBucket(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 100;
}

/** Parse `LINK_PULL_TRANSPORT_PERCENT` into a clamped integer. Missing/invalid → 0. */
export function parsePullPercent(raw: string | undefined): number {
  if (raw == null || raw === "") return 0;
  const n = Number.parseInt(raw, 10);
  if (Number.isNaN(n) || n < 0) return 0;
  if (n > 100) return 100;
  return n;
}

export interface ShouldUsePullInput {
  /** Thread id — bucketing seed. */
  threadId: string;
  /** Thread's `message_storage_version`. Pull requires v2 (value ≥ 2). */
  messageStorageVersion: number;
  /** Explicit column value. null = decide by canary; 'ws' = force WS; 'pull' = force pull. */
  linkTransport: "pull" | "ws" | null;
  /** Resolved canary percent (0–100). Typically from `parsePullPercent(env)`. */
  percent: number;
}

/**
 * Return true if this thread should use the pull transport.
 *
 * Pure function — no env reads, no DB. Call `parsePullPercent(env)` at the
 * call site and pass the result as `percent`.
 */
export function shouldUsePullTransport(input: ShouldUsePullInput): boolean {
  // L12: pull ⊆ v2 — hard gate, never bypassed.
  if (input.messageStorageVersion < 2) return false;

  // Explicit column overrides canary.
  if (input.linkTransport === "ws") return false;
  if (input.linkTransport === "pull") return true;

  // null: fall through to canary bucketing.
  if (input.percent <= 0) return false;
  if (input.percent >= 100) return true;
  return hashToBucket(input.threadId) < input.percent;
}

/**
 * Convenience wrapper that reads env vars directly. The pure `shouldUsePullTransport`
 * is what tests exercise; this is the call-site form.
 */
export function shouldUsePullTransportFromEnv(
  threadId: string,
  messageStorageVersion: number,
  linkTransport: "pull" | "ws" | null,
): boolean {
  // LINK_TRANSPORT_MODE=pull is an ops override that maps to 100%.
  const modeOverride = process.env.LINK_TRANSPORT_MODE;
  const percent =
    modeOverride === "pull"
      ? 100
      : parsePullPercent(process.env.LINK_PULL_TRANSPORT_PERCENT);
  return shouldUsePullTransport({
    threadId,
    messageStorageVersion,
    linkTransport,
    percent,
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/links/pull-transport-canary.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Write the migration**

```ts
// apps/mesh/migrations/100-link-transport.ts
import type { Kysely } from "kysely";

export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .alterTable("threads")
    .addColumn("link_transport", "text")
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.alterTable("threads").dropColumn("link_transport").execute();
}
```

- [ ] **Step 6: Add the column type**

In `apps/mesh/src/storage/types.ts`, in the threads table interface directly after the `run_fence_token` line (~line 878), add:

```ts
  /**
   * Per-thread transport pin: 'pull' | 'ws' | null.
   * null = resolve at dispatch time via LINK_PULL_TRANSPORT_PERCENT canary.
   * Set only when the thread is created (turn-boundary cutover only, per L12).
   */
  link_transport: ColumnType<
    "pull" | "ws" | null,
    "pull" | "ws" | undefined,
    "pull" | "ws"
  >;
```

- [ ] **Step 7: Add storage write method**

In `apps/mesh/src/storage/threads.ts`, add alongside `setRunFence`:

```ts
  /** Pin the transport for a thread. Only set at thread-creation time. */
  async setLinkTransport(
    threadId: string,
    transport: "pull" | "ws",
  ): Promise<void> {
    await this.db
      .updateTable("threads")
      .set({ link_transport: transport })
      .where("id", "=", threadId)
      .execute();
  }
```

- [ ] **Step 8: Typecheck and run migration**

Run: `bun run --cwd=apps/mesh check && bun run --cwd=apps/mesh migrate`
Expected: typecheck passes; migration `100-link-transport` applies cleanly.

- [ ] **Step 9: Format and commit**

```bash
bun run fmt
git add apps/mesh/migrations/100-link-transport.ts apps/mesh/src/storage/types.ts apps/mesh/src/storage/threads.ts apps/mesh/src/links/pull-transport-canary.ts apps/mesh/src/links/pull-transport-canary.test.ts
git commit -m "$(cat <<'EOF'
feat(links): add link_transport column + pull-transport canary predicate

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: `resolveDispatchTarget` transport branch

Extend `resolveDispatchTarget` to carry the transport decision and add unit tests for the new branch logic.

**Files:**
- Modify: `apps/mesh/src/links/resolve-dispatch-target.ts`
- Create: `apps/mesh/src/links/resolve-dispatch-target.test.ts`

- [ ] **Step 1: Write the failing unit test**

```ts
// apps/mesh/src/links/resolve-dispatch-target.test.ts
import { describe, expect, it } from "bun:test";
import {
  resolveDispatchTarget,
  type DispatchTarget,
} from "./resolve-dispatch-target";

// Minimal stub satisfying LinkClaimRegistry
const onlineClaim = {
  capabilities: ["claude-code" as const, "codex" as const],
  machineId: "m1",
  cliVersion: "1.0.0",
  previewPort: 4000,
};
const offlineClaim = null;

const registry = (claim: typeof onlineClaim | null) => ({
  get: async (_userId: string) => claim,
});

describe("resolveDispatchTarget — pull transport gate", () => {
  it("returns ws transport for v1 threads even when linkTransport='pull'", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "user-desktop",
        userId: "u1",
        messageStorageVersion: 1,
        linkTransport: "pull",
        pullPercent: 100,
      },
      { linkClaimRegistry: registry(onlineClaim) },
    );
    expect(result.ok).toBe(true);
    const t = (result as { ok: true; target: DispatchTarget }).target;
    expect(t.runsIn).toBe("user-desktop");
    expect(t.linkTransport).toBe("ws");
  });

  it("returns pull transport for v2 + linkTransport='pull'", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "codex",
        sandboxProviderKind: "user-desktop",
        userId: "u1",
        messageStorageVersion: 2,
        linkTransport: "pull",
        pullPercent: 0,
      },
      { linkClaimRegistry: registry(onlineClaim) },
    );
    expect(result.ok).toBe(true);
    const t = (result as { ok: true; target: DispatchTarget }).target;
    expect(t.linkTransport).toBe("pull");
  });

  it("returns ws transport for decopilot (cluster path, no link_transport field)", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "decopilot",
        sandboxProviderKind: "user-desktop",
        userId: "u1",
        messageStorageVersion: 2,
        linkTransport: null,
        pullPercent: 100,
      },
      { linkClaimRegistry: registry(onlineClaim) },
    );
    // decopilot still routes cluster even in v2 (Phase E not yet done)
    expect(result.ok).toBe(true);
    const t = (result as { ok: true; target: DispatchTarget }).target;
    expect(t.runsIn).toBe("cluster");
    // cluster targets do not have linkTransport
    expect((t as { linkTransport?: unknown }).linkTransport).toBeUndefined();
  });

  it("returns link_offline when link is absent regardless of transport", async () => {
    const result = await resolveDispatchTarget(
      {
        harnessId: "claude-code",
        sandboxProviderKind: "user-desktop",
        userId: "u1",
        messageStorageVersion: 2,
        linkTransport: "pull",
        pullPercent: 100,
      },
      { linkClaimRegistry: registry(offlineClaim) },
    );
    expect(result.ok).toBe(false);
    expect((result as { ok: false; error: { kind: string } }).error.kind).toBe(
      "user_desktop_link_offline",
    );
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/links/resolve-dispatch-target.test.ts`
Expected: FAIL — property `linkTransport` does not exist on `DispatchTarget`.

- [ ] **Step 3: Extend `resolveDispatchTarget`**

Replace the contents of `apps/mesh/src/links/resolve-dispatch-target.ts` with the following (the WS path and decopilot routing are preserved byte-for-byte; only the `user-desktop` non-decopilot branch gains a `linkTransport` field):

```ts
/**
 * Resolve where a dispatch should execute, from the harness and the sandbox
 * provider kind pinned for this (thread, virtualMcpId, branch).
 *
 * `sandboxProviderKind` is the single source of truth:
 *   - cloud kind (cluster) → cluster default sandbox
 *   - `user-desktop` + decopilot → cluster decopilot, sandbox tools tunneled
 *   - `user-desktop` + claude-code/codex → whole stream dispatched to the desktop
 *
 * When the desktop target is selected, `linkTransport` further controls the
 * channel: 'ws' (default, legacy remoteDispatch) or 'pull' (Phase D, gated
 * pull ⊆ v2 per L12). The pull path is selected when:
 *   - messageStorageVersion >= 2 (enforced as a hard gate)
 *   - linkTransport column is 'pull', OR
 *   - linkTransport is null AND the canary bucket selects this thread.
 *
 * Link health is checked only for `user-desktop`. Offline/missing-capability
 * paths surface a `{ ok: false, error }` result which `POST /messages`
 * translates to a 409 response.
 *
 * Takes the kind directly (not a `SandboxRecord`) so the POST handler can
 * decide where to dispatch without eagerly provisioning a sandbox — sandbox
 * provisioning is deferred to the built-in tools layer, which already
 * resolves the handle lazily on first sandbox-tool invocation.
 */
import type { SandboxProviderKind } from "@decocms/sandbox/provider";
import type { Capability } from "./protocol";
import type { LinkClaimRegistry, LinkClaim } from "./link-claim-registry";
import type { HarnessId } from "../harnesses";
import { shouldUsePullTransport } from "./pull-transport-canary";

export type LinkTransport = "ws" | "pull";

export type DispatchTarget =
  | { runsIn: "cluster"; sandbox: SandboxProviderKind; link?: LinkClaim }
  | {
      runsIn: "user-desktop";
      sandbox: "user-desktop";
      link: LinkClaim;
      linkTransport: LinkTransport;
    };

export type DispatchError =
  | { kind: "user_desktop_link_offline" }
  | {
      kind: "user_desktop_link_capability_missing";
      activeCapabilities: Capability[];
    };

export type ResolveDispatchTargetResult =
  | { ok: true; target: DispatchTarget }
  | { ok: false; error: DispatchError };

interface Input {
  harnessId: HarnessId;
  sandboxProviderKind: SandboxProviderKind;
  userId: string;
  /** Thread's message_storage_version. Required to enforce pull ⊆ v2 (L12). */
  messageStorageVersion: number;
  /** Pinned transport from threads.link_transport column. null = canary decides. */
  linkTransport: "pull" | "ws" | null;
  /** Resolved canary percent (0–100) from parsePullPercent(env). */
  pullPercent: number;
}

interface Deps {
  linkClaimRegistry: LinkClaimRegistry;
}

function capabilityFor(harnessId: HarnessId): Capability | null {
  if (harnessId === "claude-code") return "claude-code";
  if (harnessId === "codex") return "codex";
  if (harnessId === "decopilot") return "decopilot-sandbox";
  return null;
}

export async function resolveDispatchTarget(
  input: Input,
  deps: Deps,
): Promise<ResolveDispatchTargetResult> {
  const kind = input.sandboxProviderKind;

  if (kind !== "user-desktop") {
    return { ok: true, target: { runsIn: "cluster", sandbox: kind } };
  }

  const link = await deps.linkClaimRegistry.get(input.userId);
  if (!link) {
    return { ok: false, error: { kind: "user_desktop_link_offline" } };
  }

  const requiredCap = capabilityFor(input.harnessId);
  if (requiredCap && !link.capabilities.includes(requiredCap)) {
    return {
      ok: false,
      error: {
        kind: "user_desktop_link_capability_missing",
        activeCapabilities: link.capabilities,
      },
    };
  }

  if (input.harnessId === "decopilot") {
    // Phase E moves decopilot to the desktop. Until then, it runs cluster-side
    // with sandbox tools tunneled via the WS. No linkTransport field here.
    return {
      ok: true,
      target: { runsIn: "cluster", sandbox: "user-desktop", link },
    };
  }

  // codex / claude-code: decide between ws and pull transport.
  // L12: pull ⊆ v2 is enforced inside shouldUsePullTransport.
  const usePull = shouldUsePullTransport({
    threadId: input.userId, // bucketing seed — use userId for stable per-user roll-out
    messageStorageVersion: input.messageStorageVersion,
    linkTransport: input.linkTransport,
    percent: input.pullPercent,
  });

  return {
    ok: true,
    target: {
      runsIn: "user-desktop",
      sandbox: "user-desktop",
      link,
      linkTransport: usePull ? "pull" : "ws",
    },
  };
}
```

> **NOTE on bucketing seed:** The canary uses `userId` (not `threadId`) as the bucket seed so that all threads for a given user flip together, keeping a consistent desktop experience per user rather than per-thread. If per-thread granularity is preferred, change the seed to `input.userId + ":" + threadId` where `threadId` is added to `Input`.

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/links/resolve-dispatch-target.test.ts`
Expected: PASS (all tests).

- [ ] **Step 5: Fix callers of `resolveDispatchTarget`**

The `Input` interface gained three new required fields (`messageStorageVersion`, `linkTransport`, `pullPercent`). Find all call sites:

Run: `grep -r "resolveDispatchTarget(" apps/mesh/src/ --include="*.ts" -l`

For each call site, add the new fields. The primary call site is `apps/mesh/src/api/routes/decopilot/routes.ts`. Read the thread record there (already loaded) and pass:
- `messageStorageVersion: thread.message_storage_version ?? 1`
- `linkTransport: (thread.link_transport as "pull" | "ws" | null) ?? null`
- `pullPercent: parsePullPercent(process.env.LINK_PULL_TRANSPORT_PERCENT)`

Add the import at the top of `routes.ts`:
```ts
import { parsePullPercent } from "../../links/pull-transport-canary";
```

- [ ] **Step 6: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 7: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/links/resolve-dispatch-target.ts apps/mesh/src/links/resolve-dispatch-target.test.ts apps/mesh/src/api/routes/decopilot/routes.ts
git commit -m "$(cat <<'EOF'
feat(links): extend resolveDispatchTarget with linkTransport decision (pull ⊆ v2)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Canary pin at thread creation + `HarnessStreamInput` wire shape

At first-message creation time, pin `link_transport` in the DB. Also add `runFenceToken` to the wire schema so the daemon can include it when posting to the ingest.

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/routes.ts` (first-message pin)
- Modify: `apps/mesh/src/links/protocol/schemas.ts` (add `runFenceToken`)
- Modify: `apps/mesh/src/harnesses/types.ts` (add `runFenceToken`)

- [ ] **Step 1: Add `runFenceToken` to the wire schema**

In `apps/mesh/src/links/protocol/schemas.ts`, inside `harnessStreamInputSchema` after `traceparent`:

```ts
    /** Fence token for the Phase-A ingest endpoint (spec §3.5). Included in
     *  the work-item payload so the daemon can POST it as x-fence-token to
     *  /api/:org/links/runs/:runId/stream. Absent for WS/v1 runs. */
    runFenceToken: z.string().optional(),
```

- [ ] **Step 2: Add `runFenceToken` to `HarnessStreamInput`**

In `apps/mesh/src/harnesses/types.ts`, inside `HarnessStreamInput` after `traceparent`:

```ts
  /** Fence token (spec §3.5). Included when the cluster dispatches via the
   *  pull transport; passed by the daemon as `x-fence-token` to the ingest.
   *  Absent for WS/v1 runs and in-process (cluster-side) dispatch. */
  runFenceToken?: string;
```

- [ ] **Step 3: Pin `link_transport` at thread creation**

In `apps/mesh/src/api/routes/decopilot/routes.ts`, at the first-message creation site where `message_storage_version` is pinned (search for `shouldPinV2FromEnv` or `setRunFence`), add the transport pin immediately after the v2 pin:

```ts
// Pin link_transport alongside message_storage_version so both are set
// before the first resolveDispatchTarget call. Pull requires v2 (L12).
if (thread.message_storage_version >= 2) {
  const usePull = shouldUsePullTransportFromEnv(
    thread.id,
    thread.message_storage_version,
    null, // no prior column value — first message
  );
  if (usePull) {
    await ctx.storage.threads.setLinkTransport(thread.id, "pull");
  }
}
```

Add the import at the top:
```ts
import { shouldUsePullTransportFromEnv } from "../../links/pull-transport-canary";
```

- [ ] **Step 4: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/links/protocol/schemas.ts apps/mesh/src/harnesses/types.ts apps/mesh/src/api/routes/decopilot/routes.ts
git commit -m "$(cat <<'EOF'
feat(links): pin link_transport at thread creation + add runFenceToken to wire schema

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Cluster dispatch branch — publish work item for pull threads

Add the `target.linkTransport === "pull"` branch in `dispatch-run.ts`. This task depends on Phase B's `publishWorkItem(userId, workItem)` function being available. Until Phase B is merged, gate the branch behind a compile-time assertion comment so the type-checker catches a missing import.

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`

- [ ] **Step 1: Add the pull-dispatch branch**

In `apps/mesh/src/api/routes/decopilot/dispatch-run.ts`, locate the `if (target.runsIn === "user-desktop")` block (lines ~1021–1093). Add a nested branch immediately after the guard comment (before the `resolveRemoteCliSandboxHandle` call):

```ts
        if (target.runsIn === "user-desktop") {
          // Phase D: pull transport publishes a work item to the JetStream
          // WorkQueue (Phase B) instead of calling remoteDispatch over WS.
          // The daemon pulls the item, calls its loopback /dispatch, and
          // POSTs the SSE result to the Phase-A ingest endpoint.
          if (target.linkTransport === "pull") {
            // Build the wire-serializable HarnessStreamInput (no signal,
            // no processLocal). runFenceToken is minted by prepareRun
            // (Phase B) and included here so the daemon can POST it to
            // the ingest as x-fence-token (spec §3.5, L4).
            const workItem: HarnessStreamInputWire & { runFenceToken?: string } = {
              threadId: harnessInput.threadId,
              runId: harnessInput.runId,
              taskId: harnessInput.taskId,
              resumeSessionRef: harnessInput.resumeSessionRef,
              messages: harnessInput.messages,
              models: harnessInput.models,
              mcp,
              mode: String(harnessInput.mode),
              temperature: harnessInput.temperature,
              toolApprovalLevel: String(harnessInput.toolApprovalLevel),
              user: harnessInput.user,
              organizationId: harnessInput.organizationId,
              organizationSlug: ctx.organization?.slug,
              virtualMcp: harnessInput.virtualMcp as Record<string, unknown>,
              agent: harnessInput.agent,
              branch: harnessInput.branch ?? null,
              triggerId: harnessInput.triggerId,
              currentThreadTitle: harnessInput.currentThreadTitle,
              traceparent: harnessInput.traceparent,
              // runFenceToken is set by prepareRun (Phase B); if absent here
              // (Phase A-only deployment), the ingest fence check passes because
              // no token is minted yet (fenceMatches(null, undefined) = true).
              runFenceToken: harnessInput.runFenceToken,
            };
            // PHASE B DEPENDENCY: publishWorkItem must be imported from the
            // WorkQueue module. Replace the line below with the real call once
            // Phase B is merged.
            // import { publishWorkItem } from "@/links/work-queue";
            // await publishWorkItem(input.userId, harnessId, workItem, deps.nats);
            //
            // Until Phase B lands this branch is unreachable (pull ⊆ v2,
            // Phase B is required to mint the fence and enqueue) — but the
            // types must compile.
            throw new Error(
              "[dispatch-run] pull transport requires Phase B WorkQueue — not yet merged",
            );
          }
          // WS transport (default): fall through to remoteDispatch below.
```

Then close the added block and leave the existing `resolveRemoteCliSandboxHandle` + `remoteDispatch` path for the `else` (WS) case:

```ts
          // WS path (link_transport = 'ws' or default):
          const { sandboxHandle } = await resolveRemoteCliSandboxHandle(
            { agent: input.agent, branch: mem.thread.branch ?? input.branch },
            ctx,
          );
          // ... existing remoteDispatch call unchanged ...
```

**IMPORTANT:** Update the import section at the top of `dispatch-run.ts` to add the `HarnessStreamInputWire` type:

```ts
import type { HarnessStreamInputWire } from "@/links/protocol/schemas";
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. (The `throw` satisfies the branch; the `workItem` shape is verified by the `HarnessStreamInputWire` type.)

- [ ] **Step 3: Confirm existing WS tests still pass**

Run: `bun test apps/mesh/src/api/routes/decopilot/`
Expected: PASS — no existing behavior changed (the new branch is gated behind `target.linkTransport === "pull"` which is only set for v2 + canary threads; no test thread hits it).

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/dispatch-run.ts
git commit -m "$(cat <<'EOF'
feat(decopilot): add pull-transport branch in dispatch-run (Phase B dependency noted)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Phase B integration — wire up `publishWorkItem` ⚠️ PHASE B DEPENDENCY

**This task is a stub** to be completed once Phase B is merged. It replaces the `throw` placeholder in Task 4 with the real `publishWorkItem` call, and adds the fence-token minting in `prepareRun`.

**Files:**
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (replace throw with real call)
- Modify: `apps/mesh/src/api/routes/decopilot/dispatch-run.ts` (populate `runFenceToken` in `harnessInput` from `prepareRun`)

- [ ] **Step 1: Read Phase B's WorkQueue API**

After Phase B merges, read `apps/mesh/src/links/work-queue.ts` to find the exact signature of `publishWorkItem`. Verify the parameters match:
- `userId: string` (the user whose `link.work.<userId>` subject to publish to)
- `harnessId: HarnessId`
- `workItem: HarnessStreamInputWire & { runFenceToken?: string }`
- NATS connection reference (whatever Phase B thread-gate deps carry)

- [ ] **Step 2: Replace the throw placeholder**

Replace:
```ts
            throw new Error(
              "[dispatch-run] pull transport requires Phase B WorkQueue — not yet merged",
            );
```

With the real call, for example (exact signature to be confirmed from Phase B):
```ts
            await publishWorkItem(
              input.userId,
              harnessId,
              workItem,
              deps.nats,
            );
            // rawHarnessChunks is undefined for the pull path — the harness
            // runs on the desktop and its output lands via the Phase A ingest.
            // The DBOS gate (Phase B) awaits durable completion; we don't
            // produce a local chunk stream here.
            rawHarnessChunks = (async function* () {})();
```

- [ ] **Step 3: Populate `runFenceToken` in `harnessInput`**

In `prepareRun`, after `claimRunStart` mints the fence token (Phase B), add to the `harnessInput` construction:
```ts
    const runFenceToken = await ctx.storage.threads.getRunFence(mem.thread.id);
    // ... existing harnessInput construction ...
    harnessInput.runFenceToken = runFenceToken ?? undefined;
```

- [ ] **Step 4: Typecheck and run existing tests**

Run: `bun run --cwd=apps/mesh check && bun test apps/mesh/src/api/routes/decopilot/`
Expected: PASS.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/api/routes/decopilot/dispatch-run.ts
git commit -m "$(cat <<'EOF'
feat(decopilot): wire publishWorkItem for pull-transport dispatch (Phase B)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Daemon — `work-poller.ts` (long-poll GET /api/:org/links/work)

⚠️ **SHIPPED DAEMON — needs human review before merge**

This module is compiled into the `deco link` CLI binary and the sandbox daemon package. Any change requires a coordinated daemon release.

**Files:**
- Create: `apps/mesh/src/link-daemon/work-poller.ts`

- [ ] **Step 1: Write the work poller**

```ts
// apps/mesh/src/link-daemon/work-poller.ts
/**
 * Work-poll loop for the pull transport (Phase D, spec §3.2).
 *
 * Continuously long-polls GET /api/:org/links/work. On a 200 response, parses
 * the JSON body as a HarnessStreamInputWire work item and invokes `onWork`.
 * On 204 (no work), immediately re-polls. On errors, backs off using
 * exponentialBackoffWithJitter from @decocms/std.
 *
 * The loop runs until `signal` is aborted. Each poll refreshes the presence
 * claim by piggy-backing on the request (the server updates `studio_links`
 * TTL on every work-poll hit, per spec §3.2).
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
import { exponentialBackoffWithJitter, sleep } from "@decocms/std";
import type { HarnessStreamInputWire } from "../links/protocol/schemas";

export interface WorkPollerInput {
  /** Fully-qualified base URL, e.g. "https://studio.deco.cx". */
  baseUrl: string;
  /** Org slug for the org-scoped route /api/:org/links/work. */
  orgSlug: string;
  /** Called with each parsed work item. Must not throw — errors are swallowed. */
  onWork: (item: HarnessStreamInputWire) => Promise<void>;
  /** Bearer token resolver. Called before each request so a refreshed token
   *  reaches every poll without pinning a stale credential (fixes D1). */
  getAccessToken: () => Promise<string>;
  /** Abort signal. The loop exits cleanly when aborted. */
  signal: AbortSignal;
  /** Long-poll timeout in seconds sent as ?timeout= query param (default 29). */
  pollTimeoutSecs?: number;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

export async function runWorkPollLoop(input: WorkPollerInput): Promise<void> {
  const { baseUrl, orgSlug, onWork, getAccessToken, signal } = input;
  const pollTimeout = input.pollTimeoutSecs ?? 29;
  const url = `${baseUrl}/api/${orgSlug}/links/work?timeout=${pollTimeout}`;
  let errorStreak = 0;

  while (!signal.aborted) {
    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      console.error("[work-poller] getAccessToken failed", err);
      // Back off before retrying token refresh.
      const delay = exponentialBackoffWithJitter(
        MAX_DELAY_MS,
        BASE_DELAY_MS,
        errorStreak,
        2,
        0.5,
      );
      errorStreak++;
      await sleep(delay, { signal }).catch(() => {});
      continue;
    }

    let res: Response;
    try {
      res = await fetch(url, {
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      console.error("[work-poller] fetch error", err);
      const delay = exponentialBackoffWithJitter(
        MAX_DELAY_MS,
        BASE_DELAY_MS,
        errorStreak,
        2,
        0.5,
      );
      errorStreak++;
      await sleep(delay, { signal }).catch(() => {});
      continue;
    }

    if (res.status === 204) {
      // No work available — re-poll immediately (the server held the
      // connection for pollTimeout seconds before returning 204).
      errorStreak = 0;
      continue;
    }

    if (res.status === 200) {
      errorStreak = 0;
      let item: HarnessStreamInputWire;
      try {
        item = (await res.json()) as HarnessStreamInputWire;
      } catch (err) {
        console.error("[work-poller] failed to parse work item", err);
        continue;
      }
      try {
        await onWork(item);
      } catch (err) {
        console.error("[work-poller] onWork threw (swallowed)", err);
      }
      continue;
    }

    // 4xx/5xx — back off.
    console.error(
      `[work-poller] unexpected status ${res.status} from work poll`,
    );
    const delay = exponentialBackoffWithJitter(
      MAX_DELAY_MS,
      BASE_DELAY_MS,
      errorStreak,
      2,
      0.5,
    );
    errorStreak++;
    await sleep(delay, { signal }).catch(() => {});
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/work-poller.ts
git commit -m "$(cat <<'EOF'
feat(link-daemon): add work-poll loop for pull transport [SHIPPED DAEMON]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Daemon — `handleLocalDispatch` in `control-handler.ts`

⚠️ **SHIPPED DAEMON — needs human review before merge**

Add `handleLocalDispatch` which takes a work item, ensures the sandbox is running, calls loopback `/dispatch` as SSE, and streams the response to the Phase-A ingest endpoint.

**Files:**
- Modify: `apps/mesh/src/link-daemon/control-handler.ts`

- [ ] **Step 1: Extend `ControlHandler` interface and implement**

Read `apps/mesh/src/link-daemon/control-handler.ts` (already done above). Add the following to the `ControlHandler` interface and the `createControlHandler` implementation.

In the `ControlHandler` interface (after the existing `handleStream` method):

```ts
  /**
   * Handle a work item pulled from GET /api/:org/links/work (pull transport).
   *
   * 1. Ensures the sandbox named by `item.agent.id` + `item.branch` is running
   *    (via the existing `ensureSandbox` path in the provider).
   * 2. POSTs the work item to the loopback sandbox `/dispatch` endpoint as SSE.
   * 3. Streams the SSE response body to the cluster ingest endpoint
   *    `POST /api/:org/links/runs/:runId/stream` with x-fence-token.
   *
   * ⚠️ SHIPPED DAEMON — needs human review before merge.
   *
   * NOTE: workdir lock / tool idempotency on desktop re-run is out of Phase D
   * scope (spec §6). Production readiness requires the follow-up workdir fence
   * before 100% rollout.
   */
  handleLocalDispatch(
    item: HarnessStreamInputWire,
    clusterBaseUrl: string,
    orgSlug: string,
    getAccessToken: () => Promise<string>,
    signal: AbortSignal,
  ): Promise<void>;
```

In the `createControlHandler` return object, add the implementation:

```ts
    async handleLocalDispatch(item, clusterBaseUrl, orgSlug, getAccessToken, signal) {
      // 1. Ensure the sandbox is available (reuses the existing provider path).
      const handle = computeSandboxHandle(item.agent.id, item.branch ?? null);
      const sandbox = await deps.provider.ensureSandbox({
        handle,
        repo: item.branch
          ? { agentId: item.agent.id, branch: item.branch }
          : undefined,
      });

      // 2. Call the loopback /dispatch endpoint with the work item.
      const dispatchUrl = `http://127.0.0.1:${sandbox.port}/_sandbox/${handle}/dispatch`;
      const dispatchRes = await fetcher(dispatchUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          // The sandbox daemon authenticates via the daemonToken it received
          // at spawn time. The token is held by the provider; access it via
          // provider.getDaemonToken(handle) or pass it as a separate dep.
          // TODO(Phase D): resolve daemonToken from provider.getDaemonToken(handle)
          // For now, pass an empty token — the local sandbox trusts loopback.
          Authorization: `Bearer ${sandbox.daemonToken ?? ""}`,
        },
        body: JSON.stringify({
          harnessId: item.agent.id.includes("codex") ? "codex" : "claude-code",
          input: item,
        }),
        signal,
      });

      if (!dispatchRes.ok || !dispatchRes.body) {
        throw new Error(
          `[control-handler] loopback /dispatch failed: ${dispatchRes.status}`,
        );
      }

      // 3. Stream the SSE body to the cluster ingest.
      const token = await getAccessToken();
      const ingestUrl = `${clusterBaseUrl}/api/${orgSlug}/links/runs/${item.runId}/stream`;
      await fetcher(ingestUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "content-type": "text/event-stream",
          "x-fence-token": item.runFenceToken ?? "",
          "transfer-encoding": "chunked",
        },
        // Stream the raw SSE body straight through — the ingest endpoint
        // re-parses it identically to remoteDispatch (Phase A, parseDispatchSSEStream).
        body: dispatchRes.body,
        // @ts-expect-error — Bun/Node fetch supports streaming body with duplex
        duplex: "half",
        signal,
      });
    },
```

Also add at the top of `control-handler.ts`:

```ts
import type { HarnessStreamInputWire } from "../links/protocol/schemas";
```

And a helper for sandbox handle computation (reuse the existing one if it's already imported from the provider package; otherwise inline):

```ts
function computeSandboxHandle(agentId: string, branch: string | null): string {
  // Mirror the cluster's computeHandle logic: agent-<agentId>[-<branch>]
  return branch ? `agent-${agentId}-${branch}` : `agent-${agentId}`;
}
```

> **Note on `sandbox.daemonToken`:** The `DesktopSandboxProvider.ensureSandbox()` return type may or may not include `daemonToken`. Read `apps/mesh/src/link-daemon/user-desktop-provider.ts` to confirm the return shape and adjust accordingly. If `daemonToken` is not on the return type, retrieve it from the provider's internal `sandbox.spawnedDaemonToken` map.

- [ ] **Step 2: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS. (The `duplex: "half"` line may need `// @ts-expect-error` for Bun's fetch types.)

- [ ] **Step 3: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/control-handler.ts
git commit -m "$(cat <<'EOF'
feat(link-daemon): add handleLocalDispatch for pull transport [SHIPPED DAEMON]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Daemon — pull loop entry point in `cluster-connection.ts` and `index.ts`

⚠️ **SHIPPED DAEMON — needs human review before merge**

Add `connectToClusterPull()` as a parallel entry point alongside the existing `connectToCluster()` (which stays unchanged for WS threads). Branch on `LINK_TRANSPORT_MODE=pull` in `index.ts`.

**Files:**
- Modify: `apps/mesh/src/link-daemon/cluster-connection.ts`
- Modify: `apps/mesh/src/link-daemon/index.ts`

- [ ] **Step 1: Add `connectToClusterPull` to `cluster-connection.ts`**

Read the full `cluster-connection.ts` file (specifically lines 1–280 to understand the `ClusterConnectionInput` / `ClusterConnectionHandle` interfaces already defined). Then add after the existing `connectToCluster` export:

```ts
/**
 * Pull-transport cluster connection (Phase D, spec §3.1).
 *
 * Instead of a persistent WebSocket, runs two parallel long-poll loops:
 *   - `runWorkPollLoop`: pulls work items and dispatches them locally.
 *   - A control-poll loop (Phase C): pulls cancel/HITL frames.
 *
 * The WS `connectToCluster` is untouched — it remains active for WS threads.
 *
 * ⚠️ SHIPPED DAEMON — needs human review before merge.
 */
export async function connectToClusterPull(
  input: ClusterConnectionInput & {
    /** Org slug for the org-scoped /api/:org/links/work endpoint. */
    orgSlug: string;
    /** Cluster public base URL (e.g. "https://studio.deco.cx"). */
    clusterBaseUrl: string;
  },
): Promise<ClusterConnectionHandle> {
  let resolveClosed!: () => void;
  const closed = new Promise<void>((r) => {
    resolveClosed = r;
  });
  const ac = new AbortController();

  input.onConnected?.();

  const workPollDone = runWorkPollLoop({
    baseUrl: input.clusterBaseUrl,
    orgSlug: input.orgSlug,
    onWork: async (item) => {
      await input.controlHandler.handleLocalDispatch(
        item,
        input.clusterBaseUrl,
        input.orgSlug,
        input.getAccessToken ?? (() => Promise.resolve(input.accessToken)),
        ac.signal,
      );
    },
    getAccessToken:
      input.getAccessToken ?? (() => Promise.resolve(input.accessToken)),
    signal: ac.signal,
  });

  // TODO(Phase C): add holdControlPollLoop() here for cancel/HITL frames.

  void workPollDone.then(resolveClosed, resolveClosed);

  return {
    async close() {
      ac.abort();
      await closed;
    },
    closed,
  };
}
```

Add the import at the top:
```ts
import { runWorkPollLoop } from "./work-poller";
```

- [ ] **Step 2: Branch on `LINK_TRANSPORT_MODE` in `index.ts`**

In `apps/mesh/src/link-daemon/index.ts`, find where `connectToCluster` is called (the main WS connection startup). Add a branch before or after it:

```ts
// Phase D: LINK_TRANSPORT_MODE=pull launches the pull loop instead of the WS.
// Both can coexist on the same daemon for gradual rollout (each serves the
// transport its threads are pinned to). For a full pull-only daemon, set
// LINK_TRANSPORT_MODE=pull and remove the WS branch.
const linkTransportMode = process.env.LINK_TRANSPORT_MODE ?? "ws";

if (linkTransportMode === "pull") {
  // Validate that the required env vars are present.
  const orgSlug = process.env.DECO_ORG_SLUG ?? ctx.organizationSlug;
  const clusterBaseUrl =
    process.env.DECO_CLUSTER_URL ?? "https://studio.deco.cx";
  if (!orgSlug) {
    console.error(
      "[link-daemon] LINK_TRANSPORT_MODE=pull requires DECO_ORG_SLUG",
    );
    process.exit(1);
  }
  console.log(
    `[link-daemon] starting pull-transport loop (org=${orgSlug} cluster=${clusterBaseUrl})`,
  );
  const handle = await connectToClusterPull({
    ...wsInput,
    orgSlug,
    clusterBaseUrl,
  });
  // ... wait for handle.closed / teardown same as WS path ...
} else {
  // Default: WS transport (unchanged).
  const handle = await connectToCluster(wsInput);
  // ... existing wait / teardown ...
}
```

> **Note:** Read `apps/mesh/src/link-daemon/index.ts` carefully before editing. The exact structure around `connectToCluster` (teardown, signal wiring, `onConnected` hook) must be replicated for the pull path. The snippet above is a skeleton; adapt it to match the actual surrounding code.

- [ ] **Step 3: Typecheck**

Run: `bun run --cwd=apps/mesh check`
Expected: PASS.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/cluster-connection.ts apps/mesh/src/link-daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(link-daemon): add connectToClusterPull entry point + LINK_TRANSPORT_MODE gate [SHIPPED DAEMON]

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Integration and E2E coverage

### Testability caveats

The full pull round-trip (cluster publishes work item → daemon pulls → loopback /dispatch → ingest POST) involves:
1. The **JetStream WorkQueue** (Phase B) — not unit-testable.
2. The **shipped daemon binary** (`apps/mesh/src/link-daemon/`) — not importable into Playwright without compilation.
3. The **loopback sandbox /dispatch** — requires a running sandbox daemon.

Therefore:
- **Unit tests** (bun test): the canary predicate (Task 1) and the `resolveDispatchTarget` branch (Task 2) are fully unit-tested.
- **Cluster-side integration test** (e2e): tests the ingest + fence path already covered by Phase A's `link-ingest.spec.ts`. The Phase D cluster branch (publishing to WorkQueue) is indirectly tested by verifying that a `link_transport='pull'` thread does NOT call `remoteDispatch` and instead publishes to the queue — but this requires Phase B's WorkQueue to be present.
- **Stub-daemon e2e**: `link-dispatch-pull.spec.ts` (below) simulates the daemon by running the pull-loop logic directly in the test: it long-polls the work endpoint, calls a mock `/dispatch`, and POSTs the SSE to the ingest. It does NOT use the shipped binary; it validates the HTTP protocol shapes only.

**Files:**
- Create: `apps/mesh/e2e/tests/link-dispatch-pull.spec.ts`

- [ ] **Step 1: Write the stub-daemon e2e test**

```ts
// apps/mesh/e2e/tests/link-dispatch-pull.spec.ts
/**
 * Pull-transport round-trip e2e (stub daemon).
 *
 * Validates the HTTP contract for Phase D without the shipped daemon binary:
 *   1. A v2 thread with link_transport='pull' receives a work item at GET /links/work
 *      (Phase B endpoint) after a turn is submitted.
 *   2. A stub actor (this test) pulls the item, constructs a mock SSE response,
 *      and POSTs it to the Phase A ingest endpoint.
 *   3. Parts land in thread_message_parts with the correct content.
 *   4. A stale fence is rejected 409 even if the stub posts after a re-fence.
 *
 * NOTE: Steps 1 requires Phase B (WorkQueue) to be present. Until then,
 * this test is marked with `test.skip` and unblocked when Phase B merges.
 * Steps 2–4 exercise the Phase A ingest and are already covered by
 * link-ingest.spec.ts; they are repeated here as a protocol-shape regression
 * guard for the pull round-trip.
 */
import { expect, test } from "@playwright/test";
import {
  createOrgAndUser,
  seedV2Thread,
  sseBody,
  listParts,
} from "../helpers";

test.skip("pull round-trip: work item lands at /links/work after turn submission (needs Phase B)", async ({
  request,
}) => {
  const { org, bearer } = await createOrgAndUser();
  const threadId = await seedV2Thread(org.id, {
    linkTransport: "pull",
    runFenceToken: "tok-pull-1",
  });

  // Submit a turn (POST /api/:org/messages — simulated here as a direct
  // thread_messages insert for Phase D testing without a full chat flow).
  // A real test will POST to /messages once Phase B's gate publishes work.

  // Stub: poll for the work item.
  const workRes = await request.get(
    `/api/${org.slug}/links/work?timeout=5`,
    { headers: { Authorization: `Bearer ${bearer}` } },
  );
  expect(workRes.status()).toBe(200);
  const workItem = await workRes.json();
  expect(workItem.threadId).toBe(threadId);
  expect(workItem.runFenceToken).toBe("tok-pull-1");

  // Stub: POST the SSE result to the ingest (simulating what the daemon does).
  const ingestRes = await request.post(
    `/api/${org.slug}/links/runs/${workItem.runId}/stream`,
    {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "x-fence-token": workItem.runFenceToken,
        "content-type": "text/event-stream",
      },
      data: sseBody([
        { type: "ui-message-chunk", chunk: { type: "start" } },
        { type: "ui-message-chunk", chunk: { type: "text-start", id: "t1" } },
        { type: "ui-message-chunk", chunk: { type: "text-delta", id: "t1", delta: "pull works" } },
        { type: "ui-message-chunk", chunk: { type: "text-end", id: "t1" } },
        { type: "ui-message-chunk", chunk: { type: "finish" } },
        { type: "done" },
      ]),
    },
  );
  expect(ingestRes.status()).toBe(200);

  const parts = await listParts(threadId);
  expect(parts.some((p) => p.kind === "text")).toBe(true);
});

test("pull ingest: stale fence is rejected 409 (Phase A contract, pull shape)", async ({
  request,
}) => {
  const { org, bearer } = await createOrgAndUser();
  const threadId = await seedV2Thread(org.id, {
    linkTransport: "pull",
    runFenceToken: "tok-current",
  });

  const res = await request.post(
    `/api/${org.slug}/links/runs/${threadId}/stream`,
    {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "x-fence-token": "tok-stale",
        "content-type": "text/event-stream",
      },
      data: sseBody([{ type: "done" }]),
    },
  );
  expect(res.status()).toBe(409);
  expect(await listParts(threadId)).toHaveLength(0);
});
```

- [ ] **Step 2: Run the non-skipped e2e test**

Run: `bun run --cwd=apps/mesh test:e2e link-dispatch-pull`
Expected: the `stale fence` test PASSES; the `skip`ped test is skipped.

- [ ] **Step 3: Full check + lint + format, then commit**

```bash
bun run --cwd=apps/mesh check && bun run lint && bun run fmt:check
bun run fmt
git add apps/mesh/e2e/tests/link-dispatch-pull.spec.ts
git commit -m "$(cat <<'EOF'
test(links): add pull-transport e2e (stub daemon + fence protocol)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Done criteria for Phase D

- `threads.link_transport` column exists and is pinned at thread creation for v2 canary-selected threads.
- `resolveDispatchTarget` returns `linkTransport: 'pull'` for v2 + pull-selected threads and `linkTransport: 'ws'` otherwise. `pull ⊆ v2` is enforced as a hard gate.
- `dispatch-run.ts` branches on `target.linkTransport === "pull"`: publishes a work item (with `runFenceToken`) to the Phase-B WorkQueue instead of calling `remoteDispatch`. The WS `remoteDispatch` path is byte-for-byte unchanged for all other threads.
- `HarnessStreamInputWire` and `HarnessStreamInput` include an optional `runFenceToken` field.
- The daemon pull loop (`connectToClusterPull` + `runWorkPollLoop` + `handleLocalDispatch`) compiles and is gated behind `LINK_TRANSPORT_MODE=pull`. The existing WS `connectToCluster` path is unchanged.
- All unit tests (`pull-transport-canary`, `resolve-dispatch-target`) and the non-skipped e2e (`link-dispatch-pull/stale fence`) pass.
- `bun run check`, `bun run lint`, and `bun run fmt:check` are green.
- All daemon-touching tasks (`work-poller.ts`, `cluster-connection.ts`, `control-handler.ts`, `index.ts`) are marked ⚠️ SHIPPED DAEMON and reviewed by a human before merging.

**Prerequisites for full activation (beyond this plan):**
- Phase B merged → `publishWorkItem` replaces the `throw` placeholder in Task 5.
- Phase C merged → `holdControlPollLoop()` stub in `connectToClusterPull` gains real cancel delivery.
- Workdir lock + tool idempotency follow-up (spec §6) → required for production-safe desktop-death re-run.
- Canary can then advance: set `LINK_PULL_TRANSPORT_PERCENT=1` → observe → increase.

**Next:** Phase E — `decopilot` portability: sever `processLocal`, fold cluster-coupled built-ins into `mcp.url`, register in the daemon, route user-desktop decopilot to the desktop. Tunnel dies; reverse-WS fully retired.
