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
import { delay, exponentialBackoffWithJitter } from "@decocms/shared/std";
import { subscribeLifecycle } from "../../sandbox/lifecycle";
import type { StudioContext } from "../../core/studio-context";
import { KyselySandboxProviderStateStore } from "@decocms/sandbox/provider/kysely-state-store";
import {
  readSandboxMap,
  removeSandboxMapEntry,
  resolveVm,
} from "../../tools/sandbox/sandbox-map";
import {
  getThreadSandboxMap,
  removeThreadSandboxMapEntry,
  setThreadHeadRef,
  syntheticBranchToGitRef,
  threadIdFromBranch,
} from "../../tools/sandbox/thread-repo";
import {
  pickRecordableHeadRef,
  type DaemonHeadStatus,
} from "../../sandbox/head-ref";
import { readBoundedText } from "../../lib/bounded-text";
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
 * How often an open event stream pushes the claim's shutdown back out.
 *
 * An open stream is what "somebody is watching this sandbox" looks like from
 * Studio: preview traffic goes gateway → pod and never reaches us, so without
 * this the 15-min claim TTL expires under a user who is actively reading the
 * preview, and they get a cold reprovision instead of the pod they were on.
 *
 * Well inside the TTL so a single failed renewal is harmless, and far coarser
 * than HEARTBEAT_MS because each one is two API-server calls per watcher —
 * there is no reason to spend them at keepalive rate.
 */
const TTL_RENEW_MS = 5 * 60_000;

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
  virtualMcpId: string;
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
    virtualMcpId,
    branch,
    userId,
    projectRef,
    virtualMcpMetadata,
  } = args;
  const providerKind = resolveSandboxProviderKindFromEnv();

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
    // Renew immediately as well as on the interval: a stream that reconnects
    // onto a long-lived sandbox is adopting a TTL that is already part-spent.
    const renew = () => void runner.renewTtl?.(claimName);
    renew();
    const ttlRenew = setInterval(renew, TTL_RENEW_MS);
    stream.onAbort(() => {
      abortCtl.abort();
      clearInterval(heartbeat);
      clearInterval(ttlRenew);
    });

    try {
      // Prefer the agent entry; fall back to the thread entry (thread-scoped
      // branches). `fromThread` steers cleanup to the right store.
      let vmEntry = resolveVm(
        readSandboxMap(virtualMcpMetadata),
        userId,
        branch,
        providerKind,
      );
      let fromThread = false;
      if (!vmEntry && threadId) {
        vmEntry = resolveVm(
          await getThreadSandboxMap(ctx, threadId),
          userId,
          branch,
          providerKind,
        );
        fromThread = !!vmEntry;
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
            projectRef,
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

      // The daemon is up: this is Studio's chance to learn which branch the
      // sandbox is ACTUALLY on. Whoever works in there owns HEAD (the Super
      // Agent commits on a fresh PR branch), and the next boot has to ask for
      // that ref or it forks from the repo default and the preview serves
      // pre-change code. Fire-and-forget — one request that must never delay or
      // fail the stream. See `sandbox/head-ref.ts`.
      void recordDaemonHeadRef({
        ctx,
        runner,
        claimName,
        branch,
        threadId,
        signal: abortCtl.signal,
      });

      // ---- Phase 2: daemon SSE proxy --------------------------------------
      await proxyDaemonEvents({
        stream,
        runner,
        claimName,
        signal: abortCtl.signal,
      });
    } finally {
      clearInterval(heartbeat);
      clearInterval(ttlRenew);
    }
  });
}

/** Cap on the branch probe — a slow daemon must not keep a request alive. */
const HEAD_REF_PROBE_TIMEOUT_MS = 5_000;
/** The probe reads one small JSON object; refuse anything absurd. */
const HEAD_REF_RESPONSE_MAX_BYTES = 256 * 1024;

/**
 * Ask the live daemon which branch it's on and persist it on the thread, so the
 * next provision restores THAT branch instead of the derived one (which the
 * daemon's HEAD-based shutdown push may never have created). Only for
 * thread-scoped sandboxes — an agent-level branch is already a real ref.
 *
 * Best-effort by construction: every failure path is swallowed. The cost of
 * losing it is one boot that falls back to today's behavior.
 */
async function recordDaemonHeadRef(args: {
  ctx: StudioContext;
  runner: SandboxProvider;
  claimName: string;
  branch: string;
  threadId: string | null;
  signal: AbortSignal;
}): Promise<void> {
  const { ctx, runner, claimName, branch, threadId, signal } = args;
  if (!threadId || !branch.startsWith("thread:")) return;
  try {
    const res = await runner.proxyDaemonRequest(
      claimName,
      "/_sandbox/git/status",
      {
        method: "GET",
        headers: new Headers({ accept: "application/json" }),
        body: null,
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(HEAD_REF_PROBE_TIMEOUT_MS),
        ]),
      },
    );
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      return;
    }
    const body = await readBoundedText(res, HEAD_REF_RESPONSE_MAX_BYTES);
    const status = JSON.parse(body) as DaemonHeadStatus;
    const headRef = pickRecordableHeadRef({
      status,
      requestedRef: syntheticBranchToGitRef(branch),
    });
    if (!headRef) return;
    await setThreadHeadRef(ctx, threadId, headRef);
  } catch {
    // Daemon unreachable / bad JSON / aborted — the hint is optional.
  }
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
  projectRef: string;
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
    projectRef,
    sandboxProviderKind,
    threadId,
  } = args;
  // Drop the thread's sandboxMap entry first. A dangling `sandboxHandle` left
  // in thread metadata makes every client SSE reconnect re-enter this stale
  // path and re-issue a DELETE against the already-gone claim — a 404 flood
  // that only stops when the tab closes.
  if (threadId) {
    try {
      await removeThreadSandboxMapEntry(
        ctx,
        threadId,
        userId,
        branch,
        sandboxProviderKind,
      );
    } catch (err) {
      console.warn(
        `[vm-events] thread sandboxMap cleanup failed for ${threadId}/${branch}/${sandboxProviderKind}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }
  // Same reasoning for the agent row. Mirrors SANDBOX_DELETE.
  try {
    if (!threadId) {
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
