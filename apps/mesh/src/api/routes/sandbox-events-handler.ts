/**
 * Extracted SSE handler for VM events.
 *
 * Contains the lifecycle + daemon proxy logic previously in `vm-events.ts`.
 * Accepts pre-resolved claim data from the `resolveVmClaim` middleware
 * so it can be mounted inside the unified `vm-proxy.ts` router without
 * duplicating auth/claim boilerplate.
 */

import type { Context } from "hono";
import { streamSSE } from "hono/streaming";
import {
  resolveSandboxProviderKindFromEnv,
  type SandboxProviderKind,
  type SandboxProvider,
} from "@decocms/sandbox/provider";
import type { ClaimPhase } from "@decocms/sandbox/provider/agent-sandbox";
import { delay } from "@decocms/std";
import { subscribeLifecycle } from "../../sandbox/lifecycle";
import type { MeshContext } from "../../core/mesh-context";
import { KyselySandboxProviderStateStore } from "../../storage/sandbox-runner-state";
import { readSandboxMap, resolveVm } from "../../tools/sandbox/sandbox-map";
import type { Env } from "../hono-env";

/**
 * Cap on how long we keep the SSE open if a claim never materializes (e.g.
 * caller raced SANDBOX_START but SANDBOX_START failed before `createSandboxClaim`).
 * 90s is enough to absorb karpenter cold-start (~60-90s) plus a few seconds
 * of operator latency; longer waits indicate SANDBOX_START never posted the claim
 * and the user benefits from a faster failure surface so the retry button
 * appears promptly.
 */
const NO_CLAIM_MAX_MS = 90_000;

const HEARTBEAT_MS = 15_000;

/**
 * Budget for the "lifecycle says ready but mesh hasn't finished its
 * post-Ready bookkeeping" race.
 */
const PROXY_OPEN_RETRY_BUDGET_MS = 60_000;
const PROXY_OPEN_RETRY_DELAY_MS = 500;

export interface VmEventsHandlerArgs {
  ctx: MeshContext;
  claimName: string;
  runner: SandboxProvider;
  branch: string;
  userId: string;
  projectRef: string;
  virtualMcpMetadata: Record<string, unknown> | null;
}

export function handleVmEvents(c: Context<Env>, args: VmEventsHandlerArgs) {
  const {
    ctx,
    claimName,
    runner,
    branch,
    userId,
    projectRef,
    virtualMcpMetadata,
  } = args;
  const providerKind = resolveSandboxProviderKindFromEnv();

  const existingVmEntry = resolveVm(
    readSandboxMap(virtualMcpMetadata),
    userId,
    branch,
    providerKind,
  );
  const expectingHandle = existingVmEntry?.sandboxHandle === claimName;
  // Post-migration 091 the field is already canonical. Just narrow against
  // null/undefined for the cleanup call site below.
  const existingProviderKind: SandboxProviderKind | null =
    existingVmEntry?.sandboxProviderKind ?? null;

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
      if (expectingHandle) {
        const stale = await isStaleHandle(runner, claimName);
        if (stale) {
          await cleanupStaleEntry({
            ctx,
            runner,
            claimName,
            userId,
            projectRef,
            sandboxProviderKind: existingProviderKind ?? providerKind,
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
}

async function isStaleHandle(
  runner: SandboxProvider,
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

async function cleanupStaleEntry(args: {
  ctx: MeshContext;
  runner: SandboxProvider;
  claimName: string;
  userId: string;
  projectRef: string;
  sandboxProviderKind: SandboxProviderKind;
}): Promise<void> {
  const { ctx, runner, claimName, userId, projectRef, sandboxProviderKind } =
    args;
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
    const stateStore = new KyselySandboxProviderStateStore(ctx.db);
    await stateStore.delete({ userId, projectRef }, sandboxProviderKind);
  } catch (err) {
    console.warn(
      `[vm-events] sandbox_runner_state delete failed for ${userId}/${projectRef}/${sandboxProviderKind}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}

async function emitLifecycle(args: {
  stream: import("hono/streaming").SSEStreamingApi;
  claimName: string;
  runner: SandboxProvider;
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

    const watchdogTimer = setTimeout(() => {
      if (claimSeen || settled) return;
      stream
        .writeSSE({
          event: "phase",
          data: JSON.stringify({
            kind: "failed",
            reason: "claim-never-created",
            message:
              "Sandbox claim was never created. The SANDBOX_START call may have failed earlier — check the start error.",
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

async function proxyDaemonEvents(args: {
  stream: import("hono/streaming").SSEStreamingApi;
  runner: SandboxProvider;
  claimName: string;
  signal: AbortSignal;
}): Promise<void> {
  const { stream, runner, claimName, signal } = args;

  const openedAt = Date.now();
  let upstream: Response | null = null;

  while (!signal.aborted) {
    let attempt: Response | null = null;
    try {
      attempt = await runner.proxyDaemonRequest(claimName, "/_sandbox/events", {
        method: "GET",
        headers: new Headers({ accept: "text/event-stream" }),
        body: null,
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      if (Date.now() - openedAt < PROXY_OPEN_RETRY_BUDGET_MS) {
        await delay(PROXY_OPEN_RETRY_DELAY_MS, { signal }).catch(() => {});
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
        await delay(PROXY_OPEN_RETRY_DELAY_MS, { signal }).catch(() => {});
        continue;
      }
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
    // Upstream errored or client aborted mid-read.
  } finally {
    try {
      reader.releaseLock();
    } catch {
      /* ignore */
    }
  }
}
