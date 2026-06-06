# Local-Link Pull Inversion — Phase F (Cleanup: Delete the Reverse-WS Middle-Man) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## ⛔ Landing status (2026-06-06) — BLOCKED. The cutover was attempted, reverted to keep CI green. Reverse-WS NOT deleted.

This phase's premise — *"pure deletion of code already dead after A–E"* — is **false in the current tree**. Two attempts surfaced three real blockers. What landed: only the genuinely-dead **dead-code cleanup** (`pull-transport-canary.ts` + `setLinkTransport` deleted, `RequestFrame` rehomed to `link-control-types.ts`) in commit `00a5569ec`. The **routing cutover** (`40562b383`) turned e2e + multi-pod RED and was **reverted** (`85125fa00`). Pull remains dormant; the WS path is intact and default.

**Blocker 1 — the cutover gate must be TARGET-gated, not NATS-gated.** The first cutover set `isPull = (workQueue != null)`, routing *every* chat (including cloud/in-cluster decopilot with no linked desktop) to pull → no daemon consumes the work → `[decopilot] stream error: decodeFrame` / runs hang. The correct rule is `isPull = (resolveDispatchTarget(...).runsIn === "user-desktop")` — pull only when the thread targets a **linked** desktop; cloud chats stay in-cluster (`dispatchRunAndWait`). The thread-gate needs the resolved dispatch target (link-claim lookup), which it does not currently compute.

**Blocker 2 — the in-cluster→desktop e2e specs need full pull-daemon SIMULATIONS, not just a presence claim.** `decopilot-messages.spec.ts` / `chat-locked-thread.spec.ts` (and the deleted `link-dispatch-happy`/`-eviction`) established a desktop link to drive dispatch *to the desktop*. Post-cutover that desktop path is pull, so these specs must poll `GET /links/work` **and run a fake harness that posts to ingest** (the way `link-dispatch-pull.spec.ts` does) — merely claiming presence (the first attempt) leaves the work unconsumed.

**Blocker 3 (the big one) — the reverse-WS carries MORE than the 5 spec'd traffic types; the sandbox HTTP reverse-proxy has NO pull home.** `buildDesktopProvider`/`getDispatch` (cluster `DesktopSandboxProvider.proxyDaemonRequest`) is still the LIVE path for **sandbox preview** (`api/routes/sandbox-proxy.ts`), **vm-events SSE** (`api/routes/vm-events.ts`), **`SANDBOX_START`** (`tools/sandbox/start.ts`), and the decopilot sandbox built-ins (`harnesses/decopilot/built-in-tools/index.ts`). The spec's traffic table only enumerated *lifecycle ensure/delete* (judged self-managed by the daemon) — but it MISSED that the cluster also reverse-proxies preview-iframe HTTP + event streams INTO the desktop sandbox over the same WS. Deleting `ws-gateway`/`dispatcher`/`buildDesktopProvider` breaks preview/events for every desktop link with **no built replacement**. `pullDispatch`'s own sandbox-config resolution (`resolvePullSandboxConfig` → `resolveRemoteCliSandboxHandle`) also still calls into this WS reverse-proxy (logged `dispatch-frames: malformed JSON`, currently swallowed).

**Recommended path to actually finish F (a real phase, not a deletion):**
1. **Phase C-bis — sandbox reverse-proxy over pull/loopback.** Rehome preview + vm-events + `SANDBOX_START` off `proxyDaemonRequest`. For local-link desktops this likely means the **local-ingress** path serves preview directly (desktop-served) and events stream via the ingest/control legs; decide the topology vs. the cloud preview-proxy (see memory `project_sandbox_preview_serving_topology`). Until this exists, `buildDesktopProvider` cannot be deleted.
2. **Target-gated cutover** (Blocker 1) + decouple `pullDispatch` sandbox-config from the WS (Blocker 3).
3. **Pull-daemon e2e sims** (Blocker 2) + a real pull `daemon-e2e` harness (the current `daemon-e2e` CI job is the *sandbox* daemon, unrelated).
4. **Daemon → pull-by-default** (`link-daemon/index.ts` `LINK_TRANSPORT_MODE ?? "ws"` → pull) — the hard break (users re-run `bunx decocms@latest link`).
5. **Only then** the deletions (`ws-gateway`, `dispatcher`, `dispatch-frames`, `cluster-connection`, `reconnect-backoff`, `buildDesktopProvider`).

The original task list below is correct *as the final deletion step* but must not start until steps 1–4 are done.

**Goal:** Delete every cluster-side component of the reverse-WebSocket path (`dispatcher.ts`, `ws-gateway.ts`, the `GET /api/links/connect` route, the reply-inbox mechanism, and the payload-chunking call sites in the reply leg) and the daemon's outbound WS loop (`cluster-connection.ts`, `reconnect-backoff.ts`, `dispatch-frames.ts`). After this phase no WS connection exists between the daemon and the cluster; presence, work delivery, reply, and control all ride the pull transport built in Phases A–E.

**Architecture:** This phase is **pure deletion**. It removes code that is already dead after Phases A–E cut over all five traffic types. Each deletion is guarded by a caller-audit grep → zero-reference confirmation → knip/typecheck/lint gate. The ordering follows the dependency chain: cluster-side first (gateway, dispatcher, app.ts wiring, index.ts WS multiplexer) then daemon-side (cluster-connection, reconnect-backoff, dispatch-frames). The `link-claim-registry` and `payload-chunking.ts` core utility **survive** (claims move to the pull-cycle refresh; the chunking utility still serves the live-edge buffer).

**Tech Stack:** Bun, TypeScript, grep/knip for caller audits, `bun run check` (tsc), `bun run lint` (oxlint), `bun run fmt` (Biome).

**Spec:** [`local-link-pull-inversion-spec.md`](local-link-pull-inversion-spec.md) §1, §3.7, §7 (Phase F row), §8 invariants. The phase corresponds to the spec's "delete the two-pod NATS middle-man" headline.

**Testing conventions (from `TESTING.md`):** two tiers only. Unit (`bun test`) = pure logic. E2E (Playwright) = anything touching Postgres/NATS/HTTP. This phase deletes code rather than adding it, so the test strategy is: (a) confirm every deleted file's test file is also deleted, (b) confirm the remaining test suite is green after each deletion, and (c) run the full e2e suite once at the end to confirm no regressions in the pull-transport paths added by Phases A–E.

**Execution note:** Implement on the same branch as Phases A–E (or a follow-on branch off it). Run `bun run fmt` before every commit. Each task ends with a targeted `git add` and a conventional-commit message.

---

## Phase Dependency / Ordering Checklist

**Phase F MUST NOT begin until ALL of the following are confirmed complete (each item lists the traffic type it rehomes and the phase that does it):**

| Traffic type | Old path | New path | Phase |
|---|---|---|---|
| Chat dispatch (`request` frame, cluster → daemon) | `links.dispatch.<userSub>` NATS + `ws-gateway.ts` + WS | `GET /api/:org/links/work` long-poll (JetStream WorkQueue pull) | **B** |
| Reply frames (`chunk`/`end`/`error`, daemon → cluster) | WS + NATS reply inbox | `POST /api/:org/links/runs/:runId/stream` durable append | **A** (ingest), **C/D** (cutover) |
| Cancel (`cancel` frame) | `links.cancel.<userSub>` NATS + WS | `GET /api/:org/links/control` durable flag | **C** |
| Sandbox lifecycle (`POST/DELETE /_sandbox`) | WS reverse-proxy | control-poll `ensure_sandbox`/`delete_sandbox` frames | **C** |
| Decopilot tunnel (sandbox tools → cluster) | WS reverse-proxy + cluster `processLocal` | loopback (`mcp.url` injection) | **E** |

**Verification gate before starting Phase F:** Run the audit grep in Task 1 Step 1. If ANY caller of `ws-gateway.ts`, `dispatcher.ts`, or `cluster-connection.ts` can be traced to a live traffic path (not a test or a now-dead sandbox provider), stop and complete the blocking phase first.

---

## Open Design Decisions (resolve before coding)

### Decision 1 — Does `cluster-connection.ts` have undiscovered cluster→daemon push dependencies?

**Grounding unknown:** The reconnect loop + `getAccessToken` refresh suggest the WS was kept alive "for a reason." Could the cluster send config pushes, presence signals, or notifications beyond the five mapped traffic types?

**Resolution (confirmed by reading the source):** `cluster-connection.ts` handles exactly two incoming frame types: `request` (line 260) and `cancel` (line 262). The `hello` frame is sent outbound only (line 231). No other message type is parsed. There are no inbound cluster-push capabilities beyond what the five traffic types account for. After Phase E, the daemon has **no need for any cluster-push capability** — all cluster → daemon is pull-based. **Delete `connectToCluster` and the reconnect loop entirely.**

### Decision 2 — What does `DesktopSandboxProvider` do with the injected `dispatch` function?

**Grounding unknown:** `buildDesktopProvider` (lifecycle.ts:204) injects `dispatch: getDispatch()`. If `DesktopSandboxProvider` uses `dispatch` for any non-WS path, the dispatcher cannot be deleted even after the WS is gone.

**Resolution:** After Phase D, `buildDesktopProvider` is never called on the pull path — `resolve-provider.ts` routes `user-desktop` sandbox operations through the control-poll transport instead. The `DesktopSandboxProvider` constructor's `dispatch` field is the NATS-over-WS reverse-proxy path only. **Delete `buildDesktopProvider` in lifecycle.ts and all its callers in resolve-provider.ts** as part of this phase; they are dead after Phase D.

### Decision 3 — Is the legacy reaper in `run-registry.ts` tied to the WS gateway?

**Grounding:** The reaper interval (lines 62–67) drives `isRunStuck()` liveness checks which are independent of the WS transport. `THREAD_EXPIRY_MS` in `tools/thread/helpers.ts` is UI-only.

**Resolution:** **Keep the reaper.** It is transport-agnostic, safe, and does not reference any WS symbol. Nothing in `run-registry.ts` is deleted in Phase F.

### Decision 4 — Should `payload-chunking.ts` be deleted?

**Grounding:** `splitChunkData` has two call sites: `ws-gateway.ts` (deleted) and `nats-stream-buffer.ts` (kept for the live-edge delta firehose).

**Resolution:** **Keep the file.** Only the import in `ws-gateway.ts` goes away with the file deletion. The `MAX_PUBLISH_BYTES` constant and `splitChunkData` function continue to serve `nats-stream-buffer.ts`.

### Decision 5 — Does `dispatch-frames.ts` have any callers after deleting WS gateway + dispatcher + cluster-connection?

**Grounding:** `dispatch-frames.ts` is imported by `dispatcher.ts`, `ws-gateway.ts`, and `cluster-connection.ts` — all deleted in Phase F.

**Resolution:** **Delete `dispatch-frames.ts` and its test file** after confirming zero callers remain.

---

## File Structure

| File | Action | Responsibility of the deletion |
|---|---|---|
| `apps/mesh/src/links/ws-gateway.ts` | **Delete** | Cluster WS server: `links.dispatch.*` + `links.cancel.*` NATS subs, reply-inbox `_inflight` map, `GET /api/links/connect` route |
| `apps/mesh/src/links/ws-gateway.test.ts` | **Delete** | Test file for deleted module |
| `apps/mesh/src/links/dispatcher.ts` | **Delete** | NATS publish half: `links.dispatch.<userSub>` publish, per-call reply inbox, `DispatchFn` |
| `apps/mesh/src/links/dispatcher.test.ts` | **Delete** | Test file for deleted module |
| `apps/mesh/src/links/dispatch-frames.ts` | **Delete** | Frame codec used exclusively by the three deleted files |
| `apps/mesh/src/links/dispatch-frames.test.ts` | **Delete** | Test file for deleted module |
| `apps/mesh/src/api/app.ts` | **Modify** | Remove gateway + dispatcher imports (lines 106–115), `sharedDispatch` var (line 200), `getDispatch()` export (lines 207–214), `registerLinksGateway()` call (lines 1788–1817), dispatcher setup (lines 1822–1865), `gatewayWsHandlers` re-export (line 2152) |
| `apps/mesh/src/index.ts` | **Modify** | Remove `gatewayWsHandlers` destructure (line 57), `isGatewayWsData` guard (lines 146–152), and the three gateway branches in `websocket.open/message/close` (lines 193–215) |
| `apps/mesh/src/sandbox/lifecycle.ts` | **Modify** | Delete `buildDesktopProvider` function (lines 190–207) and its `getDispatch` dynamic import |
| `apps/mesh/src/sandbox/resolve-provider.ts` | **Modify** | Remove `buildDesktopProvider` call sites (lines 79, 184); route to pull-transport provider instead |
| `apps/mesh/src/link-daemon/cluster-connection.ts` | **Delete** | Daemon outbound WS: `connectToCluster`, `handleRequest`, reconnect loop |
| `apps/mesh/src/link-daemon/cluster-connection.test.ts` | **Delete** | Test file for deleted module |
| `apps/mesh/src/link-daemon/reconnect-backoff.ts` | **Delete** | WS reconnect backoff calculator — unused after WS deleted |
| `apps/mesh/src/link-daemon/reconnect-backoff.test.ts` | **Delete** | Test file for deleted module |
| `apps/mesh/src/link-daemon/index.ts` | **Modify** | Remove `connectToCluster` import and call; replace with pull-loop start (Phase D/C artifact); remove WS-dependent shutdown path |

---

## Task 1: Pre-deletion Caller Audit

Before touching any file, confirm that every call site of each deletion target has been rehomed by Phases A–E.

**Files to audit:**
- `apps/mesh/src/links/ws-gateway.ts` (callers: `app.ts`, `index.ts`)
- `apps/mesh/src/links/dispatcher.ts` (callers: `app.ts`, `sandbox/lifecycle.ts`)
- `apps/mesh/src/links/dispatch-frames.ts` (callers: `dispatcher.ts`, `ws-gateway.ts`, `link-daemon/cluster-connection.ts`)
- `apps/mesh/src/link-daemon/cluster-connection.ts` (callers: `link-daemon/index.ts`)
- `apps/mesh/src/link-daemon/reconnect-backoff.ts` (callers: `cluster-connection.ts`)

- [ ] **Step 1: Run caller-audit greps**

```bash
cd /Users/gimenes/conductor/workspaces/mesh/memphis-v7

# ws-gateway callers
grep -rn "ws-gateway\|registerLinksGateway\|gatewayWsHandlers\|WsAttachData\|GatewayNatsAdapter" apps/mesh/src/ --include="*.ts" | grep -v "ws-gateway\.ts"

# dispatcher callers
grep -rn "from.*dispatcher\|createDispatcher\|getDispatch\|DispatchFn\|DispatcherNatsAdapter" apps/mesh/src/ --include="*.ts" | grep -v "dispatcher\.ts"

# dispatch-frames callers
grep -rn "from.*dispatch-frames\|dispatchFrameSchema\|encodeFrame\|decodeFrame\|DispatchFrame" apps/mesh/src/ --include="*.ts" | grep -v "dispatch-frames\.ts"

# cluster-connection callers
grep -rn "from.*cluster-connection\|connectToCluster\|ClusterConnectionInput" apps/mesh/src/ --include="*.ts" | grep -v "cluster-connection\.ts"

# reconnect-backoff callers
grep -rn "from.*reconnect-backoff\|computeBackoffMs\|shouldReconnectOnClose" apps/mesh/src/ --include="*.ts" | grep -v "reconnect-backoff\.ts"
```

Expected output (Phase A–E complete): each grep returns **only** `app.ts`, `index.ts`, `sandbox/lifecycle.ts`, `link-daemon/index.ts`, and the respective test files — no references in pull-transport code paths (no `work-poll.ts`, `control-poll.ts`, `dispatch-run.ts`, or harness files). If any unexpected caller appears, stop and fix the blocking phase first.

- [ ] **Step 2: Confirm zero pull-path references**

Manually review the grep output. Acceptable callers at this point:
- `apps/mesh/src/api/app.ts` — the wiring file being gutted in Task 2
- `apps/mesh/src/index.ts` — the WS multiplexer being gutted in Task 2
- `apps/mesh/src/sandbox/lifecycle.ts` — `buildDesktopProvider` being deleted in Task 3
- `apps/mesh/src/sandbox/resolve-provider.ts` — call sites being removed in Task 3
- `apps/mesh/src/link-daemon/index.ts` — being refactored in Task 5
- `*.test.ts` files of the deleted modules themselves

Any other caller is a blocker — do not proceed.

---

## Task 2: Delete Cluster-Side WS Gateway and Dispatcher

Delete `ws-gateway.ts` and `dispatcher.ts` (and their test files), then gut `app.ts` and `index.ts` of all WS-gateway and dispatcher references.

**Files:**
- Delete: `apps/mesh/src/links/ws-gateway.ts`, `apps/mesh/src/links/ws-gateway.test.ts`
- Delete: `apps/mesh/src/links/dispatcher.ts`, `apps/mesh/src/links/dispatcher.test.ts`
- Modify: `apps/mesh/src/api/app.ts`
- Modify: `apps/mesh/src/index.ts`

- [ ] **Step 1: Verify test files for deleted modules exist (to be deleted with the module)**

```bash
ls /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/ws-gateway.test.ts \
   /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/dispatcher.test.ts
```

Expected: both files exist.

- [ ] **Step 2: Delete the four files**

```bash
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/ws-gateway.ts
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/ws-gateway.test.ts
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/dispatcher.ts
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/dispatcher.test.ts
```

- [ ] **Step 3: Gut `app.ts` — remove gateway and dispatcher imports**

In `apps/mesh/src/api/app.ts`, remove the following import block at lines 105–115:

```typescript
import {
  gatewayWsHandlers,
  registerLinksGateway,
  type GatewayNatsAdapter,
  type WsAttachData,
} from "../links/ws-gateway";
import {
  createDispatcher,
  type DispatcherNatsAdapter,
  type DispatchFn,
} from "../links/dispatcher";
```

- [ ] **Step 4: Gut `app.ts` — remove `sharedDispatch` var and `getDispatch` export**

Remove lines 197–214 (the `sharedDispatch` module-level variable and `getDispatch` export):

```typescript
// Module-level singleton for the NATS-backed dispatcher. Populated inside
// `createApp` once `natsProvider` is wired; callers outside `createApp` (e.g.
// `dispatch-run.ts`) reach it via `getDispatch()`.
let sharedDispatch: DispatchFn | null = null;

/**
 * Return the shared NATS-backed `DispatchFn`. Throws if `createApp` hasn't
 * been called yet (shouldn't happen in production; guard is for tests that
 * bypass `createApp`).
 */
export function getDispatch(): DispatchFn {
  if (!sharedDispatch) {
    throw new Error(
      "getDispatch() called before createApp() — dispatcher not yet initialized",
    );
  }
  return sharedDispatch;
}
```

- [ ] **Step 5: Gut `app.ts` — remove `registerLinksGateway` call**

Remove lines 1788–1817 (the `registerLinksGateway(app, { ... })` call with its `validateBearer` lambda).

- [ ] **Step 6: Gut `app.ts` — remove dispatcher setup and `sharedDispatch` assignment**

Remove lines 1819–1865 (the comment block, the `dispatcherNatsAdapter` object, and the `sharedDispatch = createDispatcher(...)` assignment).

- [ ] **Step 7: Gut `app.ts` — remove `gatewayWsHandlers` re-export**

Remove line 2152:

```typescript
export { gatewayWsHandlers }
```

Also remove `WsAttachData` from any type-only export at the same location if present.

- [ ] **Step 8: Gut `index.ts` — remove gateway destructure and WS branches**

In `apps/mesh/src/index.ts`:

Remove `gatewayWsHandlers` from the destructured import on line 57:
```typescript
// Before:
const { createApp, gatewayWsHandlers } = await import("./api/app");
// After:
const { createApp } = await import("./api/app");
```

Remove the `isGatewayWsData` type guard (lines 146–152):
```typescript
function isGatewayWsData(data: unknown): data is WsAttachData {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { kind?: unknown }).kind === "gateway"
  );
}
```

Remove the three gateway branches from the `websocket` handlers. In `open` (lines 193–197):
```typescript
} else if (isGatewayWsData(ws.data)) {
  gatewayWsHandlers.open(
    ws as unknown as Parameters<typeof gatewayWsHandlers.open>[0],
  );
}
```

In `message` (lines 202–207):
```typescript
} else if (isGatewayWsData(ws.data)) {
  void gatewayWsHandlers.message(
    ws as unknown as Parameters<typeof gatewayWsHandlers.message>[0],
    message,
  );
}
```

In `close` (lines 212–215):
```typescript
} else if (isGatewayWsData(ws.data)) {
  gatewayWsHandlers.close(
    ws as unknown as Parameters<typeof gatewayWsHandlers.close>[0],
    code,
    reason,
  );
}
```

Also remove the `WsAttachData` type import from `index.ts` if it was added there.

- [ ] **Step 9: Run typecheck and tests**

```bash
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh check
bun test /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/
```

Expected: `bun run check` passes with zero type errors. `bun test` finds no test files in `src/links/` for the deleted modules (they were deleted); `link-claim-registry.test.ts` and `resolve-dispatch-target.ts` (if it has a test) pass.

- [ ] **Step 10: Format and commit**

```bash
bun run fmt
git add \
  apps/mesh/src/links/ws-gateway.ts \
  apps/mesh/src/links/ws-gateway.test.ts \
  apps/mesh/src/links/dispatcher.ts \
  apps/mesh/src/links/dispatcher.test.ts \
  apps/mesh/src/api/app.ts \
  apps/mesh/src/index.ts
git commit -m "$(cat <<'EOF'
feat(links): delete ws-gateway, dispatcher, and WS multiplexer branches

Phases A–E have rehomed all five WS traffic types to pull transport.
The NATS middle-man (links.dispatch/cancel subjects, reply-inbox map,
GW WS upgrade) is dead code. Remove it along with the getDispatch
singleton and the Bun.serve websocket gateway branches.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Delete `dispatch-frames.ts` and its test

`dispatch-frames.ts` is now unreferenced (all three importers deleted in Task 2 and Task 5).

**Files:**
- Delete: `apps/mesh/src/links/dispatch-frames.ts`, `apps/mesh/src/links/dispatch-frames.test.ts`

- [ ] **Step 1: Confirm zero remaining callers**

```bash
grep -rn "from.*dispatch-frames\|dispatchFrameSchema\|encodeFrame\|decodeFrame\|DispatchFrame\|HelloFrame\|RequestFrame\|CancelFrame\|HeadersFrame\|ChunkFrame\|EndFrame\|ErrorFrame" \
  /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/ --include="*.ts" \
  | grep -v "dispatch-frames\.ts"
```

Expected: zero lines. If any caller remains, do not delete the file — fix the caller first.

- [ ] **Step 2: Delete the files**

```bash
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/dispatch-frames.ts
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/links/dispatch-frames.test.ts
```

- [ ] **Step 3: Typecheck and lint**

```bash
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh check
bun run lint
```

Expected: no errors.

- [ ] **Step 4: Format and commit**

```bash
bun run fmt
git add \
  apps/mesh/src/links/dispatch-frames.ts \
  apps/mesh/src/links/dispatch-frames.test.ts
git commit -m "$(cat <<'EOF'
chore(links): delete dispatch-frames codec — no callers remain after WS deletion

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Remove `buildDesktopProvider` and `getDispatch` from sandbox lifecycle

`buildDesktopProvider` dynamically imports `getDispatch()` (now deleted). `resolve-provider.ts` calls it for `user-desktop` sandbox paths that Phase D routed to the pull transport.

**Files:**
- Modify: `apps/mesh/src/sandbox/lifecycle.ts`
- Modify: `apps/mesh/src/sandbox/resolve-provider.ts`

- [ ] **Step 1: Confirm callers of `buildDesktopProvider`**

```bash
grep -rn "buildDesktopProvider\|getDispatch" \
  /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/ --include="*.ts"
```

Expected callers: `sandbox/lifecycle.ts` (definition), `sandbox/resolve-provider.ts` (two call sites at lines 79 and 184), and `sandbox/resolve-provider.test.ts` (stub). No other files.

- [ ] **Step 2: Delete `buildDesktopProvider` from `lifecycle.ts`**

In `apps/mesh/src/sandbox/lifecycle.ts`, remove the entire `buildDesktopProvider` function (lines 183–207 including the JSDoc comment). Also remove the `getDispatch` dynamic import inside it (it is inlined in the function body — removing the function removes the import).

The surrounding code (`getSandboxProviderByKind` at line 210 and `getOrInitSharedRunner` above) is unaffected.

- [ ] **Step 3: Remove `buildDesktopProvider` call sites from `resolve-provider.ts`**

In `apps/mesh/src/sandbox/resolve-provider.ts`, the two call sites (lines 79 and 184) were previously:

```typescript
const provider = await buildDesktopProvider(ctx, userId);
```

Phase D replaced these with pull-transport provider construction. Remove those call sites and their surrounding dead branches; ensure the `buildDesktopProvider` import (line 39, destructured from `"./lifecycle"`) is removed if `buildDesktopProvider` is the only symbol imported from that module at that line (keep the import if other symbols from lifecycle are still used).

- [ ] **Step 4: Update `resolve-provider.test.ts` stub**

In `apps/mesh/src/sandbox/resolve-provider.test.ts`, remove the `buildDesktopSpy` mock and any test that references `buildDesktopProvider` — they test dead code. Keep all tests for live provider resolution paths.

- [ ] **Step 5: Typecheck**

```bash
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh check
bun test /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/sandbox/
```

Expected: no type errors; sandbox tests pass.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add \
  apps/mesh/src/sandbox/lifecycle.ts \
  apps/mesh/src/sandbox/resolve-provider.ts \
  apps/mesh/src/sandbox/resolve-provider.test.ts
git commit -m "$(cat <<'EOF'
chore(sandbox): delete buildDesktopProvider — user-desktop runs on pull transport (Phase D)

getDispatch() is gone; the DesktopSandboxProvider constructor's dispatch
field is no longer needed. Pull-transport provider construction in
resolve-provider.ts takes over all user-desktop paths.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Delete Daemon-Side WS (`cluster-connection.ts`, `reconnect-backoff.ts`) and Refactor `index.ts`

⚠️ **SHIPPED DAEMON — needs human review before merge**

`cluster-connection.ts` and `reconnect-backoff.ts` live in `apps/mesh/src/link-daemon/`. The `link-daemon` directory is part of the `deco link` binary shipped to users. Deleting `connectToCluster` changes the daemon's startup behavior. A human must review this task's diff before it lands in a release.

**Files:**
- Delete: `apps/mesh/src/link-daemon/cluster-connection.ts`, `apps/mesh/src/link-daemon/cluster-connection.test.ts`
- Delete: `apps/mesh/src/link-daemon/reconnect-backoff.ts`, `apps/mesh/src/link-daemon/reconnect-backoff.test.ts`
- Modify: `apps/mesh/src/link-daemon/index.ts`

- [ ] **Step 1: Confirm callers of `connectToCluster` and `computeBackoffMs`/`shouldReconnectOnClose`**

```bash
grep -rn "connectToCluster\|ClusterConnectionInput\|ClusterConnectionHandle" \
  /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/ --include="*.ts" \
  | grep -v "cluster-connection\.ts"

grep -rn "computeBackoffMs\|shouldReconnectOnClose\|reconnect-backoff" \
  /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/ --include="*.ts" \
  | grep -v "reconnect-backoff\.ts"
```

Expected: `connectToCluster` appears only in `link-daemon/index.ts` (line 183). `computeBackoffMs`/`shouldReconnectOnClose` appear only in `cluster-connection.ts`. No other callers.

- [ ] **Step 2: Refactor `link-daemon/index.ts` — remove `connectToCluster` call and WS shutdown path**

In `apps/mesh/src/link-daemon/index.ts`:

Remove the `connectToCluster` import (line 22):
```typescript
import { connectToCluster } from "./cluster-connection";
```

Remove the `wsUrl` computation block (lines 177–181):
```typescript
const wsUrl = (() => {
  const u = new URL("/api/links/connect", opts.clusterBaseUrl);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  return u.toString();
})();
```

Remove the `connectToCluster(...)` call and the `cluster` variable (lines 183–220). The `controlHandler` variable (line 175) is **kept** — it is still used by the pull-transport work handler (Phase D) and control-poll handler (Phase C).

Replace the `shutdown` function's `cluster.close()` call (lines 228–237) with just the ingress and provider teardowns (those calls stay):

```typescript
const shutdown = async (): Promise<void> => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\nShutting down…");
  try {
    await ingress.stop();
  } catch {
    /* */
  }
  try {
    await provider.shutdown();
  } catch {
    /* */
  }
  resolveStopped(0);
};
```

Remove the `cluster.closed.then(...)` sentinel (lines 251–257) that shut down the daemon on permanent WS close. In its place, the Phase C/D pull loop's own stop signal drives daemon shutdown (its `stopped` promise should be wired to `shutdown()` — follow the pattern from Phase C/D implementation, which provides `pullLoop.closed.then(() => { if (!shuttingDown) void shutdown(); })`).

Remove the `onCluster` monitor calls (`opts.monitor?.onCluster?.("linked")`, `opts.monitor?.onCluster?.("closed")`) — the `LinkDaemonMonitor` interface can retain the `onCluster` field with the Phase C/D pull loop signalling it on first successful poll and on loop stop, but the WS-specific calls are removed.

- [ ] **Step 3: Delete the four files**

```bash
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/link-daemon/cluster-connection.ts
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/link-daemon/cluster-connection.test.ts
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/link-daemon/reconnect-backoff.ts
rm /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/link-daemon/reconnect-backoff.test.ts
```

- [ ] **Step 4: Typecheck and daemon tests**

```bash
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh check
bun test /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/link-daemon/
```

Expected: no type errors; remaining daemon unit tests (`capabilities.test.ts`, `control-handler.test.ts`, `host-parser.test.ts`, `local-ingress.test.ts`, `machine-id.test.ts`, `user-desktop-provider.test.ts`) all pass.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add \
  apps/mesh/src/link-daemon/cluster-connection.ts \
  apps/mesh/src/link-daemon/cluster-connection.test.ts \
  apps/mesh/src/link-daemon/reconnect-backoff.ts \
  apps/mesh/src/link-daemon/reconnect-backoff.test.ts \
  apps/mesh/src/link-daemon/index.ts
git commit -m "$(cat <<'EOF'
feat(link-daemon): delete outbound WS (cluster-connection, reconnect-backoff)

⚠️ SHIPPED DAEMON — reviewed before merge.

The daemon's persistent WebSocket to /api/links/connect is replaced by
the pull loop (Phase D) + control poll (Phase C). No cluster→daemon push
capability is needed: all five WS traffic types now have HTTP pull homes.
connectToCluster and the reconnect loop are deleted; the daemon shuts down
on pull-loop close instead of WS close.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: knip / Final Whole-System Check

Run knip to confirm no dead exports or unused symbols remain from the deletions, then run the full type-check, lint, unit test, and e2e suites.

- [ ] **Step 1: Confirm no references to deleted modules anywhere**

```bash
grep -rn "ws-gateway\|dispatcher\|dispatch-frames\|cluster-connection\|reconnect-backoff" \
  /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/ --include="*.ts"
grep -rn "ws-gateway\|dispatcher\|dispatch-frames\|cluster-connection\|reconnect-backoff" \
  /Users/gimenes/conductor/workspaces/mesh/memphis-v7/packages/ --include="*.ts"
```

Expected: zero lines.

- [ ] **Step 2: Run knip**

```bash
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7 knip 2>&1 | head -80
```

Expected: knip reports **no new unlisted exports** introduced by this phase. Any warnings that exist must be pre-existing (not caused by Phase F) — confirm by diffing against the main-branch knip output. Do NOT suppress warnings by editing `knip.json`.

- [ ] **Step 3: Full typecheck + lint**

```bash
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7 check
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7 lint
```

Expected: both pass with zero errors.

- [ ] **Step 4: Unit tests**

```bash
bun test /Users/gimenes/conductor/workspaces/mesh/memphis-v7/apps/mesh/src/
```

Expected: all passing; the deleted test files are gone so their tests no longer run. No existing passing tests may regress.

- [ ] **Step 5: E2E suite (pull-transport paths)**

Run the Playwright e2e suite targeting the pull-transport specs added by Phases A–E:

```bash
cd /Users/gimenes/conductor/workspaces/mesh/memphis-v7
bun run --cwd=apps/mesh test:e2e link-ingest link-work link-control link-lifecycle
```

Expected: all e2e tests pass. The reverse-WS e2e tests (if any existed for `ws-gateway`) were deleted with the test files in Task 2.

- [ ] **Step 6: Format check and final commit**

```bash
bun run --cwd=/Users/gimenes/conductor/workspaces/mesh/memphis-v7 fmt:check
```

Expected: no formatting diffs. If any, run `bun run fmt` and commit:

```bash
bun run fmt
git add -p   # review any residual formatting fixes
git commit -m "$(cat <<'EOF'
chore(phase-f): final fmt pass after WS middle-man deletion

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>
EOF
)"
```

---

## Done Criteria for Phase F

- `apps/mesh/src/links/ws-gateway.ts`, `dispatcher.ts`, `dispatch-frames.ts` (and their test files) are deleted. Zero references to them remain in `apps/mesh/src/` or `packages/`.
- `apps/mesh/src/link-daemon/cluster-connection.ts` and `reconnect-backoff.ts` (and their test files) are deleted. `link-daemon/index.ts` no longer calls `connectToCluster`.
- `apps/mesh/src/api/app.ts` exports neither `getDispatch` nor `gatewayWsHandlers`. No `registerLinksGateway` call, no `sharedDispatch` singleton.
- `apps/mesh/src/index.ts` has no `isGatewayWsData` guard and no gateway branches in the `websocket` handler.
- `apps/mesh/src/sandbox/lifecycle.ts` exports no `buildDesktopProvider`. `resolve-provider.ts` has no call site for it.
- `apps/mesh/src/nats/payload-chunking.ts` is **kept** — it continues to serve `nats-stream-buffer.ts`.
- `bun run check`, `bun run lint`, `bun test`, and the pull-transport e2e suite all pass green.
- knip reports no new dead code introduced by this phase.
- The `link_transport` selector default remains `'ws'` (or whichever default Phase D set for the canary) — Phase F does not change routing defaults. The pull path is fully operational and the WS path is gone; the canary/cutover decision belongs to Phase D's feature flag, not to Phase F.

**What is NOT in Phase F:**
- Direct-NATS on the desktop (§3.10 north star) — deferred follow-up.
- Daemon-scoped short-lived credentials (H3) — deferred follow-up.
- `run-registry.ts` reaper — kept as-is (transport-agnostic, safe).
- `link-claim-registry.ts` — kept; claims are now refreshed by the pull-cycle (Phase B).
