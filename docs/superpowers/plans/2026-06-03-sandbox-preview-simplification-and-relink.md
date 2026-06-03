# Sandbox preview simplification + reactivate-on-relink — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a desktop sandbox reactivate after `Ctrl+C` + relink, recover the preview/terminal automatically, and collapse the brittle frontend preview state machine so the daemon's HTML proxy renders every "not live" state.

**Architecture:** Push all "no dev server / starting / dev-failed / no-html" rendering into the sandbox daemon's HTTP proxy + local ingress (served HTML that auto-reloads). The frontend always renders the iframe whenever a `previewUrl` exists and otherwise shows a thin "starting" placeholder. The sandbox-events SSE reconnects forever (no terminal latch). The backend re-probes a cached `user-desktop` sandbox before trusting it, so a relinked daemon respawns it.

**Tech Stack:** Bun + TypeScript, Hono (SSE), React 19 (preview UI), Bun test runner (`bun test`), Biome (`bun run fmt`).

**Spec:** `docs/superpowers/specs/2026-06-03-sandbox-preview-simplification-and-relink-design.md`

---

## Testing note (read first)

This repo has two test tiers (see `TESTING.md`): **unit** = pure logic / real-server, no mocks, no stubbed `MeshContext`; **e2e** = Playwright. Therefore:

- `packages/sandbox/**` and pure modules (`preview-state.ts`) get real **unit tests** (TDD) — Tasks 1, 2, 5.
- `apps/mesh` integration code that needs `MeshContext`/storage/`EventSource` (Tasks 3, 4, 6) is changed with complete code + a **manual verification** procedure; a full relink Playwright e2e is a follow-up (it needs a live `deco link` daemon). Do **not** add mock-based unit tests for these — that violates `TESTING.md`.

Run `bun run fmt` after every code change. Each task ends with a commit.

---

## File structure / responsibilities

| File | Responsibility | Task |
|------|----------------|------|
| `apps/mesh/src/link-daemon/local-ingress.ts` | Serve an auto-reloading "connecting" page for an unspawned handle (instead of bare 404) | 1 |
| `packages/sandbox/daemon/proxy.ts` | Serve a "no web page here" page when the dev server answers `/` with non-HTML | 2 |
| `apps/mesh/src/tools/sandbox/start.ts` | Re-probe a cached `user-desktop` sandbox before reusing it; reap + reprovision if dead | 3 |
| `apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts` | Allow auto-reap/respawn for non-ephemeral `user-desktop` branches | 3 |
| `apps/mesh/src/web/components/sandbox/hooks/sandbox-events-context.tsx` | SSE that reconnects forever; drop `terminalFailure`/suspend latches | 4 |
| `apps/mesh/src/api/routes/sandbox-events-handler.ts` | Stop emitting terminal `phase:failed` for an unreachable daemon | 4 |
| `apps/mesh/src/web/components/sandbox/preview/preview-state.ts` (+ test) | Reduce to `starting` / `suspended` / `iframe` | 5 |
| `apps/mesh/src/web/components/sandbox/preview/preview.tsx` | Always render the iframe when `previewUrl` exists; delete the dead-state cards | 5 |
| `apps/mesh/src/api/routes/sandbox-proxy.ts` | (verify only — cloud reuses the shared daemon proxy; no change) | 6 |

---

## Task 1: Ingress serves an auto-reloading "connecting" page for an unspawned handle

**Why:** With "always render the iframe", a handle that isn't spawned yet (right after relink, before respawn) must show a friendly reloading page inside the iframe, not a bare `404 "unknown handle"`.

**Files:**
- Modify: `apps/mesh/src/link-daemon/local-ingress.ts`
- Test: `apps/mesh/src/link-daemon/local-ingress.test.ts`

- [ ] **Step 1: Update the failing test for the unknown-handle HTTP case**

In `local-ingress.test.ts`, replace the existing `test("unknown handle → 404", ...)` (the HTTP one, ~lines 38–47) with:

```ts
test("unknown handle (HTTP) → 503 auto-reloading connecting page", async () => {
  ingress = await startLocalIngress({
    port: 0,
    lookupSandboxPort: () => null,
  });
  const res = await fetch(`http://127.0.0.1:${ingress.port}/`, {
    headers: { host: `nope.localhost:${ingress.port}` },
  });
  expect(res.status).toBe(503);
  expect(res.headers.get("content-type")).toContain("text/html");
  const body = await res.text();
  expect(body).toContain("Connecting to sandbox");
  expect(body).toContain("window.location.reload");
});
```

Leave `test("non-localhost host → 404", ...)` unchanged (a host with no parseable handle still 404s).

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/link-daemon/local-ingress.test.ts -t "connecting page"`
Expected: FAIL (current code returns 404, not 503 HTML).

- [ ] **Step 3: Add the connecting page and serve it for unspawned handles**

In `local-ingress.ts`, add this constant just below the imports (after `MAX_PENDING_FRAMES`):

```ts
/**
 * Served for a valid `<handle>.localhost` whose sandbox isn't spawned yet
 * (e.g. right after `deco link` relinks, before the cluster respawns it).
 * Auto-reloads so the iframe flips to the live dev server as soon as the
 * sandbox is up — no frontend state needed.
 */
const CONNECTING_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>Connecting…</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center;max-width:420px;padding:24px}h3{margin:0 0 8px}p{margin:0;font-size:14px;color:#999;line-height:1.5}</style></head><body><div><h3>Connecting to sandbox…</h3><p>Waiting for the local sandbox to come online. This page refreshes automatically.</p></div><script>setTimeout(function(){window.location.reload()},1500)</script></body></html>`;
```

Then change the unknown-handle branch in `fetch` (currently `if (!sandboxPort) return new Response("unknown handle", { status: 404 });`). Keep the WS-upgrade failure path returning 404, but serve the page for normal HTTP:

```ts
const sandboxPort = input.lookupSandboxPort(handle);
if (!sandboxPort) {
  // WebSocket upgrades can't render HTML — fail them so the client retries.
  if (req.headers.get("upgrade") === "websocket") {
    return new Response("unknown handle", { status: 404 });
  }
  return new Response(CONNECTING_HTML, {
    status: 503,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Retry-After": "1",
    },
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/link-daemon/local-ingress.test.ts`
Expected: PASS (all cases, including the unchanged WS + non-localhost tests).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/link-daemon/local-ingress.ts apps/mesh/src/link-daemon/local-ingress.test.ts
git commit -m "feat(link-daemon): ingress serves auto-reloading connecting page for unspawned handle"
```

---

## Task 2: Daemon proxy serves a "no web page" fallback for non-HTML root

**Why:** We delete the frontend `no-html` card. When the dev server is up but answers `/` with non-HTML (e.g. a JSON API), the daemon proxy should render a friendly page instead of passing raw JSON into the iframe. Non-`/` paths still pass through unchanged (assets/API calls the app makes).

**Files:**
- Modify: `packages/sandbox/daemon/proxy.ts`
- Test: `packages/sandbox/daemon/proxy.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create `packages/sandbox/daemon/proxy.test.ts` (or append a `describe` if it exists):

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { makeProxyHandler } from "./proxy";

const noopBroadcaster = {
  broadcastChunk: () => {},
} as unknown as Parameters<typeof makeProxyHandler>[0]["broadcaster"];

let upstream: ReturnType<typeof Bun.serve> | null = null;
afterEach(() => {
  upstream?.stop(true);
  upstream = null;
});

describe("daemon proxy no-html fallback", () => {
  test("non-HTML at / → friendly 'no web page' HTML", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const handler = makeProxyHandler({
      broadcaster: noopBroadcaster,
      getDevPort: () => upstream!.port ?? null,
    });
    const res = await handler(new Request("http://x.localhost/"));
    expect(res.headers.get("content-type")).toContain("text/html");
    const body = await res.text();
    expect(body).toContain("No web page");
  });

  test("non-HTML at a sub-path passes through untouched", async () => {
    upstream = Bun.serve({
      port: 0,
      fetch: () =>
        new Response(JSON.stringify({ ok: true }), {
          headers: { "content-type": "application/json" },
        }),
    });
    const handler = makeProxyHandler({
      broadcaster: noopBroadcaster,
      getDevPort: () => upstream!.port ?? null,
    });
    const res = await handler(new Request("http://x.localhost/api/data"));
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.text()).toBe('{"ok":true}');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/sandbox/daemon/proxy.test.ts -t "no-html fallback"`
Expected: FAIL on the first case (proxy currently passes raw JSON through for `/`).

- [ ] **Step 3: Add the no-html fallback for the root path**

In `proxy.ts`, add this constant next to `NO_UPSTREAM_HTML`:

```ts
const NO_WEB_PAGE_HTML = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>No web page</title><style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#fafafa;color:#555}div{text-align:center;max-width:420px;padding:24px}h3{margin:0 0 8px}p{margin:0;font-size:14px;color:#999;line-height:1.5}code{background:#eee;padding:2px 6px;border-radius:4px;font-size:13px;color:#333}</style></head><body><div><h3>No web page at this URL</h3><p>The dev server is running but doesn't serve HTML at <code>/</code>. The preview only renders web pages — open the logs to see what's running.</p></div></body></html>`;
```

In the success path, where the upstream content-type is inspected (currently `const ct = (upstream.headers.get("content-type") ?? "").toLowerCase(); if (ct.includes("text/html")) { ... }`), add a root-path fallback **before** the final pass-through `return new Response(upstream.body, ...)`:

```ts
const ct = (upstream.headers.get("content-type") ?? "").toLowerCase();
if (ct.includes("text/html")) {
  respHeaders.delete("content-length");
  let html = await upstream.text();
  const idx = html.lastIndexOf("</body>");
  html =
    idx !== -1
      ? html.slice(0, idx) + BOOTSTRAP_SCRIPT + html.slice(idx)
      : html + BOOTSTRAP_SCRIPT;
  return new Response(html, {
    status: upstream.status,
    headers: respHeaders,
  });
}
// Root document that isn't HTML: render the dedicated "no web page" notice
// instead of dumping raw JSON/text into the iframe. Sub-paths (assets, API
// calls the app makes) pass through untouched.
if (url.pathname === "/") {
  try {
    await upstream.body?.cancel();
  } catch {
    /* ignore */
  }
  return new Response(NO_WEB_PAGE_HTML, {
    status: 200,
    headers: {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    },
  });
}
return new Response(upstream.body, {
  status: upstream.status,
  headers: respHeaders,
});
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test packages/sandbox/daemon/proxy.test.ts`
Expected: PASS (both cases).

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add packages/sandbox/daemon/proxy.ts packages/sandbox/daemon/proxy.test.ts
git commit -m "feat(sandbox-daemon): proxy renders 'no web page' fallback for non-HTML root"
```

---

## Task 3: Backend reactivates the sandbox on relink

**Why (root cause #1):** `ensureSandbox` returns the cached `sandboxMap` entry without calling `runner.ensure()`, so a relinked (empty) daemon never respawns the sandbox; the stale handle persists because `invalidateHandle` is a no-op for non-ephemeral branches. We re-probe the cached `user-desktop` entry and reap+reprovision when it's dead, and we allow the proxy-failure auto-reap to run for `user-desktop` branches.

**Files:**
- Modify: `apps/mesh/src/tools/sandbox/start.ts` (`ensureSandbox`, ~lines 166–229)
- Modify: `apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts` (`canAutoRestart`, ~line 213)

- [ ] **Step 1: Confirm the desktop provider already respawns on a dead probe (no provider change)**

This task does **not** change the desktop provider — `runner.ensure()` already does the correct probe→404→respawn. It only stops `ensureSandbox` from bypassing it. Verify that behavior is locked in: read `packages/sandbox/server/provider/desktop/runner.ts` `ensure()` (lines 83–177) and `runner.test.ts`, and confirm a test exists whose acceptance criteria are: given a persisted state-store record whose `probeHealth` (GET `/api/sandboxes/<handle>`) returns a non-2xx, `ensure` deletes the state-store row and dispatches `POST /api/sandboxes` exactly once. If that coverage is missing, add one test to `runner.test.ts` matching the file's existing fake-`dispatch` + fake-`stateStore` setup (use those existing fakes; assert `deleteByHandle` was called and a single `POST /api/sandboxes` dispatch occurred).

Run: `bun test packages/sandbox/server/provider/desktop/runner.test.ts`
Expected: PASS.

- [ ] **Step 2: Re-probe the cached `user-desktop` entry in `ensureSandbox`**

In `start.ts`, replace the fast-path block (currently):

```ts
  // Fast path: sandboxMap already has an entry under the requested kind.
  // No reap needed: with kind in the key, there's no stale-kind entry to
  // tear down. Different kinds coexist as siblings.
  if (existing) {
    return existing;
  }

  // ensureSandbox is called from the always-on VM tools path which doesn't
  // pre-resolve the runner. ...
  const { provider: runner } = await resolveSandboxProvider(ctx, {
    userId,
    branch: input.branch,
    virtualMcpMetadata: metadata,
    explicitKind: providerKind,
  });
```

with:

```ts
  // Resolve the runner up front: for user-desktop we must verify the cached
  // entry against the live daemon before trusting it (the daemon may have
  // restarted via `deco link` relink, leaving the sandboxMap pointing at a
  // dead handle). resolveSandboxProvider is cheap and idempotent.
  const { provider: runner } = await resolveSandboxProvider(ctx, {
    userId,
    branch: input.branch,
    virtualMcpMetadata: metadata,
    explicitKind: providerKind,
  });

  // Fast path: trust a cluster entry directly. For user-desktop, probe the
  // daemon first — a relinked daemon has an empty sandbox map and answers the
  // liveness probe with 404, which means we must reap the stale entry and
  // re-provision (runner.ensure spawns a fresh sandbox on the new daemon).
  if (existing) {
    if (providerKind !== "user-desktop") return existing;
    const alive = await runner
      .alive(existing.sandboxHandle)
      .catch(() => false);
    if (alive) return existing;
    await removeSandboxMapEntry(
      ctx.storage.virtualMcps,
      input.virtualMcpId,
      userId,
      userId,
      input.branch,
      providerKind,
    ).catch((err) => {
      console.warn("[ensureSandbox] failed to reap stale user-desktop entry", err);
    });
  }
```

Add the import at the top of `start.ts` (it already imports from `./sandbox-map`; extend that import):

```ts
import { readSandboxMap, resolveVm, removeSandboxMapEntry } from "./sandbox-map";
```

(If `start.ts` imports `readSandboxMap`/`resolveVm` from `./sandbox-map` on separate lines, add `removeSandboxMapEntry` to the existing import. Verify `removeSandboxMapEntry` is exported from `apps/mesh/src/tools/sandbox/sandbox-map.ts` — it is used by `built-in-tools/index.ts`.)

- [ ] **Step 3: Allow auto-reap/respawn for `user-desktop` non-ephemeral branches**

In `built-in-tools/index.ts`, change (line ~213):

```ts
const canAutoRestart = vmContext.branch === "ephemeral";
```

to:

```ts
// Ephemeral agents have no restart button, so the call layer auto-restarts on
// proxy failure. user-desktop sandboxes also auto-restart: the local daemon
// can drop/relink under the user at any time, and the iframe + ingress already
// render the reconnecting state, so a dead-daemon proxy error should reap +
// respawn rather than surface a sticky failure.
const canAutoRestart =
  vmContext.branch === "ephemeral" || providerKind === "user-desktop";
```

(`providerKind` is already in scope from the `resolveSandboxProvider` destructure above this line.)

- [ ] **Step 4: Type-check**

Run: `bun run check`
Expected: PASS (no type errors in `start.ts` / `built-in-tools/index.ts`).

- [ ] **Step 5: Manual verification (relink reactivation)**

1. `bun run dev`, sign in, open a GitHub-linked PROJECT.
2. In a terminal: `bunx decocms link` → confirm the sandbox shows under the PROJECT and the preview loads.
3. `Ctrl+C` the link. Preview shows the browser connection-refused page (expected).
4. `bunx decocms link` again.
5. Send a chat message that touches the sandbox (or wait for self-heal).
6. **Expect:** the `deco link` terminal logs a fresh `[user-desktop] ensure … spawn …`, the sandbox respawns, and the preview/terminal resume. Before this fix, no respawn happened.

- [ ] **Step 6: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/tools/sandbox/start.ts apps/mesh/src/harnesses/decopilot/built-in-tools/index.ts packages/sandbox/server/provider/desktop/runner.test.ts
git commit -m "fix(sandbox): re-probe and respawn cached user-desktop sandbox on relink"
```

---

## Task 4: SSE reconnects forever (no terminal latch)

**Why (root cause #2):** A `phase:failed` from an unreachable daemon latches `terminalFailure` and kills all reconnects; the stream never recovers on relink. We make the client reconnect indefinitely and stop the server emitting a terminal failure for mere unreachability.

**Files:**
- Modify: `apps/mesh/src/web/components/sandbox/hooks/sandbox-events-context.tsx`
- Modify: `apps/mesh/src/api/routes/sandbox-events-handler.ts`

- [ ] **Step 1 (server): stop emitting terminal `phase:failed` for an unreachable daemon**

In `sandbox-events-handler.ts` → `proxyDaemonEvents`, the catch block that exhausts the open-retry budget currently writes `event: phase {kind:"failed", …}` and returns. Replace **both** terminal `phase:failed` emissions in `proxyDaemonEvents` (the `catch` budget-exhausted branch ~lines 259–270, and the `!attempt.ok` branch ~lines 287–304) with a plain `return;` so the SSE response ends and the client reconnects. Concretely, the `catch` becomes:

```ts
    } catch (err) {
      if (signal.aborted) return;
      if (Date.now() - openedAt < PROXY_OPEN_RETRY_BUDGET_MS) {
        await delay(PROXY_OPEN_RETRY_DELAY_MS, { signal }).catch(() => {});
        continue;
      }
      // Daemon unreachable past the budget. Don't emit a terminal failure —
      // end the stream so the client's EventSource reconnects (it will pick
      // up logs / `gone` once the link is back). Latching here is what froze
      // the preview across a `deco link` relink.
      return;
    }
```

and the non-ok branch becomes:

```ts
    if (!attempt.ok || !attempt.body) {
      try {
        await attempt.body?.cancel();
      } catch {
        /* ignore */
      }
      // Transient upstream error — end the stream and let the client reconnect.
      return;
    }
```

Leave the `attempt.status === 404` → `event: gone` path unchanged (that drives self-heal). In `emitLifecycle`, change the `watchdogTimer` (the `claim-never-created` `phase:failed` at ~lines 202–216) to `settle(false)` **without** writing the terminal `failed` phase:

```ts
    const watchdogTimer = setTimeout(() => {
      if (claimSeen || settled) return;
      // No claim within budget — end the lifecycle phase quietly and let the
      // proxy phase (and client reconnect) take over instead of latching a
      // terminal failure in the UI.
      settle(false);
    }, NO_CLAIM_MAX_MS);
```

- [ ] **Step 2 (client): remove the `terminalFailure` and suspend latches**

In `sandbox-events-context.tsx`:

1. Delete the `terminalFailure` machinery. Remove `let terminalFailure = false;` (~line 205). In `handleClaimPhase`, remove the `if (next.kind === "failed") { terminalFailure = true; es?.close(); }` block — keep `setPhase(next)` and the `if (next.kind !== "failed") setNotFound(false)` line. In `connect()` remove `if (disposed || terminalFailure) return;` → `if (disposed) return;`. In `es.onerror` remove the `if (terminalFailure) return;` guard. In `scheduleReconnect` remove `|| terminalFailure` from the early-return.

2. Delete the suspend timer + `suspended` state (per design we no longer surface SSE-silence as a UI state). Remove: the `suspended` `useState`, `SUSPENDED_AFTER_ERROR_MS`, `enterSuspendTimerIfIdle`, `clearSuspendTimer`, the `suspendTimer` variable, the `setSuspended` calls in `es.onopen`, and the `enterSuspendTimerIfIdle()` call in `es.onerror`. Remove `suspended` from `SandboxEventsValue`, `DEFAULT_VALUE`, and the `value` object. (Consumers updated in Task 5.)

The resulting `es.onerror` is simply:

```ts
      es.onerror = () => {
        if (es?.readyState !== EventSource.CLOSED) return;
        scheduleReconnect();
      };
```

and `es.onopen`:

```ts
      es.onopen = () => {
        reconnectAttempt = 0;
      };
```

- [ ] **Step 3: Type-check**

Run: `bun run check`
Expected: errors only where `vmEvents.suspended` is still referenced in `preview.tsx` (resolved in Task 5). If you do Task 5 in the same branch, the final `bun run check` is green; otherwise temporarily leave `suspended: false` in the context value to keep the build green between tasks. Prefer doing Task 5 next.

- [ ] **Step 4: Manual verification (SSE recovers)**

1. With a linked sandbox + open preview, watch the Network tab's `…/events` EventSource.
2. `Ctrl+C` the link. The stream errors and keeps **retrying** (no permanent CLOSED).
3. `bunx decocms link` again → the stream reconnects on its own and resumes emitting logs/lifecycle (terminal repopulates). Before this fix it stayed dead.

- [ ] **Step 5: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sandbox/hooks/sandbox-events-context.tsx apps/mesh/src/api/routes/sandbox-events-handler.ts
git commit -m "fix(sandbox): keep sandbox-events SSE reconnecting; drop terminal failure latch"
```

---

## Task 5: Collapse the frontend preview state machine

**Why:** Reduce 8 latched states to 3 (`starting` / `suspended` / `iframe`); always render the iframe when a `previewUrl` exists so the daemon's served HTML is the source of truth.

**Files:**
- Modify: `apps/mesh/src/web/components/sandbox/preview/preview-state.ts`
- Modify: `apps/mesh/src/web/components/sandbox/preview/preview-state.test.ts`
- Modify: `apps/mesh/src/web/components/sandbox/preview/preview.tsx`

- [ ] **Step 1: Rewrite the pure state test for the reduced model**

Replace the entire body of `preview-state.test.ts` with:

```ts
import { describe, expect, test } from "bun:test";
import { computePreviewState } from "./preview-state";
import type { PreviewStateInput } from "./preview-state";

const base: PreviewStateInput = {
  previewUrl: "http://localhost:5173",
  appPaused: false,
  userStopped: false,
};

describe("computePreviewState", () => {
  test("previewUrl present → iframe", () => {
    expect(computePreviewState(base)).toEqual({
      kind: "iframe",
      previewUrl: "http://localhost:5173",
    });
  });

  test("no previewUrl → starting", () => {
    expect(computePreviewState({ ...base, previewUrl: null })).toEqual({
      kind: "starting",
    });
  });

  test("appPaused → suspended (even with a previewUrl)", () => {
    expect(computePreviewState({ ...base, appPaused: true })).toEqual({
      kind: "suspended",
    });
  });

  test("userStopped → suspended (even with a previewUrl)", () => {
    expect(computePreviewState({ ...base, userStopped: true })).toEqual({
      kind: "suspended",
    });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test apps/mesh/src/web/components/sandbox/preview/preview-state.test.ts`
Expected: FAIL (old `computePreviewState` signature/states).

- [ ] **Step 3: Reduce `preview-state.ts`**

Replace the entire contents of `preview-state.ts` with:

```ts
/**
 * Pure preview-state decision. Collapsed model: the sandbox daemon's HTTP
 * proxy renders every "not live" case (no dev server, starting, dev crashed,
 * no web page) as served HTML, so the frontend only needs:
 *
 *   suspended → starting → iframe
 *
 * `iframe` is shown whenever a previewUrl exists; whatever the daemon serves
 * (live app, "connecting", "no dev server", "no web page", or the raw browser
 * connection-refused page when the link is down) is the displayed state.
 */

export interface PreviewStateInput {
  previewUrl: string | null;
  /** Daemon reported its app as paused. */
  appPaused: boolean;
  /** User explicitly stopped the sandbox. */
  userStopped: boolean;
}

export type PreviewState =
  | { kind: "starting" }
  | { kind: "suspended" }
  | { kind: "iframe"; previewUrl: string };

export function computePreviewState(input: PreviewStateInput): PreviewState {
  if (input.appPaused || input.userStopped) return { kind: "suspended" };
  if (!input.previewUrl) return { kind: "starting" };
  return { kind: "iframe", previewUrl: input.previewUrl };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `bun test apps/mesh/src/web/components/sandbox/preview/preview-state.test.ts`
Expected: PASS.

- [ ] **Step 5: Update `preview.tsx` — state derivation**

In `preview.tsx`:

1. Reduce the `computePreviewState` call (the block at ~lines 328–341) to:

```ts
  const previewState = computePreviewState({
    previewUrl,
    appPaused,
    userStopped,
  });
```

2. Delete the now-unused derivations feeding the old inputs: `htmlSupportRef` + `hasHtmlPreview` (and the render-time write at ~lines 260–265), `upstreamStatus` (~266–271), `suspended` (the `vmEvents.suspended` read at ~272), `lifecycleFailure` + `lifecycleFailureError` (~317–326). Remove their imports if they become unused (`LifecycleFailure`). Keep `appPaused` (`vmEvents.status.state === "paused"`), `userStopped`, `claimPhase` (still used by `progress`/`daemonReady`), `vmStartPending` (still used by the drawer + `daemonReady`), and `vmEvents.notFound` (still used by self-heal `deadVmId`).

3. `iframeSrc` (~lines 343–346) stays gated on `previewState.kind === "iframe"` — no change needed beyond the new union.

- [ ] **Step 6: Update `preview.tsx` — auto-start / self-heal gating**

Remove the `!lastStartError` gate so a transient SANDBOX_START error can't permanently block provisioning:

- In `shouldAutoStart` (~lines 425–435), delete the `!lastStartError &&` line.
- In the self-heal effect (~lines 446–455), change `if (lastStartError || startVm.isPending) return;` to `if (startVm.isPending) return;`.
- `lastStartError` is no longer used for rendering; keep `const lastStartError = startVm.error?.message ?? null;` only if still referenced (e.g. the `onError` log) — otherwise delete the binding. Confirm with `bun run check`.

- [ ] **Step 7: Update `preview.tsx` — render blocks**

In the render body (`<div className="flex-1 relative overflow-hidden">`, ~line 1089):

1. **Delete** these blocks entirely (anchor on the JSX condition; they no longer compile):
   - `{previewState.kind === "never-started" && ( … )}`
   - `{previewState.kind === "starting-now" && … }`
   - `{previewState.kind === "errored" && ( … )}`
   - `{previewState.kind === "dev-script-failed" && … }`
   - `{previewState.kind === "crashed" && ( … )}`
   - `{previewState.kind === "no-html" && ( … )}`
2. **Replace** the deleted `never-started` + `starting-now` cards with one starting placeholder:

```tsx
          {previewState.kind === "starting" && (
            <div className="absolute inset-0 z-30">
              <SandboxStateCard
                kind="starting-now"
                progress={progress}
                claimPhase={claimPhase}
              />
            </div>
          )}
```

3. Keep the `suspended` block but point it at the new kind (it already reads `previewState.kind === "suspended"`).
4. The `iframe` block (`{previewState.kind === "iframe" && iframeSrc && ( <iframe …/> )}`) stays as-is.
5. Update remaining `previewState.kind` comparisons elsewhere in the file to the new union: occurrences of `"no-html"`, `"crashed"`, `"never-started"`, `"errored"`, `"dev-script-failed"`, `"starting-now"` must be removed or remapped. Specifically:
   - The `drawerStatusFromPreview(previewState, vmStartPending)` helper and `iframeDocStatus` (~lines 115–121, 344–351, 385) — simplify any `kind === "iframe" || kind === "no-html" || kind === "crashed"` to just `kind === "iframe"`, and `kind === "starting-now"` to `kind === "starting"`. Open `drawerStatusFromPreview` and `effectiveViewMode`/`daemonReady` derivations and update each comparison to the 3-kind union.
   - `previewState.kind === "never-started"` at ~line 491 (`drawerOpenEffective`) → replace with `previewState.kind === "starting"`.

- [ ] **Step 8: Remove dead `SandboxStateCard` kinds (optional cleanup)**

If `SandboxStateCard` now has unreachable `kind` props (`errored`, `dev-script-failed`, `crashed`, `never-started`), and knip flags them, delete those branches from the card component. Run `bun run lint` and remove what it flags as unused — do **not** suppress knip.

- [ ] **Step 9: Type-check, lint, unit tests**

Run: `bun run check && bun run lint && bun test apps/mesh/src/web/components/sandbox/preview/preview-state.test.ts`
Expected: all PASS, no unused-symbol warnings.

- [ ] **Step 10: Manual verification (UI simplification + dev-fail recovery)**

1. Start a sandbox; confirm the iframe renders normally.
2. In the sandbox terminal, kill the dev server → the iframe shows the daemon's auto-reloading "No dev server" page (no frontend `dev:x` card).
3. Restart the dev server → the iframe auto-reloads into the live app. Nothing sticky.
4. Confirm there is no path that renders the old `errored` / `dev-script-failed` / `crashed` / `no-html` cards.

- [ ] **Step 11: Format and commit**

```bash
bun run fmt
git add apps/mesh/src/web/components/sandbox/preview/
git commit -m "refactor(preview): collapse preview state machine to starting/suspended/iframe"
```

---

## Task 6: Cloud-sandbox parity (verify shared proxy; scope follow-up)

**Why / correction to spec:** The spec assumed the cluster proxy serves the iframe document and needs a mirrored fallback. Investigation shows it does **not**: `apps/mesh/src/api/routes/sandbox-proxy.ts` only serves file/exec/config/git/events/preview-fetch routes. The cloud iframe loads `runner.getPreviewUrl()`, which routes through the agent-sandbox ingress into the **same** `packages/sandbox/daemon/proxy.ts`. So Tasks 1–2's `NO_UPSTREAM_HTML` / "Server is starting…" / `NO_WEB_PAGE_HTML` fallbacks already apply to cloud sandboxes for the dev-server states. No change to `sandbox-proxy.ts` is required.

- [ ] **Step 1: Verify the shared-proxy assumption**

Confirm that a cloud sandbox's `previewUrl` (from `runner.getPreviewUrl(claimName)`, `sandbox-proxy.ts:514`) resolves into the agent-sandbox-served `packages/sandbox/daemon/proxy.ts`. Grep the agent-sandbox provider for where the daemon proxy/`makeProxyHandler` is mounted (`packages/sandbox/server/provider/agent-sandbox/`). Record the path in the PR description. If — and only if — the cloud preview path does **not** go through `proxy.ts`, escalate: that is a larger change and should be split into its own plan, not bolted on here.

- [ ] **Step 2: Note the one cloud-only gap as an explicit follow-up**

The desktop "unspawned/evicted handle → connecting page" (Task 1, in `local-ingress.ts`) has no cloud equivalent in this plan: for cloud, an un-provisioned handle is handled by the agent-sandbox ingress / k8s service, which is out of scope. Add a `TODO(follow-up)` note to the PR description: "cloud unspawned-handle connecting page lives in the agent-sandbox ingress; track separately." Do **not** implement it here.

- [ ] **Step 3: Manual verification (cloud)**

With a **cloud** sandbox (no `deco link`): kill its dev server and confirm the iframe shows the daemon proxy's auto-reloading "No dev server" page, and a non-HTML root shows "No web page" — i.e. Tasks 1–2 cover cloud for free. No commit (verification only).

---

## Final verification

- [ ] `bun run fmt:check && bun run check && bun run lint`
- [ ] `bun test packages/sandbox/ apps/mesh/src/link-daemon/ apps/mesh/src/web/components/sandbox/preview/`
- [ ] End-to-end manual run of both user scenarios:
  - link → Ctrl+C → relink → message → preview + terminal resume (Tasks 1, 3, 4).
  - dev fail → restart → preview recovers, no sticky card (Tasks 2, 5).
