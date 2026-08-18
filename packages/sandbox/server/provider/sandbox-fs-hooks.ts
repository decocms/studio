/**
 * createSandboxFsHooks — the harness→sandbox cycle-breaker (spec
 * 2026-06-11-harness-extraction-design.md §4.3).
 *
 * Builds the flat filesystem hooks (`onRead`/`onWrite`/`onEdit`/`onBash`/
 * `onGlob`/`onGrep`) that the harness consumes through `HarnessDeps` (§5.1) over
 * a `SandboxProvider.proxyDaemonRequest`. The harness calls `deps.onRead(...)`
 * and never sees `SandboxProvider` — the lifecycle (handle resolution, daemon
 * reachability, auto-restart) is hidden behind these closures.
 *
 * The `DaemonUnreachableError` sentinel, the `daemonRequest` proxy wrapper, and
 * the call-level retry layer are moved verbatim from
 * `apps/api/src/harnesses/decopilot/built-in-tools/vm-tools/index.ts` (where
 * they used to live in-tool). The richer LLM-visible read/write/edit/grep/glob/
 * bash *tools* (truncation, image-queueing, html-buffer mirroring) stay in the
 * harness and call these flat hooks.
 *
 * The hook payload shapes mirror `HarnessDeps`'s `EditOp`/`BashOpts`/
 * `BashResult`/`GrepOpts`/`GrepHit` (`apps/api/src/harnesses/lib/harness-deps.ts`) so
 * the cluster bag can wire `deps.onRead = hooks.onRead`, etc. They are declared
 * locally here because packages may not import an `apps/*` tree
 * (ban-cross-tree-imports).
 */

import type { SandboxProvider } from "./types";

export interface SandboxFsEdit {
  oldText: string;
  newText: string;
  replaceAll?: boolean;
}

export interface SandboxFsBashOpts {
  cwd?: string;
  timeoutMs?: number;
}

export interface SandboxFsBashResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface SandboxFsGrepOpts {
  path?: string;
  glob?: string;
  caseInsensitive?: boolean;
}

export interface SandboxFsGrepHit {
  file: string;
  line: number;
  text: string;
}

export interface SandboxFsHooks {
  onRead(path: string): Promise<string>;
  onWrite(path: string, content: string): Promise<void>;
  onEdit(path: string, edits: SandboxFsEdit[]): Promise<void>;
  onBash(cmd: string, opts?: SandboxFsBashOpts): Promise<SandboxFsBashResult>;
  onGlob(pattern: string): Promise<string[]>;
  onGrep(
    pattern: string,
    opts?: SandboxFsGrepOpts,
  ): Promise<SandboxFsGrepHit[]>;
  /**
   * Escape hatch — proxy an arbitrary `/_sandbox/*` daemon route and return its
   * parsed JSON body, sharing the same handle-resolution + auto-restart retry
   * layer as the flat ops above. The richer LLM-visible read/write/edit/grep/
   * glob/bash *tools* in the harness use this to preserve behavior that the flat
   * ops intentionally drop (the image-read branch, the html-buffer preview
   * shapes of write/edit, and the `write_from_url`/`upload_to_url` transfer
   * routes behind `copy_to_sandbox`/`share_with_user`). New harness code should
   * prefer the typed flat ops; this exists only to cover the daemon surfaces
   * those ops don't model.
   *
   * `signal` is the run's abort signal (AI-SDK `ToolCallOptions.abortSignal`):
   * cancelling the run aborts the in-flight daemon request instead of leaving
   * it running detached.
   */
  onProxy(
    path: string,
    body: Record<string, unknown>,
    method?: "POST" | "PUT",
    signal?: AbortSignal,
  ): Promise<unknown>;
}

export interface SandboxFsHooksLifecycle {
  /**
   * Lazy handle resolver. Invoked on every fs op; the caller is expected to
   * memoise so the first invocation provisions and later calls reuse.
   */
  ensureHandle(): Promise<string>;
  /**
   * Invalidate the memoised handle (and, for ephemeral branches, reap the
   * underlying sandbox map entry) so the next `ensureHandle` provisions a fresh
   * sandbox. Used by the retry layer when the daemon proxy reports the sandbox
   * is unreachable.
   *
   * `force: true` reaps the map entry even for non-auto-restart branches — the
   * retry layer sets it when the sandbox is provably GONE (404), where there is
   * no live working tree to preserve, so an in-flight run can survive infra
   * reaping (e.g. a worker eviction that dropped the sandbox).
   */
  invalidateHandle(opts?: { force?: boolean }): Promise<void>;
  /**
   * When true, the call wrapper retries once on `DaemonUnreachableError` (after
   * invalidating the handle). Enabled for ephemeral agents (no server-button UI
   * to restart from); disabled for GitHub-linked agents where the user may have
   * paused the sandbox intentionally.
   */
  canAutoRestart: boolean;
  /**
   * Fixed per-op deadline override. Default derives from the op's own budget
   * (`opDeadlineMs`); tests override with a tiny value. Production callers
   * should not need to.
   */
  opTimeoutMs?: number;
  /**
   * Thread driving this run. Stamped as `x-thread-id` on every daemon call so
   * the daemon's `linked()` middleware repoints `org/output` (and `org/upload`)
   * at this thread's org-fs subtree before the handler runs. Without it the
   * daemon never repoints for hosted-harness runs, the fs write's MkdirAll
   * materializes `org/output` as a REAL dir on the pod's ephemeral disk, and
   * every deliverable written there dies with the pod.
   */
  threadId?: string;
}

/**
 * HTTP deadline for one daemon op, enforced HERE (transport-agnostic) — the
 * daemon's own bash timeout (30s default / 120s max) only protects when the
 * daemon is healthy enough to respond. Without this bound, a wedged daemon or
 * stalled org-fs mount left the harness awaiting silently past the 10-min
 * liveness reaper, which then killed an otherwise healthy run.
 *
 * The deadline follows the op's own declared budget: `input.timeout` when the
 * body carries one (bash; clamped to the daemon's 120s cap), else the daemon's
 * 30s default — plus a grace window so a command the daemon kills at its cap
 * still delivers its stdout/stderr here instead of losing the race to the
 * client-side abort. Ops without a budget (read/write/edit/grep/glob) fail at
 * 45s.
 */
const DAEMON_BASH_MAX_TIMEOUT_MS = 120_000; // daemon clamp (daemon/routes/bash.ts)
const DAEMON_DEFAULT_TIMEOUT_MS = 30_000; // daemon default (daemon/routes/bash.ts)
const OP_GRACE_MS = 15_000;

/**
 * Floor on how often sandbox activity re-arms the claim's shutdown deadline.
 * Same cadence (and reasoning) as the dispatch path's `TTL_RENEW_MS`:
 * comfortably inside the 15-minute claim TTL, so a missed renewal still leaves
 * two more chances before the operator reaps the pod.
 */
const TTL_RENEW_MS = 5 * 60_000;

export function opDeadlineMs(input: Record<string, unknown>): number {
  const budget =
    typeof input.timeout === "number" && input.timeout > 0
      ? Math.min(input.timeout, DAEMON_BASH_MAX_TIMEOUT_MS)
      : DAEMON_DEFAULT_TIMEOUT_MS;
  return budget + OP_GRACE_MS;
}

/** Reject when `signal` fires, even if `promise` (a transport that ignores
 *  signals) never settles. The orphaned promise is swallowed. */
function abortable<T>(signal: AbortSignal, promise: Promise<T>): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason ?? new Error("aborted"));
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => {
      promise.catch(() => {});
      reject(signal.reason ?? new Error("aborted"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => {
      signal.removeEventListener("abort", onAbort);
    });
  });
}

/**
 * Sentinel error for "the daemon proxy itself threw" — meaning the sandbox is
 * unreachable (dead, restarting, or never provisioned). The retry layer uses
 * this to distinguish a recoverable sandbox-death from a request-level failure
 * (4xx/5xx from a live daemon).
 */
class DaemonUnreachableError extends Error {
  readonly code = "DAEMON_UNREACHABLE" as const;
  /**
   * True when the daemon definitively reported the sandbox is GONE — a 404
   * `sandbox not found`, i.e. the record was reaped (housekeeper GC, or a worker
   * eviction that dropped the sandbox mid-run). A reaped sandbox has no working
   * tree left to preserve, so respawning is always safe — the retry layer honors
   * this even when `canAutoRestart` is false. Left false for AMBIGUOUS failures
   * (transport threw / 5xx): those can be a transient blip on a still-live
   * sandbox, where a respawn would abandon its working tree, so they stay gated
   * behind `canAutoRestart`.
   */
  readonly gone: boolean;
  constructor(cause: unknown, gone = false) {
    super(cause instanceof Error ? cause.message : "Daemon proxy failed");
    this.gone = gone;
    if (cause instanceof Error) {
      this.cause = cause;
    }
  }
}

async function daemonRequest(
  runner: SandboxProvider,
  handle: string,
  path: string,
  body: Record<string, unknown> | null,
  method: "GET" | "POST" | "PUT" = "POST",
  opts?: { signal?: AbortSignal; timeoutMs?: number; threadId?: string },
): Promise<unknown> {
  const timeoutMs = opts?.timeoutMs ?? opDeadlineMs(body ?? {});
  const timeout = AbortSignal.timeout(timeoutMs);
  const reqSignal = opts?.signal
    ? AbortSignal.any([opts.signal, timeout])
    : timeout;
  let res: Response;
  let rawText: string;
  try {
    const headers = new Headers({ "content-type": "application/json" });
    // The daemon's `linked()` middleware keys org-fs link repointing on this
    // header — see `SandboxFsHooksLifecycle.threadId`.
    if (opts?.threadId) headers.set("x-thread-id", opts.threadId);
    const init: {
      method: string;
      headers: Headers;
      body: string | null;
      signal: AbortSignal;
    } = {
      method,
      headers,
      body: null,
      signal: reqSignal,
    };
    // GET/HEAD must not carry a body; the runners' proxy strips it anyway,
    // but constructing it is wasteful and obscures intent.
    if (method !== "GET" && body !== null) {
      init.body = JSON.stringify(body);
    }
    // `abortable` (not just init.signal) so a transport that ignores the
    // signal — or a body read that stalls — still respects the deadline.
    ({ res, rawText } = await abortable(
      reqSignal,
      (async () => {
        const r = await runner.proxyDaemonRequest(handle, path, init);
        return { res: r, rawText: await r.text() };
      })(),
    ));
  } catch (cause) {
    // Run cancelled: propagate as-is. Neither a timeout nor a cancel may become
    // DaemonUnreachableError — that would trigger the auto-restart retry, which
    // reaps and re-provisions the sandbox (wrong for a cancelled run, and too
    // destructive for a busy-but-alive daemon that merely missed one deadline).
    if (opts?.signal?.aborted) throw cause;
    if (timeout.aborted) {
      throw new Error(
        `Sandbox ${method} ${path} timed out after ${Math.round(timeoutMs / 1000)}s — the sandbox may be overloaded or its filesystem stalled. Retry, or use a smaller operation.`,
      );
    }
    throw new DaemonUnreachableError(cause);
  }
  let json: unknown;
  try {
    json = JSON.parse(rawText);
  } catch {
    console.error(
      "[sandbox-fs-hooks] Failed to parse JSON response runner=%s path=%s status=%d rawText=%s",
      runner.kind,
      path,
      res.status,
      rawText.slice(0, 2000),
    );
    const statusHint =
      res.status >= 500
        ? " (server error)"
        : res.status === 0
          ? " (no response)"
          : "";
    throw new Error(
      `Daemon ${path} returned invalid JSON (HTTP ${res.status}${statusHint}): ${rawText.slice(0, 800)}`,
    );
  }
  if (!res.ok) {
    console.error(
      "[sandbox-fs-hooks] Non-OK response runner=%s path=%s status=%d body=%s",
      runner.kind,
      path,
      res.status,
      rawText.slice(0, 2000),
    );
    const errorMessage =
      (json as { error?: string }).error ??
      `Daemon ${path} failed (${res.status})`;
    if (res.status === 404 && errorMessage === "sandbox not found") {
      // `gone: true` — the sandbox is provably reaped (never a user pause), so
      // the retry layer respawns even for persistent branches.
      throw new DaemonUnreachableError(new Error(errorMessage), true);
    }
    throw new Error(errorMessage);
  }
  return json;
}

/**
 * Parse the daemon grep route's `output_mode: "content"` block — newline-
 * separated `file:line:text` rows (ripgrep `--line-number`) — into structured
 * hits. Rows that don't match the shape (e.g. ripgrep context separators) are
 * skipped.
 *
 * The file-explorer UI has an equivalent `parseGrepContent` in
 * `apps/web/src/components/sandbox/preview/file-explorer/utils.ts` —
 * same wire shape, kept separate because packages can't import app code.
 * Update both if the shape changes.
 */
function parseGrepResults(results: string): SandboxFsGrepHit[] {
  const hits: SandboxFsGrepHit[] = [];
  for (const row of results.split("\n")) {
    if (!row) continue;
    const firstColon = row.indexOf(":");
    if (firstColon < 0) continue;
    const secondColon = row.indexOf(":", firstColon + 1);
    if (secondColon < 0) continue;
    const file = row.slice(0, firstColon);
    const line = Number.parseInt(row.slice(firstColon + 1, secondColon), 10);
    if (!Number.isFinite(line)) continue;
    hits.push({ file, line, text: row.slice(secondColon + 1) });
  }
  return hits;
}

/**
 * Build the flat fs hooks over `provider.proxyDaemonRequest`. Typing `provider`
 * as `SandboxProvider` enforces the §4.3 invariant (the harness depends on this
 * package's provider surface, never the other way round).
 */
export function createSandboxFsHooks(
  provider: SandboxProvider,
  lifecycle: SandboxFsHooksLifecycle,
): SandboxFsHooks {
  const { ensureHandle, invalidateHandle, canAutoRestart } = lifecycle;

  // Hold the claim open while a HOSTED harness is driving this sandbox.
  //
  // A claim dies at `spec.lifecycle.shutdownTime` (now + 15min) unless
  // something pushes it out. The two things that did were the preview SSE
  // handler (a browser attached to the sandbox iframe) and `/dispatch`
  // streaming (a harness running INSIDE the pod). A hosted harness — decopilot
  // driving the sandbox over these fs/exec routes — is neither, so nothing
  // renewed it: at minute 15 the operator deleted the claim mid-run and the pod
  // came back reset, losing the working tree and `.deco/tools/` under a run that
  // was still going.
  //
  // Activity-driven rather than a timer: no interval to leak or dispose, and a
  // run that stops touching the sandbox correctly stops holding it.
  let lastRenewAt = 0;
  const renewTtl = (handle: string): void => {
    if (!provider.renewTtl) return;
    const now = Date.now();
    if (now - lastRenewAt < TTL_RENEW_MS) return;
    lastRenewAt = now;
    void provider.renewTtl(handle).catch((err) => {
      console.warn(
        `[sandbox-fs-hooks] TTL renew failed for ${handle}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  };

  const formatUnreachableMessage = (cause: unknown): string => {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return canAutoRestart
      ? `Sandbox is unreachable and auto-restart did not recover it: ${detail}`
      : "The sandbox is not running. Ask the user to start it by clicking the server button (left side of the header bar).";
  };

  const call = async (
    daemonPath: string,
    input: Record<string, unknown>,
    method: "POST" | "PUT" = "POST",
    signal?: AbortSignal,
  ): Promise<unknown> => {
    const tryOnce = async (handle: string) =>
      daemonRequest(provider, handle, daemonPath, input, method, {
        signal,
        timeoutMs: lifecycle.opTimeoutMs,
        threadId: lifecycle.threadId,
      });
    const firstHandle = await ensureHandle();
    renewTtl(firstHandle);
    try {
      return await tryOnce(firstHandle);
    } catch (firstErr) {
      // Only retry on daemon-unreachable (sandbox dead). HTTP-level errors
      // from a live daemon (4xx/5xx) are surfaced as-is — a retry would
      // just repeat the same failure.
      if (!(firstErr instanceof DaemonUnreachableError)) throw firstErr;
      // Respawn when the branch opts into auto-restart, OR when the sandbox is
      // provably GONE (404) — a reaped sandbox has nothing to preserve, so even
      // persistent branches recover instead of surfacing a sticky failure when
      // infra (a worker eviction / housekeeper GC) drops the sandbox mid-run.
      if (!canAutoRestart && !firstErr.gone) {
        throw new Error(formatUnreachableMessage(firstErr.cause ?? firstErr));
      }
      console.warn(
        `[sandbox-fs-hooks] daemon ${daemonPath} unreachable — reaping sandbox and retrying once`,
        firstErr.cause ?? firstErr,
      );
      try {
        await invalidateHandle({ force: firstErr.gone });
      } catch (reapErr) {
        console.warn("[sandbox-fs-hooks] invalidateHandle failed", reapErr);
      }
      let secondHandle: string;
      try {
        secondHandle = await ensureHandle();
      } catch (provisionErr) {
        throw new Error(
          `Failed to restart sandbox: ${
            provisionErr instanceof Error
              ? provisionErr.message
              : String(provisionErr)
          }`,
        );
      }
      try {
        return await tryOnce(secondHandle);
      } catch (secondErr) {
        if (secondErr instanceof DaemonUnreachableError) {
          throw new Error(
            formatUnreachableMessage(secondErr.cause ?? secondErr),
          );
        }
        throw secondErr;
      }
    }
  };

  return {
    onProxy: (path, body, method, signal) => call(path, body, method, signal),
    onRead: async (path) => {
      const r = (await call("/_sandbox/read", { path })) as { content: string };
      return r.content;
    },
    onWrite: async (path, content) => {
      await call("/_sandbox/write", { path, content });
    },
    onEdit: async (path, edits) => {
      // The daemon edit route is single-edit (one old/new pair per call) and
      // uses snake_case keys. Apply each edit in sequence.
      for (const edit of edits) {
        await call("/_sandbox/edit", {
          path,
          old_string: edit.oldText,
          new_string: edit.newText,
          replace_all: edit.replaceAll === true,
        });
      }
    },
    onBash: async (cmd, opts) => {
      const r = (await call("/_sandbox/bash", {
        command: cmd,
        ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
        ...(opts?.timeoutMs !== undefined ? { timeout: opts.timeoutMs } : {}),
      })) as SandboxFsBashResult;
      return r;
    },
    onGlob: async (pattern) => {
      const r = (await call("/_sandbox/glob", { pattern })) as {
        files: string[];
      };
      return r.files;
    },
    onGrep: async (pattern, opts) => {
      const r = (await call("/_sandbox/grep", {
        pattern,
        output_mode: "content",
        ...(opts?.path !== undefined ? { path: opts.path } : {}),
        ...(opts?.glob !== undefined ? { glob: opts.glob } : {}),
        ...(opts?.caseInsensitive ? { ignore_case: true } : {}),
      })) as { results: string };
      return parseGrepResults(r.results);
    },
  };
}
