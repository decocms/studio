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
  type SandboxId,
  type SandboxProviderKind,
  type SandboxProvider,
} from "@decocms/sandbox/provider";
import { delay, exponentialBackoffWithJitter } from "@decocms/shared/std";
import { subscribeLifecycle } from "../../sandbox/lifecycle";
import type { StudioContext } from "../../core/studio-context";
import {
  readSandboxMap,
  removeSandboxMapEntry,
  resolveVm,
} from "../../tools/sandbox/sandbox-map";
import {
  getThreadSandboxMap,
  removeThreadSandboxMapEntry,
  threadIdFromBranch,
} from "../../tools/sandbox/thread-repo";
import type { Env } from "../hono-env";
import { requireOrganization } from "../../core/studio-context";

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
 * Budget for the "lifecycle says ready but studio hasn't finished its
 * post-Ready bookkeeping" race.
 */
const PROXY_OPEN_RETRY_BUDGET_MS = 60_000;
const PROXY_OPEN_RETRY_DELAY_MS = 500;
/**
 * Cap for the exponential backoff applied to transient upstream statuses (429 /
 * 5xx). 429 means "too many SSE clients on the daemon" — retrying every 500ms
 * (let alone instantly ending the stream so the client's EventSource reconnects
 * at once) is exactly the storm that pins the daemon at MAX_SSE_CLIENTS and
 * floods logs with `bad status 429`. Back off hard instead.
 */
const PROXY_BACKOFF_CAP_MS = 10_000;

export interface VmEventsHandlerArgs {
  ctx: StudioContext;
  claimName: string;
  runner: SandboxProvider;
  sandboxId: SandboxId;
  providerKind: SandboxProviderKind;
  virtualMcpId: string;
  branch: string;
  userId: string;
  virtualMcpMetadata: Record<string, unknown> | null;
}

export function handleVmEvents(c: Context<Env>, args: VmEventsHandlerArgs) {
  const {
    ctx,
    claimName,
    runner,
    sandboxId,
    providerKind,
    virtualMcpId,
    branch,
    userId,
    virtualMcpMetadata,
  } = args;
  // The agent row is a no-op sandbox store for the synthetic Decopilot agent —
  // its records live on the THREAD (see `setThreadSandboxMapEntry`). Resolve the
  // thread id from the branch so the stale-handle check below covers thread-
  // scoped sandboxes too; otherwise a dead thread claim never emits `gone` and
  // the preview loops on `claiming` forever with no self-heal.
  const threadId = threadIdFromBranch(branch);

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
      let vmEntry;
      let fromThread = false;
      if (sandboxId.scope === "shared") {
        const organization = requireOrganization(ctx);
        const session = await ctx.storage.agentSandboxSessions.find({
          organizationId: organization.id,
          virtualMcpId,
          branch,
        });
        if (session?.desiredState === "stopped") {
          if (session.status === "stopping" || session.status === "deleting") {
            const transition = session.status;
            let deleteSucceeded = true;
            try {
              const handle =
                session.sandboxHandle ??
                (transition === "deleting" ? claimName : null);
              if (handle) {
                await runner.delete(handle, sandboxId);
              }
            } catch (error) {
              deleteSucceeded = false;
              console.warn(
                `[vm-events] failed to resume shared stop for ${virtualMcpId}/${branch}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            } finally {
              if (transition !== "deleting" || deleteSucceeded) {
                const locator = {
                  organizationId: organization.id,
                  virtualMcpId,
                  branch,
                };
                await ctx.storage.agentSandboxSessions.withLock(
                  locator,
                  (sessions) =>
                    transition === "deleting"
                      ? sessions.completeDelete(locator, session.generation)
                      : sessions.completeStop(locator, session.generation),
                );
              }
            }
          }
          await stream.writeSSE({ event: "gone", data: "" }).catch(() => {});
          return;
        }
        if (session?.status === "reaping" && session.sandboxHandle) {
          await cleanupStaleEntry({
            ctx,
            runner,
            claimName: session.sandboxHandle,
            virtualMcpId,
            branch,
            userId,
            sandboxId,
            sandboxProviderKind: providerKind,
            threadId: null,
          });
          await stream.writeSSE({ event: "gone", data: "" }).catch(() => {});
          return;
        }
        vmEntry =
          session?.sandboxHandle && session.status === "ready"
            ? {
                sandboxHandle: session.sandboxHandle,
                sandboxProviderKind: "agent-sandbox" as const,
              }
            : null;
      } else {
        // Prefer the agent entry; fall back to the thread entry (thread-scoped
        // branches). `fromThread` steers cleanup to the right store.
        vmEntry = resolveVm(
          readSandboxMap(virtualMcpMetadata),
          userId,
          branch,
          providerKind,
        );
        if (!vmEntry && threadId) {
          vmEntry = resolveVm(
            await getThreadSandboxMap(ctx, threadId),
            userId,
            branch,
            providerKind,
          );
          fromThread = !!vmEntry;
        }
      }
      const existingProviderKind: SandboxProviderKind | null =
        vmEntry?.sandboxProviderKind ?? null;

      if (vmEntry?.sandboxHandle === claimName) {
        const stale = await isStaleHandle(runner, claimName);
        if (stale) {
          await cleanupStaleEntry({
            ctx,
            runner,
            claimName,
            virtualMcpId,
            branch,
            userId,
            sandboxId,
            sandboxProviderKind: existingProviderKind ?? providerKind,
            threadId: fromThread ? threadId : null,
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
  ctx: StudioContext;
  runner: SandboxProvider;
  claimName: string;
  virtualMcpId: string;
  branch: string;
  userId: string;
  sandboxId: SandboxId;
  sandboxProviderKind: SandboxProviderKind;
  /** Set when the stale entry was found on the thread (synthetic agent) — clear
   *  it there instead of / in addition to the agent row. */
  threadId: string | null;
}): Promise<void> {
  const {
    ctx,
    runner,
    claimName,
    virtualMcpId,
    branch,
    userId,
    sandboxId,
    sandboxProviderKind,
    threadId,
  } = args;
  if (sandboxId.scope === "shared") {
    const organization = requireOrganization(ctx);
    const locator = {
      organizationId: organization.id,
      virtualMcpId,
      branch,
    };
    try {
      const reaping = await ctx.storage.agentSandboxSessions.withLock(
        locator,
        (sessions) => sessions.beginReap(locator, claimName),
      );
      if (!reaping) return;
      try {
        await runner.delete(claimName, sandboxId);
      } finally {
        await ctx.storage.agentSandboxSessions.withLock(locator, (sessions) =>
          sessions.completeReap(locator, reaping.generation, claimName),
        );
      }
    } catch (err) {
      console.warn(
        `[vm-events] shared session cleanup failed for ${virtualMcpId}/${branch}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
    return;
  }
  // Drop the sandboxMap entry first. Without this the dangling `sandboxHandle`
  // stays in metadata, so every client SSE reconnect re-enters this stale path
  // and re-issues a DELETE against the already-gone claim — a 404 flood that
  // only stops when the tab closes. Clear whichever store held it (thread for
  // the synthetic agent, else the agent row). Mirrors SANDBOX_DELETE.
  try {
    if (threadId) {
      await removeThreadSandboxMapEntry(
        ctx,
        threadId,
        userId,
        branch,
        sandboxProviderKind,
      );
    } else {
      await removeSandboxMapEntry(
        ctx.storage.virtualMcps,
        virtualMcpId,
        userId,
        userId,
        branch,
        sandboxProviderKind,
      );
    }
  } catch (err) {
    console.warn(
      `[vm-events] sandboxMap cleanup failed for ${virtualMcpId}/${branch}/${sandboxProviderKind}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
  try {
    await runner.delete(claimName, sandboxId);
  } catch (err) {
    console.warn(
      `[vm-events] runner.delete failed for ${claimName}: ${
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
      // No claim within budget — end the lifecycle phase quietly and let the
      // proxy phase + client reconnect take over instead of latching a
      // terminal failure in the UI.
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
  let badStatusAttempt = 0;

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
      // Daemon unreachable past the budget. Don't emit a terminal failure —
      // end the stream so the client's EventSource reconnects (it will pick
      // up logs / `gone` once the link is back). Latching here froze the
      // preview across a `deco link` relink. Log once (per ~60s SSE attempt)
      // so an operator can tell an expected `deco link` outage from a
      // misconfig/crash without the client seeing a terminal failure.
      console.warn(
        `[vm-events] daemon unreachable past budget for ${claimName}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
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
      const status = attempt.status;
      try {
        await attempt.body?.cancel();
      } catch {
        /* ignore */
      }
      if (Date.now() - openedAt < PROXY_OPEN_RETRY_BUDGET_MS) {
        console.warn(
          `[vm-events] upstream daemon SSE bad status ${status} for ${claimName} (attempt ${
            badStatusAttempt + 1
          }, backing off)`,
        );
        const backoff = exponentialBackoffWithJitter(
          PROXY_BACKOFF_CAP_MS,
          PROXY_OPEN_RETRY_DELAY_MS,
          badStatusAttempt++,
          2,
          0.5,
        );
        await delay(backoff, { signal }).catch(() => {});
        continue;
      }
      // Past budget — end the stream and let the client reconnect fresh.
      console.warn(
        `[vm-events] upstream daemon SSE bad status ${status} for ${claimName} past budget; ending stream`,
      );
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
