/**
 * Unified VM events SSE.
 *
 * Single browser-facing stream for everything happening to a sandbox keyed
 * on (virtualMcpId, branch, callerUserId):
 *
 *   1. Pre-Ready lifecycle phases (`event: phase`) — surfaces the gap between
 *      VM_START posting a SandboxClaim and the daemon coming online.
 *      Agent-sandbox runner emits real K8s phases; other runners emit a
 *      single synthetic `ready`.
 *   2. Daemon events (`event: log|status|scripts|processes|reload|branch-status`)
 *      — proxied from the in-pod daemon's `/_decopilot_vm/events` SSE once
 *      lifecycle reaches `ready`. Wire format is preserved verbatim by raw
 *      byte-piping the upstream body, so daemon and client speak the same
 *      protocol they always have.
 *   3. `event: gone` — synthetic. Mesh's upstream daemon fetch returned 404
 *      (sandbox handle missing → operator evicted on idle TTL, etc). Client
 *      maps to `notFound` and triggers self-heal via VM_START.
 *   4. `event: keepalive` — heartbeat. 15s matches the existing daemon SSE.
 *
 * Auth model:
 *   - Caller must be authenticated.
 *   - Caller's organization must own the requested virtualMcp.
 *   - Claim name is derived deterministically from
 *     (orgId, virtualMcpId, branch, callerUserId), so a caller only sees
 *     events for *their own* sandbox; another user in the same org would
 *     compute a different handle.
 *
 * Why one stream instead of two: prior design had the browser open
 * `/api/vm-lifecycle` (mesh) plus a direct EventSource to the daemon's public
 * `/_decopilot_vm/events`. The daemon endpoint is unauthenticated (Vercel-style
 * "URL is the secret") and putting two long-lived SSEs in every tab burned
 * the EventSource budget. Routing through mesh authenticates the surface and
 * collapses to one connection per session.
 */

import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import {
  composeSandboxRef,
  resolveRunnerKindFromEnv,
} from "@decocms/sandbox/runner";
import type { ClaimPhase } from "@decocms/sandbox/runner";
import { computeClaimHandle } from "../../sandbox/claim-handle";
import {
  getOrInitSharedRunner,
  subscribeLifecycle,
} from "../../sandbox/lifecycle";
import {
  getUserId,
  requireAuth,
  requireOrganization,
  type MeshContext,
} from "../../core/mesh-context";
import { KyselySandboxRunnerStateStore } from "../../storage/sandbox-runner-state";
import { readVmMap, resolveVm } from "../../tools/vm/vm-map";
import type { Env } from "../hono-env";

/**
 * Cap on how long we keep the SSE open if a claim never materializes (e.g.
 * caller raced VM_START but VM_START failed before `createSandboxClaim`).
 * 90s is enough to absorb karpenter cold-start (~60–90s) plus a few seconds
 * of operator latency; longer waits indicate VM_START never posted the claim
 * and the user benefits from a faster failure surface so the retry button
 * appears promptly.
 */
const NO_CLAIM_MAX_MS = 90_000;

const HEARTBEAT_MS = 15_000;

export const createVmEventsRoutes = () => {
  const app = new Hono<Env>();
  app.get("/", async (c) => {
    const ctx = c.var.meshContext;
    try {
      requireAuth(ctx);
    } catch {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const userId = getUserId(ctx);
    if (!userId) {
      return c.json({ error: "Unauthorized" }, 401);
    }

    let organization: ReturnType<typeof requireOrganization>;
    try {
      organization = requireOrganization(ctx);
    } catch {
      return c.json({ error: "Organization scope required" }, 403);
    }

    const virtualMcpId = c.req.query("virtualMcpId");
    const branch = c.req.query("branch");
    if (!virtualMcpId || !branch) {
      return c.json({ error: "virtualMcpId and branch are required" }, 400);
    }

    // Verify caller's org actually owns this virtualMcp. Without this check,
    // an authenticated user could probe arbitrary virtualMcpIds — the claim
    // hash includes their userId so they couldn't *observe* anyone else's
    // events, but the 404 vs not-yet-created surface would still leak
    // existence/identity information.
    const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
    if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
      return c.json({ error: "Virtual MCP not found" }, 404);
    }

    const projectRef = composeSandboxRef({
      orgId: organization.id,
      virtualMcpId,
      branch,
    });
    const claimName = computeClaimHandle({ userId, projectRef }, branch);
    const runnerKind = resolveRunnerKindFromEnv();

    // Snapshot vmMap from the same metadata read used for the org-ownership
    // check. Used below to gate the stale-handle probe: we only run it when
    // this user already had a vmMap entry pointing at *this exact* claim.
    // The vmId-match guard avoids racing VM_START's claim-creation window
    // (~250ms–1.2s for agent-sandbox before `createSandboxClaim` lands;
    // similar window for host/docker between `runner.ensure` returning and
    // `setVmMapEntry` writing the row). Without it, an SSE that opens during
    // that window would observe alive=false and emit a spurious `gone`.
    const existingVmEntry = resolveVm(
      readVmMap(virtualMcp.metadata as Record<string, unknown> | null),
      userId,
      branch,
    );
    const expectingHandle = existingVmEntry?.vmId === claimName;
    const existingRunnerKind = existingVmEntry?.runnerKind ?? null;

    const runner = await getOrInitSharedRunner();

    // No runner configured at all → can't proxy daemon SSE. Surface a failed
    // phase rather than a silent close so the UI shows a meaningful error.
    if (!runner) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "phase",
          data: JSON.stringify({
            kind: "failed",
            reason: "unknown",
            message: "No sandbox runner configured on this mesh.",
          } satisfies ClaimPhase),
        });
      });
    }

    c.header("X-Accel-Buffering", "no");
    c.header("Content-Encoding", "identity");

    return streamSSE(c, async (stream) => {
      const abortCtl = new AbortController();
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: "keepalive", data: "" }).catch(() => {
          clearInterval(heartbeat);
        });
      }, HEARTBEAT_MS);
      stream.onAbort(() => {
        abortCtl.abort();
        clearInterval(heartbeat);
      });

      try {
        // Same probe for every runner. `runner.alive` is honest across
        // host/docker/freestyle/agent-sandbox: each implementation queries
        // its respective source-of-truth (state-store + pid for host, docker
        // inspect, K8s API, freestyle daemon HTTP). When the prior vmMap
        // entry's runner kind differs from the env's current runner, we
        // route the stale-state cleanup through the *prior* kind so we
        // don't leave behind rows in the wrong table.
        if (expectingHandle) {
          const stale = await isStaleHandle(runner, claimName);
          if (stale) {
            await cleanupStaleEntry({
              ctx,
              runner,
              claimName,
              userId,
              projectRef,
              runnerKind: existingRunnerKind ?? runnerKind,
            });
            await stream.writeSSE({ event: "gone", data: "" }).catch(() => {});
            return;
          }
        }

        // ---- Phase 1: lifecycle (pre-Ready) ---------------------------------
        const lifecycleOk = await emitLifecycle({
          stream,
          claimName,
          runner,
          signal: abortCtl.signal,
        });
        if (!lifecycleOk || abortCtl.signal.aborted) return;

        // ---- Phase 2: daemon SSE proxy --------------------------------------
        await proxyDaemonEvents({
          stream,
          runner,
          claimName,
          signal: abortCtl.signal,
        });
      } finally {
        clearInterval(heartbeat);
      }
    });
  });
  return app;
};

async function isStaleHandle(
  runner: NonNullable<Awaited<ReturnType<typeof getOrInitSharedRunner>>>,
  claimName: string,
): Promise<boolean> {
  try {
    const exists = await runner.alive(claimName);
    return !exists;
  } catch (err) {
    console.warn(
      `[vm-events] alive probe failed for ${claimName}; assuming alive: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return false;
  }
}

/**
 * Drop the stale in-memory record (closes its port-forward) AND the
 * state-store row, so the next VM_START's `runner.ensure` skips the
 * rehydrate path (which would chase a dead port-forward and timeout) and
 * falls through to fresh provision. The state-store delete alone wasn't
 * enough — when `runner.alive` returns false because the operator's
 * housekeeper reaped the claim out from under us, mesh's `records` map
 * still held the K8sRecord pointing at the now-deleted pod, and the
 * deterministic preview port stayed bound to that dead pod's WS forwarder
 * until process restart. Calling `runner.delete` invalidates both.
 *
 * `runner.delete` is idempotent: it 404-tolerantly tries to delete the
 * SandboxClaim, closes any forwarder, drops in-memory + state-store rows.
 * The runner-kind dispatch matches the *prior* kind (existingRunnerKind)
 * so we don't leave behind rows in the wrong table when the env's runner
 * has flipped between starts and stops.
 *
 * We deliberately do NOT touch the vmMap entry. Two reasons:
 *   1. `runner.ensure` resumes from the state-store, not vmMap — vmMap is
 *      informational metadata read by tools/UI, never the source of truth
 *      for provisioning.
 *   2. Removing it here would race with a concurrent VM_START's
 *      `setVmMapEntry` on the same metadata JSON column (read-modify-write
 *      is not atomic; see vm-map.ts). The next VM_START overwrites the
 *      entry with a fresh one anyway — the `vmId` is deterministic
 *      (computeHandle), so the entry's identity is stable across
 *      reprovisions.
 *
 * Failures are logged, not thrown — the user-visible flow (emit `gone` →
 * browser self-heal) is what matters; this is a fast-path optimisation.
 */
async function cleanupStaleEntry(args: {
  ctx: MeshContext;
  runner: NonNullable<Awaited<ReturnType<typeof getOrInitSharedRunner>>>;
  claimName: string;
  userId: string;
  projectRef: string;
  runnerKind: "host" | "docker" | "freestyle" | "agent-sandbox";
}): Promise<void> {
  const { ctx, runner, claimName, userId, projectRef, runnerKind } = args;
  try {
    await runner.delete(claimName);
  } catch (err) {
    console.warn(
      `[vm-events] runner.delete failed for ${claimName}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    const stateStore = new KyselySandboxRunnerStateStore(ctx.db);
    await stateStore.delete({ userId, projectRef }, runnerKind);
  } catch (err) {
    console.warn(
      `[vm-events] sandbox_runner_state delete failed for ${userId}/${projectRef}/${runnerKind}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

/**
 * Drives the lifecycle phase stream until a terminal phase. Returns `true` if
 * the terminal phase was `ready` (caller proceeds to daemon proxy), `false`
 * otherwise (failed, aborted, or watchdog-tripped).
 *
 * Subscribes via `subscribeLifecycle` so multiple SSE clients for the same
 * claim (multi-tab) share one underlying source. For agent-sandbox the source
 * is the K8s watcher; for host/docker/freestyle the source yields a single
 * `ready` phase and ends immediately.
 */
async function emitLifecycle(args: {
  stream: import("hono/streaming").SSEStreamingApi;
  claimName: string;
  runner: NonNullable<Awaited<ReturnType<typeof getOrInitSharedRunner>>>;
  signal: AbortSignal;
}): Promise<boolean> {
  const { stream, claimName, runner, signal } = args;

  return new Promise<boolean>((resolve) => {
    let settled = false;
    let claimSeen = false;
    let handle: { unsubscribe(): void } | null = null;

    const settle = (result: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      signal.removeEventListener("abort", onAbort);
      handle?.unsubscribe();
      resolve(result);
    };

    // Watchdog: if the source has only ever surfaced `claiming` after
    // NO_CLAIM_MAX_MS, the SandboxClaim was never posted (VM_START likely
    // failed earlier). Surface `claim-never-created` so the UI shows the
    // retry affordance instead of stalling. Only meaningful for
    // agent-sandbox; other runners go straight to `ready` so the watchdog
    // never fires.
    const watchdogTimer = setTimeout(() => {
      if (claimSeen || settled) return;
      stream
        .writeSSE({
          event: "phase",
          data: JSON.stringify({
            kind: "failed",
            reason: "claim-never-created",
            message:
              "Sandbox claim was never created. The VM_START call may have failed earlier — check the start error.",
          } satisfies ClaimPhase),
        })
        .catch(() => {});
      settle(false);
    }, NO_CLAIM_MAX_MS);

    const onAbort = () => settle(false);
    signal.addEventListener("abort", onAbort, { once: true });

    handle = subscribeLifecycle(runner, claimName, (phase) => {
      if (settled) return;
      if (phase.kind !== "claiming") claimSeen = true;
      stream
        .writeSSE({ event: "phase", data: JSON.stringify(phase) })
        .catch(() => {});
      if (phase.kind === "ready") settle(true);
      else if (phase.kind === "failed") settle(false);
    });
  });
}

/**
 * Budget for the "lifecycle says ready but mesh hasn't finished its
 * post-Ready bookkeeping" race. The Sandbox CR Ready=True signal fires the
 * moment the operator's reconciliation completes; `runner.ensure()` then
 * does Service-patch + HTTPRoute-mint + port-forward + daemon health probe
 * before inserting the state-store row that `proxyDaemonRequest` reads. In
 * a real cluster that post-Ready window is typically 2–10s. Without this
 * retry the unified stream would 404 here, emit `gone`, and force the
 * browser to reconnect — the symptom that motivated this fix.
 */
const PROXY_OPEN_RETRY_BUDGET_MS = 60_000;
const PROXY_OPEN_RETRY_DELAY_MS = 500;

/**
 * Open the daemon's `/_decopilot_vm/events` SSE through the runner and pipe
 * raw bytes to the client. Daemon emits a stable wire format the browser's
 * EventSource already groks, so byte-passthrough preserves event names,
 * payloads, and frame boundaries without parsing.
 *
 * 404 handling: retry within `PROXY_OPEN_RETRY_BUDGET_MS` rather than
 * surfacing `gone` immediately. The most common cause of an immediate 404
 * is the lifecycle-vs-ensure race described above — `gone` is reserved for
 * genuine eviction, where the handle is absent from K8s + state-store after
 * the budget expires.
 *
 * Non-404 upstream failure → `failed` phase. Caller's UI surfaces the
 * existing error state.
 */
async function proxyDaemonEvents(args: {
  stream: import("hono/streaming").SSEStreamingApi;
  runner: NonNullable<Awaited<ReturnType<typeof getOrInitSharedRunner>>>;
  claimName: string;
  signal: AbortSignal;
}): Promise<void> {
  const { stream, runner, claimName, signal } = args;

  const openedAt = Date.now();
  let upstream: Response | null = null;

  while (!signal.aborted) {
    let attempt: Response | null = null;
    try {
      attempt = await runner.proxyDaemonRequest(
        claimName,
        "/_decopilot_vm/events",
        {
          method: "GET",
          headers: new Headers({ accept: "text/event-stream" }),
          body: null,
          signal,
        },
      );
    } catch (err) {
      if (signal.aborted) return;
      // Network-level failure (port-forward not yet open, daemon health
      // probe still failing, ...). Same race window as 404 — retry, then
      // surface as failed if the budget elapses.
      if (Date.now() - openedAt < PROXY_OPEN_RETRY_BUDGET_MS) {
        await sleepAbortable(PROXY_OPEN_RETRY_DELAY_MS, signal);
        continue;
      }
      const message = err instanceof Error ? err.message : String(err);
      await stream
        .writeSSE({
          event: "phase",
          data: JSON.stringify({
            kind: "failed",
            reason: "unknown",
            message: `Upstream daemon SSE error: ${message}`,
          } satisfies ClaimPhase),
        })
        .catch(() => {});
      return;
    }

    if (attempt.status === 404) {
      try {
        await attempt.body?.cancel();
      } catch {
        /* ignore */
      }
      if (Date.now() - openedAt < PROXY_OPEN_RETRY_BUDGET_MS) {
        await sleepAbortable(PROXY_OPEN_RETRY_DELAY_MS, signal);
        continue;
      }
      // Budget elapsed and handle still missing — genuine eviction. Emit
      // `gone` so the client's self-heal (VM_START) takes over.
      await stream.writeSSE({ event: "gone", data: "" }).catch(() => {});
      return;
    }

    if (!attempt.ok || !attempt.body) {
      try {
        await attempt.body?.cancel();
      } catch {
        /* ignore */
      }
      await stream
        .writeSSE({
          event: "phase",
          data: JSON.stringify({
            kind: "failed",
            reason: "unknown",
            message: `Upstream daemon SSE failed (${attempt.status}).`,
          } satisfies ClaimPhase),
        })
        .catch(() => {});
      return;
    }

    upstream = attempt;
    break;
  }

  if (!upstream || !upstream.body) return;

  const reader = upstream.body.getReader();
  try {
    while (!signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) await stream.write(value);
    }
  } catch {
    // Upstream errored or client aborted mid-read. Either way we're done —
    // the client will EventSource-reconnect if it wants to keep watching.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}

/** Sleep that resolves immediately when the abort signal fires. */
function sleepAbortable(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timeout);
      resolve();
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
