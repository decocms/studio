/**
 * Unified VM proxy routes.
 *
 * Consolidates the previously separate `vm-file`, `vm-exec`, `vm-setup`,
 * `vm-events`, and `vm-preview-fetch` route files into one router under:
 *
 *   /api/:org/sandbox/:virtualMcpId/:branch/*
 *
 * The URL shape mirrors the daemon's own `/_sandbox/*` surface, making
 * the proxy transparent and uniform. Auth + claim resolution is performed
 * once in the `resolveVmClaim` middleware and shared by all sub-routes.
 */

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { createMiddleware } from "hono/factory";
import { composeSandboxRef } from "@decocms/sandbox/provider";
import type { SandboxProvider } from "@decocms/sandbox/provider";
import type { ClaimPhase } from "@decocms/sandbox/provider/agent-sandbox";
import { computeClaimHandle } from "../../sandbox/claim-handle";
import {
  resolveSandboxUserId,
  threadIdFromBranch,
} from "../../tools/sandbox/thread-repo";
import {
  defaultThreadRuntime,
  parseThreadRuntime,
  type ThreadRuntime,
} from "@decocms/shared/thread/session-runtime";
import { liveSandboxForBranch } from "../../tools/sandbox/live-sandbox-for-branch";
import { stampRuntimeIfAbsent } from "../../tools/thread/stamp-runtime-if-absent";
import { resolveSandboxProvider } from "../../sandbox/resolve-provider";
import {
  getUserId,
  requireAuth,
  requireOrganization,
} from "../../core/studio-context";
import type { Env } from "../hono-env";
import { patchSandboxOperator } from "../../tools/sandbox/patch-sandbox-operator";
import { handleVmEvents } from "./sandbox-events-handler";
import { resolveAndPushEnv } from "../../tools/sandbox/resolve-env";
import { readValidatedRuntimeEnv } from "../../tools/sandbox/helpers";
import {
  type GitDiffLike,
  type GitStatusLike,
  isGitStatusLike,
  suggestCommitMessageWithLlm,
} from "../../lib/suggest-commit-message";
import { judgeRequiresReviewWithLlm } from "../../lib/judge-requires-review";
import { gitDataClientForRepo } from "../../decofile/client-for-repo";
import {
  GitHubApiError,
  GitHubRateLimitError,
} from "../../decofile/github-git-data";
import {
  githubGitDiff,
  githubGitDiscard,
  githubGitRebase,
  githubGitStatus,
} from "../../decofile/git-compat";
import {
  buildLoaderInvokeUrl,
  parseLoaderInvokeRequest,
} from "../../lib/loader-invoke";
import { loopbackPreviewTarget } from "../../lib/loopback-preview";
import {
  GitPushAuthError,
  parseGithubRepoFromMetadata,
  refreshSandboxGitCredentials,
} from "../../tools/sandbox/sync-git-credentials";

// ---- Middleware types -------------------------------------------------------

interface VmClaim {
  claimName: string;
  /** The authenticated caller. Only credential resolution uses it — sandbox
   *  identity is `userId` below, which may be someone else (see
   *  `resolveSandboxUserId`). */
  callerUserId: string;
  /** Null when no sandbox runner is configured on this studio instance — or
   *  when the session is sandbox-less (`runtime` below). */
  runner: SandboxProvider | null;
  virtualMcpId: string;
  branch: string;
  userId: string;
  projectRef: string;
  virtualMcpMetadata: Record<string, unknown> | null;
  connectionIds: string[];
  /**
   * THIS session's runtime, read from its thread's stamp. `cms` means no
   * runner exists by design: the `/git/*` routes answer from the GitHub API
   * (see decofile/git-compat.ts) so the publish dialog and header work with no
   * working tree behind them, and every other daemon-backed route stays
   * unavailable.
   */
  runtime: ThreadRuntime;
}

type VmEnv = Env & { Variables: Env["Variables"] & { vmClaim: VmClaim } };

const SANDBOX_BRANCH_NAME = /^[a-zA-Z0-9][a-zA-Z0-9/._-]*$/;

function assertSandboxBranchParam(branch: string): void {
  // "thread:<id>" is a synthetic sandbox-identity branch (bound by `load_repo`
  // for thread-scoped repos) — the daemon accepts it and never checks it out as
  // a git ref, so the ':' is legal here even though the git-ref charset below
  // forbids it. Validate the id part after the prefix.
  const ref = branch.startsWith("thread:")
    ? branch.slice("thread:".length)
    : branch;
  if (
    !ref ||
    ref.length > 255 ||
    ref.includes("..") ||
    ref.startsWith("/") ||
    ref.endsWith("/") ||
    ref.endsWith(".lock") ||
    !SANDBOX_BRANCH_NAME.test(ref)
  ) {
    throw new Error(`Invalid branch name: ${branch}`);
  }
}

const SUGGEST_COMMIT_MAX_BODY_BYTES = 512 * 1024;
const PREVIEW_INVOKE_MAX_BODY_BYTES = 64 * 1024;

/**
 * Quick interactive file ops (read/write/mkdir/unlink/rename/glob) must fail
 * FAST when the daemon link is partitioned. Without an explicit bound they
 * inherit the tunnel dispatch's 30s first-frame timeout (see
 * `links/tunnel-dispatch.ts`), so a read against a severed link hangs ~30s
 * before erroring. These ops answer in well under a second on a healthy link,
 * so a 10s ceiling never trips when the daemon is reachable but turns a
 * partition into a prompt 502 instead of a 30s stall. Streaming/long ops
 * (exec, events, git/*) are intentionally NOT bounded here - the daemon itself
 * allows up to 60s for upstream headers (see `daemon/proxy.ts`).
 */
const QUICK_FILE_OP_TIMEOUT_MS = 10_000;
const GIT_STATUS_TIMEOUT_MS = 2_000;

/**
 * Abort signal for quick file ops: the inbound request's signal (client
 * disconnect) combined with a {@link QUICK_FILE_OP_TIMEOUT_MS} fast-fail
 * timeout so a partitioned link errors promptly rather than hanging.
 */
function quickFileOpSignal(c: Context<VmEnv>): AbortSignal {
  return AbortSignal.any([
    c.req.raw.signal,
    AbortSignal.timeout(QUICK_FILE_OP_TIMEOUT_MS),
  ]);
}

// ---- Shared middleware ------------------------------------------------------

/**
 * Resolves auth, org ownership, claim handle, and runner for all VM routes.
 * Runner may be `null` — the events handler streams a `failed` phase SSE in
 * that case; other handlers return 503 JSON via `requireRunner()`.
 */
const resolveVmClaim = createMiddleware<VmEnv>(async (c, next) => {
  const ctx = c.var.studioContext;
  try {
    requireAuth(ctx);
  } catch {
    return c.json({ error: "Unauthorized" }, 401);
  }
  const userId = getUserId(ctx);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);

  let organization: ReturnType<typeof requireOrganization>;
  try {
    organization = requireOrganization(ctx);
  } catch {
    return c.json({ error: "Organization scope required" }, 403);
  }

  const virtualMcpId = c.req.param("virtualMcpId");
  const branch = c.req.param("branch");
  if (!virtualMcpId || !branch) {
    return c.json({ error: "virtualMcpId and branch are required" }, 400);
  }

  try {
    assertSandboxBranchParam(branch);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: message }, 400);
  }

  const virtualMcp = await ctx.storage.virtualMcps.findById(virtualMcpId);
  if (!virtualMcp || virtualMcp.organization_id !== organization.id) {
    return c.json({ error: "Virtual MCP not found" }, 404);
  }

  const projectRef = composeSandboxRef({
    orgId: organization.id,
    virtualMcpId,
    branch,
  });
  // Sandbox identity, NOT the caller: a thread-scoped branch keys by the
  // thread's creator, so every org member viewing that thread resolves the same
  // claim and reaches the one sandbox it has. Keyed by the caller, a viewer's
  // handle never existed — /events reported `claiming` forever and every other
  // route 404'd. See `resolveSandboxUserId`.
  const sandboxUserId = await resolveSandboxUserId(ctx, branch, userId);
  const claimName = computeClaimHandle({ userId: sandboxUserId, projectRef });
  const virtualMcpMetadata =
    (virtualMcp.metadata as Record<string, unknown>) ?? null;

  // Source of truth: sandboxMap. If an entry exists for (user, branch) we use
  // that recorded kind — a sandbox provisioned via `desktop` must
  // remain addressable via `desktop` even on a cluster whose env kind
  // is `agent-sandbox` / `docker`. Pre-provision callers fall through to
  // the link-or-env default policy inside `resolveSandboxProvider`.
  //
  // On failure (e.g. the recorded kind is `desktop` but the user's
  // link daemon is offline) we surface `null` rather than falling back
  // to the env singleton: rebinding a `desktop`-provisioned VM onto
  // a different provider kind (say `agent-sandbox`) would forward traffic
  // to a sandbox that doesn't host this VM. The events handler streams a
  // `failed` phase from null; other handlers 503 via `requireRunner`.
  // Sandbox-less Fast Preview: there is no runner by design. Claim the route
  // with runner:null + the flag so the `/git/*` handlers serve their
  // GitHub-backed equivalents; daemon-backed routes 503 via requireRunner.
  const runtime = await resolveClaimRuntime(c, {
    claimName,
    branch,
    virtualMcpId,
    sandboxUserId,
    virtualMcpMetadata,
  });

  if (runtime === "cms") {
    c.set("vmClaim", {
      claimName,
      callerUserId: userId,
      runner: null,
      virtualMcpId,
      branch,
      userId: sandboxUserId,
      projectRef,
      virtualMcpMetadata,
      connectionIds:
        virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
      runtime,
    });
    return next();
  }

  let runner: SandboxProvider | null;
  try {
    const resolved = await resolveSandboxProvider(ctx, {
      userId: sandboxUserId,
      branch,
      virtualMcpMetadata,
    });
    runner = resolved.provider;
  } catch {
    runner = null;
  }

  if (!runner) {
    return c.json({ error: "No sandbox runner found" }, 404);
  }

  c.set("vmClaim", {
    claimName,
    callerUserId: userId,
    runner,
    virtualMcpId,
    branch,
    userId: sandboxUserId,
    projectRef,
    virtualMcpMetadata,
    connectionIds:
      virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
    runtime,
  });
  return next();
});

/**
 * THE runtime decision, in one place.
 *
 * A parsing stamp wins outright, with no probe and no map read — that is every
 * thread created after `COLLECTION_THREADS_CREATE` began stamping. When there
 * is no stamp to read (a legacy row, or a caller that sends no `?thread=`, such
 * as a desktop build whose web bundle is frozen), fall back to the pre-change
 * rule with one substitution: sandbox PRESENCE becomes LIVENESS, so a dead cell
 * can no longer route a CMS session to a daemon that cannot exist. Resolving
 * `sandbox` that way stamps the thread, so the ambiguous population drains.
 */
async function resolveClaimRuntime(
  c: Context<VmEnv>,
  claim: {
    claimName: string;
    branch: string;
    virtualMcpId: string;
    sandboxUserId: string;
    virtualMcpMetadata: Record<string, unknown> | null;
  },
): Promise<ThreadRuntime> {
  const ctx = c.var.studioContext;
  const threadId = c.req.query("thread") ?? threadIdFromBranch(claim.branch);

  const thread = threadId
    ? await ctx.storage.threads.get(threadId).catch(() => null)
    : null;
  // A thread from another project cannot speak for this claim.
  const owned = thread?.virtual_mcp_id === claim.virtualMcpId ? thread : null;
  const stamp = parseThreadRuntime(
    (owned?.metadata as { runtime?: unknown } | null)?.runtime,
  );
  if (stamp) return stamp;

  const projectDefault = defaultThreadRuntime(claim.virtualMcpMetadata);
  // The probe only runs where it can change the answer. Its result is also the
  // only EVIDENCE this path has, which is what decides whether we may stamp.
  const probed = projectDefault === "cms";
  const live = probed
    ? await liveSandboxForBranch(ctx, {
        claimName: claim.claimName,
        userId: claim.sandboxUserId,
        branch: claim.branch,
        virtualMcpMetadata: claim.virtualMcpMetadata,
      })
    : true;
  const runtime: ThreadRuntime = probed && !live ? "cms" : "sandbox";

  console.log("sandbox proxy: no runtime stamp", {
    route: c.req.path,
    method: c.req.method,
    reason: owned ? "unstamped" : "threadless",
    resolved: runtime,
    stamped: !!owned && probed,
  });
  // Stamp ONLY what the probe witnessed. Without `probed`, a legacy thread on a
  // project whose Fast Preview switch was just turned off would be permanently
  // converted to a coding session by a `/git/status` poll — and the stamp is
  // immutable, so there would be no way back.
  if (owned && probed) {
    void stampRuntimeIfAbsent(ctx, owned.id, runtime);
  }
  return runtime;
}

/**
 * The runner bound to this ref, whatever the session's runtime is. Only a
 * pod-addressed route may use it — see `/setup/:step`.
 */
async function resolveBranchRunner(
  c: Context<VmEnv>,
): Promise<SandboxProvider | null> {
  const claim = c.get("vmClaim");
  if (claim.runner) return claim.runner;
  try {
    const { provider } = await resolveSandboxProvider(c.var.studioContext, {
      userId: claim.userId,
      branch: claim.branch,
      virtualMcpMetadata: claim.virtualMcpMetadata,
    });
    return provider;
  } catch {
    return null;
  }
}

/** Guard for routes that need a non-null runner. Returns the runner or a 503. */
function requireRunner(c: Context<VmEnv>): SandboxProvider | Response {
  const { runner } = c.get("vmClaim");
  if (!runner) {
    return c.json({ error: "No sandbox runner configured" }, 503);
  }
  return runner;
}

// ---- Sandbox-less Fast Preview `/git/*` compat ------------------------------
// The publish dialog and header speak the daemon's git JSON shapes; for
// fastPreview claims these routes answer from the GitHub API instead (see
// decofile/git-compat.ts), so the SAME components work with no working tree.

async function fastPreviewGitClient(c: Context<VmEnv>) {
  const { virtualMcpMetadata, connectionIds } = c.get("vmClaim");
  const ctx = c.var.studioContext;
  const githubRepo = parseGithubRepoFromMetadata(
    virtualMcpMetadata,
    connectionIds,
  );
  if (!githubRepo) {
    throw new GitHubApiError(
      404,
      "AUTH",
      "repo",
      "Project has no GitHub repository",
    );
  }
  const organization = requireOrganization(ctx);
  return gitDataClientForRepo(ctx, organization.id, githubRepo);
}

function fastPreviewGitError(c: Context<VmEnv>, err: unknown): Response {
  /** 429 with GitHub's own wait, so the client backs off instead of retrying. */
  if (err instanceof GitHubRateLimitError) {
    return c.json({ error: err.message }, 429, {
      ...SANDBOX_PROXY_CACHE_HEADERS,
      ...(err.retryAfterMs === null
        ? {}
        : { "Retry-After": String(Math.ceil(err.retryAfterMs / 1000)) }),
    });
  }
  if (err instanceof GitHubApiError) {
    const status =
      err.status === 404
        ? 404
        : err.status === 409 || err.status === 422
          ? 409
          : 502;
    return c.json({ error: err.message }, status, SANDBOX_PROXY_CACHE_HEADERS);
  }
  const message = err instanceof Error ? err.message : String(err);
  return c.json({ error: message }, 502, SANDBOX_PROXY_CACHE_HEADERS);
}

/**
 * Fetches an upstream preview response and relays its body/status, mapping
 * both a failed fetch and a failed body read to the same 502 shape. Shared by
 * `preview-fetch` and `preview-invoke`, which otherwise repeated this
 * fetch-or-502 / text-or-502 dance verbatim.
 */
async function proxyPreviewUpstream(
  c: Context<VmEnv>,
  url: string,
  init?: RequestInit,
): Promise<Response> {
  let upstream: Response;
  try {
    upstream = await fetch(url, init);
  } catch {
    return c.json({ error: "Preview unreachable" }, 502);
  }

  let text: string;
  try {
    text = await upstream.text();
  } catch {
    return c.json({ error: "Preview unreachable" }, 502);
  }

  return new Response(text, {
    status: upstream.status,
    headers: {
      "content-type":
        upstream.headers.get("content-type") ?? "application/json",
    },
  });
}

async function fastPreviewGitStatus(c: Context<VmEnv>): Promise<Response> {
  try {
    const client = await fastPreviewGitClient(c);
    const status = await githubGitStatus(client, c.get("vmClaim").branch);
    return c.json(status, 200, SANDBOX_PROXY_CACHE_HEADERS);
  } catch (err) {
    return fastPreviewGitError(c, err);
  }
}

/**
 * Publish/rebase first PUT an `operator` identity into the daemon's persisted
 * tenant config, then trigger the commit/push against the single working
 * tree the daemon reads that config back from. Two concurrent publish/rebase
 * calls for the same claim (the same user in two tabs, or a retry racing the
 * original) can otherwise interleave: one request's operator
 * PUT gets read back by the other's commit, and two `git commit`/`push`
 * sequences race the same working tree. Serializing per claim closes that
 * window for this mesh process. Entries are removed once idle so this never
 * grows unbounded — it only ever holds one promise per claim currently in
 * flight.
 */
const claimGitLocks = new Map<string, Promise<unknown>>();

export function withClaimGitLock<T>(
  claimName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prior = claimGitLocks.get(claimName) ?? Promise.resolve();
  const next = prior.catch(() => {}).then(fn);
  const settled = next.catch(() => {});
  claimGitLocks.set(claimName, settled);
  settled.finally(() => {
    if (claimGitLocks.get(claimName) === settled) {
      claimGitLocks.delete(claimName);
    }
  });
  return next;
}

// ---- Proxy helpers ----------------------------------------------------------

/** Sandbox runtime responses must never be cached — 410 Gone was getting stuck in disk cache. */
const SANDBOX_PROXY_CACHE_HEADERS = {
  "Cache-Control": "no-store, no-cache, must-revalidate",
  Pragma: "no-cache",
} as const;

async function proxyDaemon(
  c: Context<VmEnv>,
  daemonPath: string,
  opts?: {
    method?: "GET" | "POST" | "PUT";
    forwardJsonBody?: boolean;
    /** When set, sent instead of reading the request body. */
    jsonBody?: string;
    signal?: AbortSignal;
    /** Map 404 to 410 (sandbox needs re-provision). */
    map404to410?: boolean;
    /**
     * Null out `repoDir` in the JSON response unless the resolved runner is
     * `user-desktop`. Every daemon reports `repoDir` as its own
     * container-internal path (`/app/repo` on agent-sandbox); only a desktop
     * link daemon's path exists on the user's machine. The frontend uses this
     * to build `vscode://file<repoDir>` deep links — surfacing a container path
     * pops a "Path does not exist" error. Authoritative because it keys off the
     * resolved runner, immune to a stale/racing frontend provider-kind.
     */
    redactRepoDirUnlessDesktop?: boolean;
    /** Pod-addressed route: act on this runner whatever the session's runtime is. */
    runner?: SandboxProvider;
  },
) {
  // Sandbox-less Fast Preview: daemon-backed routes have no daemon, ever.
  // Answer 404 — the exact shape clients already treat as "sandbox absent"
  // (readCommittedJson → null → next source; isSandboxUnreachable → backoff).
  // A 503 here reads as a REAL error and, e.g., fails the meta fallback chain
  // instead of letting it proceed to the preview server's /live/_meta.
  if (!opts?.runner && c.get("vmClaim").runtime === "cms") {
    return c.json(
      { error: "sandbox not found: this session is sandbox-less" },
      404,
      SANDBOX_PROXY_CACHE_HEADERS,
    );
  }

  const runner = opts?.runner ?? requireRunner(c);
  if (runner instanceof Response) return runner;

  const { claimName, userId, projectRef } = c.get("vmClaim");
  const method = opts?.method ?? "POST";
  let body: string | null = null;
  const headers = new Headers();

  if (opts?.jsonBody !== undefined) {
    body = opts.jsonBody;
    headers.set("content-type", "application/json");
  } else if (opts?.forwardJsonBody) {
    body = await c.req.text();
    headers.set("content-type", "application/json");
  }

  const signal = opts?.signal;
  const requestInit = {
    method,
    headers,
    body,
    ...(signal ? { signal } : {}),
  };

  /**
   * Resolve the daemon, optionally retry on 404→adopt, and return the
   * upstream response. Extracted so that the caller can race the whole
   * operation against the abort signal — the signal on `requestInit`
   * only covers the final `fetch`, not the record resolution /
   * resurrection that precedes it and can take tens of seconds when a
   * sandbox was evicted.
   */
  const resolveAndFetch = async (): Promise<Response> => {
    let upstream = await runner.proxyDaemonRequest(
      claimName,
      daemonPath,
      requestInit,
    );

    if (opts?.map404to410 && upstream.status === 404) {
      try {
        await upstream.body?.cancel();
      } catch {
        /* ignore */
      }
      const adopted = await runner.adoptLiveClaim?.(
        { userId, projectRef },
        claimName,
      );
      if (adopted) {
        upstream = await runner.proxyDaemonRequest(
          claimName,
          daemonPath,
          requestInit,
        );
      }
      if (upstream.status === 404) {
        try {
          await upstream.body?.cancel();
        } catch {
          /* ignore */
        }
        return new Response(
          JSON.stringify({
            error:
              "Sandbox handle is gone. The sandbox needs to be re-provisioned.",
          }),
          {
            status: 410,
            headers: {
              "content-type": "application/json",
              ...SANDBOX_PROXY_CACHE_HEADERS,
            },
          },
        );
      }
    }

    const rawText = await upstream.text();
    const text =
      opts?.redactRepoDirUnlessDesktop && runner.kind !== "user-desktop"
        ? redactRepoDir(rawText)
        : rawText;
    const contentType =
      upstream.headers.get("content-type") ?? "application/json";
    return new Response(text, {
      status: upstream.status,
      headers: { "content-type": contentType, ...SANDBOX_PROXY_CACHE_HEADERS },
    });
  };

  try {
    // When a signal is provided, race the entire resolve+fetch operation
    // against it. Without this, record resolution (getRecord → rehydrate,
    // resurrectByHandle → ensure) can take tens of seconds on an evicted
    // sandbox, and the signal only aborts the final HTTP fetch — not the
    // K8s/port-forward work that precedes it.
    if (signal) {
      // Attach a no-op catch so that if the signal wins the race and
      // resolveAndFetch later rejects (its inner fetch aborts via the
      // same signal), the rejection is swallowed instead of surfacing
      // as an unhandled promise rejection.
      const work = resolveAndFetch();
      work.catch(() => {});
      const upstream = await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          if (signal.aborted) return reject(signal.reason);
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
        }),
      ]);
      return upstream;
    }
    return await resolveAndFetch();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: `Daemon unreachable: ${message}` }, 502);
  }
}

/**
 * Set `repoDir` to null in a daemon config JSON payload. Returns the input
 * unchanged if it isn't a JSON object with a `repoDir` key, so a non-JSON or
 * error body passes through untouched.
 */
export function redactRepoDir(text: string): string {
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    if (
      parsed &&
      typeof parsed === "object" &&
      !Array.isArray(parsed) &&
      "repoDir" in parsed
    ) {
      return JSON.stringify({ ...parsed, repoDir: null });
    }
  } catch {
    /* not JSON — leave as-is */
  }
  return text;
}

export async function fetchDaemonJson<T>(
  runner: SandboxProvider,
  claimName: string,
  daemonPath: string,
  method: "GET" | "POST" = "GET",
  sandboxId?: { userId: string; projectRef: string },
): Promise<T> {
  let upstream = await runner.proxyDaemonRequest(claimName, daemonPath, {
    method,
    headers: new Headers(),
    body: null,
  });

  if (upstream.status === 404 && sandboxId) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* ignore */
    }
    const adopted = await runner.adoptLiveClaim?.(sandboxId, claimName);
    if (adopted) {
      upstream = await runner.proxyDaemonRequest(claimName, daemonPath, {
        method,
        headers: new Headers(),
        body: null,
      });
    }
  }

  if (upstream.status === 404) {
    try {
      await upstream.body?.cancel();
    } catch {
      /* ignore */
    }
    throw new Error("SANDBOX_GONE");
  }

  const text = await upstream.text();
  if (!upstream.ok) {
    let message = `Daemon error (${upstream.status})`;
    try {
      const err = JSON.parse(text) as { error?: string };
      message = err.error ?? message;
    } catch {
      /* non-JSON error body — keep the generic message */
    }
    throw new Error(message);
  }

  return JSON.parse(text) as T;
}

// ---- Setup validation -------------------------------------------------------

const SETUP_STEPS = ["clone", "install", "start"] as const;
type SetupStep = (typeof SETUP_STEPS)[number];

function isSetupStep(value: string): value is SetupStep {
  return (SETUP_STEPS as readonly string[]).includes(value);
}

// ---- Route factory ----------------------------------------------------------

export const createSandboxRoutes = () => {
  const app = new Hono<VmEnv>();

  // Apply middleware to all sub-routes
  app.use("/:virtualMcpId/:branch/*", resolveVmClaim);

  // -- File write/read (base64-encoded body) --------------------------------
  app.post("/:virtualMcpId/:branch/write", (c) =>
    proxyDaemon(c, "/_sandbox/write", {
      forwardJsonBody: true,
      signal: quickFileOpSignal(c),
    }),
  );
  app.post("/:virtualMcpId/:branch/unlink", (c) =>
    proxyDaemon(c, "/_sandbox/unlink", {
      forwardJsonBody: true,
      signal: quickFileOpSignal(c),
    }),
  );
  app.post("/:virtualMcpId/:branch/mkdir", (c) =>
    proxyDaemon(c, "/_sandbox/mkdir", {
      forwardJsonBody: true,
      signal: quickFileOpSignal(c),
    }),
  );
  app.post("/:virtualMcpId/:branch/rename", (c) =>
    proxyDaemon(c, "/_sandbox/rename", {
      forwardJsonBody: true,
      signal: quickFileOpSignal(c),
    }),
  );
  app.post("/:virtualMcpId/:branch/read", (c) =>
    proxyDaemon(c, "/_sandbox/read", {
      forwardJsonBody: true,
      signal: quickFileOpSignal(c),
    }),
  );
  app.post("/:virtualMcpId/:branch/glob", (c) =>
    proxyDaemon(c, "/_sandbox/glob", {
      forwardJsonBody: true,
      signal: quickFileOpSignal(c),
    }),
  );
  app.post("/:virtualMcpId/:branch/grep", (c) =>
    proxyDaemon(c, "/_sandbox/grep", {
      forwardJsonBody: true,
      signal: quickFileOpSignal(c),
    }),
  );

  // -- Script exec/kill -----------------------------------------------------
  app.post("/:virtualMcpId/:branch/exec/:script", async (c) => {
    const script = c.req.param("script");
    if (!script) return c.json({ error: "missing script name" }, 400);
    return proxyDaemon(c, `/_sandbox/exec/${encodeURIComponent(script)}`);
  });

  app.post("/:virtualMcpId/:branch/exec/:script/kill", async (c) => {
    const script = c.req.param("script");
    if (!script) return c.json({ error: "missing script name" }, 400);
    return proxyDaemon(c, `/_sandbox/exec/${encodeURIComponent(script)}/kill`);
  });

  // -- Tenant config --------------------------------------------------------
  app.get("/:virtualMcpId/:branch/config", (c) =>
    proxyDaemon(c, "/_sandbox/config", {
      method: "GET",
      map404to410: true,
      // A container path (`/app/repo`) is never openable on the user's
      // machine — only surface `repoDir` for the desktop link daemon.
      redactRepoDirUnlessDesktop: true,
    }),
  );
  app.put("/:virtualMcpId/:branch/config", (c) =>
    proxyDaemon(c, "/_sandbox/config", {
      method: "PUT",
      forwardJsonBody: true,
      map404to410: true,
      // No `redactRepoDirUnlessDesktop` here: the PUT response echoes the
      // written TenantConfig (git/operator/application), which carries no
      // `repoDir` — only the GET read handler surfaces it.
    }),
  );

  // -- Setup retry ----------------------------------------------------------
  /**
   * POD-ADDRESSED, the one route that is: it acts on whatever pod exists at
   * this ref and never asks whose session it is. Project settings restarts a
   * dev process from a surface with no thread at all, so a session-scoped
   * answer here would 404 a running sandbox and silently skip its env push.
   */
  app.post("/:virtualMcpId/:branch/setup/:step", async (c) => {
    const step = c.req.param("step");
    if (!step || !isSetupStep(step)) {
      return c.json(
        { error: `step must be one of: ${SETUP_STEPS.join(", ")}` },
        400,
      );
    }
    const podRunner = await resolveBranchRunner(c);
    if (!podRunner) {
      return c.json({ error: "No sandbox runner found" }, 404);
    }
    // On "start", refresh the daemon's env from the virtual MCP's current
    // `metadata.runtime.env`. The dev script inherits env at spawn time, so
    // edits made after the last SANDBOX_START don't reach a running process
    // unless we push the freshly-resolved env to /config before the
    // orchestrator restarts it.
    if (step === "start") {
      const claim = c.get("vmClaim");
      {
        const organization = requireOrganization(c.var.studioContext);
        const entries = readValidatedRuntimeEnv(claim.virtualMcpMetadata);
        try {
          await resolveAndPushEnv({
            ctx: c.var.studioContext,
            runner: podRunner,
            handle: claim.claimName,
            orgId: organization.id,
            // Secrets resolve as the CALLER — viewing a teammate's thread must
            // never mint their private secrets into the sandbox.
            userId: claim.callerUserId,
            entries,
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return c.json(
            { error: `Failed to push env to daemon: ${message}` },
            502,
          );
        }
      }
    }
    return proxyDaemon(c, `/_sandbox/setup/${step}`, {
      signal: c.req.raw.signal,
      map404to410: true,
      runner: podRunner,
    });
  });

  // -- SSE events -----------------------------------------------------------
  app.get("/:virtualMcpId/:branch/events", (c) => {
    const claim = c.get("vmClaim");

    // No runner → stream a single failed phase so the UI shows an error
    // rather than the EventSource receiving a non-SSE 503 JSON response.
    if (!claim.runner) {
      return streamSSE(c, async (stream) => {
        await stream.writeSSE({
          event: "phase",
          data: JSON.stringify({
            kind: "failed",
            reason: "unknown",
            message: "No sandbox runner configured on this studio instance.",
          } satisfies ClaimPhase),
        });
      });
    }

    return handleVmEvents(c as unknown as Context<Env>, {
      ctx: c.var.studioContext,
      claimName: claim.claimName,
      runner: claim.runner,
      virtualMcpId: claim.virtualMcpId,
      branch: claim.branch,
      userId: claim.userId,
      projectRef: claim.projectRef,
      virtualMcpMetadata: claim.virtualMcpMetadata,
    });
  });

  // -- Git (status, diff, publish, discard) ---------------------------------
  app.get("/:virtualMcpId/:branch/git/status", (c) => {
    if (c.get("vmClaim").runtime === "cms") return fastPreviewGitStatus(c);
    return proxyDaemonGitStatus(c);
  });
  const proxyDaemonGitStatus = (c: Context<VmEnv>) =>
    proxyDaemon(c, "/_sandbox/git/status", {
      method: "GET",
      map404to410: true,
      signal: AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(GIT_STATUS_TIMEOUT_MS),
      ]),
    });
  app.post("/:virtualMcpId/:branch/git/status", (c) => {
    if (c.get("vmClaim").runtime === "cms") return fastPreviewGitStatus(c);
    return proxyDaemon(c, "/_sandbox/git/status", {
      map404to410: true,
      signal: AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(GIT_STATUS_TIMEOUT_MS),
      ]),
    });
  });
  app.post("/:virtualMcpId/:branch/git/diff", async (c) => {
    const claim = c.get("vmClaim");
    if (claim.runtime === "cms") {
      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          base?: string;
        };
        const client = await fastPreviewGitClient(c);
        const diff = await githubGitDiff(client, claim.branch, body.base);
        return c.json(diff, 200, SANDBOX_PROXY_CACHE_HEADERS);
      } catch (err) {
        return fastPreviewGitError(c, err);
      }
    }
    return proxyDaemon(c, "/_sandbox/git/diff", {
      forwardJsonBody: true,
      map404to410: true,
    });
  });
  app.post("/:virtualMcpId/:branch/git/publish", async (c) => {
    // Sandbox-less: every save is already a commit on the remote branch, so
    // "sync local work" has nothing to do. Answering OK keeps the publish
    // dialog's flow (push → rebase → PR/merge via the GitHub connection)
    // working with no working tree behind it.
    //
    // Deliberately does NOT flush a coding session's pod on the same branch:
    // the daemon's publish commits its ENTIRE working tree, while the gate that
    // authorized this click was computed from the GitHub manifest alone — so
    // flushing would push unreviewed code past a `smart`/`code-review` policy.
    // A teammate's unpushed work staying invisible here is a pre-existing blind
    // spot, and the honest fix is to widen the GATE, not to widen the push.
    if (c.get("vmClaim").runtime === "cms") {
      return c.json({ ok: true }, 200, SANDBOX_PROXY_CACHE_HEADERS);
    }
    const runner = requireRunner(c);
    if (runner instanceof Response) return runner;

    const { claimName, virtualMcpMetadata, connectionIds } = c.get("vmClaim");
    const ctx = c.var.studioContext;

    return withClaimGitLock(claimName, async () => {
      try {
        await patchSandboxOperator(ctx, runner, claimName);
        const githubRepo = parseGithubRepoFromMetadata(
          virtualMcpMetadata,
          connectionIds,
        );
        if (githubRepo) {
          await refreshSandboxGitCredentials(
            ctx,
            runner,
            claimName,
            githubRepo,
          );
        }
      } catch (err) {
        if (err instanceof GitPushAuthError) {
          return c.json(
            { error: err.message },
            403,
            SANDBOX_PROXY_CACHE_HEADERS,
          );
        }
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 502, SANDBOX_PROXY_CACHE_HEADERS);
      }

      return proxyDaemon(c, "/_sandbox/git/publish", {
        forwardJsonBody: true,
        map404to410: true,
      });
    });
  });
  app.post("/:virtualMcpId/:branch/git/discard", async (c) => {
    const claim = c.get("vmClaim");
    if (claim.runtime === "cms") {
      // No working tree: discarding a COMMITTED change is itself a commit.
      return withClaimGitLock(claim.claimName, async () => {
        const body = (await c.req.json().catch(() => ({}))) as {
          filepaths?: unknown;
        };
        const filepaths = Array.isArray(body.filepaths)
          ? body.filepaths.filter((p): p is string => typeof p === "string")
          : [];
        if (filepaths.length === 0) {
          return c.json(
            { error: "filepaths is required" },
            400,
            SANDBOX_PROXY_CACHE_HEADERS,
          );
        }
        try {
          const client = await fastPreviewGitClient(c);
          await githubGitDiscard(client, claim.branch, filepaths);
          return c.json({ ok: true }, 200, SANDBOX_PROXY_CACHE_HEADERS);
        } catch (err) {
          const status =
            err instanceof GitHubApiError && err.status === 409 ? 409 : 502;
          const message = err instanceof Error ? err.message : String(err);
          return c.json(
            { error: message },
            status,
            SANDBOX_PROXY_CACHE_HEADERS,
          );
        }
      });
    }
    return withClaimGitLock(claim.claimName, () =>
      proxyDaemon(c, "/_sandbox/git/discard", {
        forwardJsonBody: true,
        map404to410: true,
      }),
    );
  });
  app.post("/:virtualMcpId/:branch/git/rebase", async (c) => {
    const claim = c.get("vmClaim");
    if (claim.runtime === "cms") {
      return withClaimGitLock(claim.claimName, async () => {
        try {
          const body = (await c.req.json().catch(() => ({}))) as {
            base?: string;
          };
          const client = await fastPreviewGitClient(c);
          const base = body.base ?? (await client.getDefaultBranch());
          await githubGitRebase(client, claim.branch, base);
          return c.json({ ok: true }, 200, SANDBOX_PROXY_CACHE_HEADERS);
        } catch (err) {
          return fastPreviewGitError(c, err);
        }
      });
    }
    const runner = requireRunner(c);
    if (runner instanceof Response) return runner;

    const { claimName } = c.get("vmClaim");
    const ctx = c.var.studioContext;

    return withClaimGitLock(claimName, async () => {
      try {
        await patchSandboxOperator(ctx, runner, claimName);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return c.json({ error: message }, 502, SANDBOX_PROXY_CACHE_HEADERS);
      }

      return proxyDaemon(c, "/_sandbox/git/rebase", {
        forwardJsonBody: true,
        map404to410: true,
      });
    });
  });
  app.post(
    "/:virtualMcpId/:branch/git/suggest-commit",
    bodyLimit({
      maxSize: SUGGEST_COMMIT_MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          { error: "Payload too large" },
          413,
          SANDBOX_PROXY_CACHE_HEADERS,
        ),
    }),
    async (c) => {
      const claim = c.get("vmClaim");
      // runner === null ⇔ sandbox-less Fast Preview (the claim middleware
      // only admits a null runner for that mode).
      let runner: SandboxProvider | null = null;
      if (claim.runtime !== "cms") {
        const required = requireRunner(c);
        if (required instanceof Response) return required;
        runner = required;
      }

      const { claimName, userId, projectRef } = claim;
      const ctx = c.var.studioContext;

      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          status?: GitStatusLike;
          diff?: GitDiffLike;
        };

        const clientStatus = body.status;
        const clientDiff = body.diff;
        const hasClientDiff =
          clientDiff != null &&
          typeof clientDiff.diffs === "object" &&
          clientDiff.diffs !== null;

        const [status, diff] =
          isGitStatusLike(clientStatus) && hasClientDiff
            ? [clientStatus, clientDiff]
            : runner
              ? await Promise.all([
                  fetchDaemonJson<GitStatusLike>(
                    runner,
                    claimName,
                    "/_sandbox/git/status",
                    "GET",
                    { userId, projectRef },
                  ),
                  fetchDaemonJson<GitDiffLike>(
                    runner,
                    claimName,
                    "/_sandbox/git/diff",
                    "GET",
                    { userId, projectRef },
                  ),
                ])
              : // Sandbox-less backfill: same GitHub-backed shapes the /git
                // routes serve (no daemon exists to ask).
                await (async () => {
                  const client = await fastPreviewGitClient(c);
                  return Promise.all([
                    githubGitStatus(client, claim.branch),
                    githubGitDiff(client, claim.branch),
                  ]);
                })();
        const suggestion = await suggestCommitMessageWithLlm(ctx, status, diff);
        return c.json(suggestion, 200, SANDBOX_PROXY_CACHE_HEADERS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "SANDBOX_GONE") {
          return c.json(
            {
              error:
                "Sandbox handle is gone. The sandbox needs to be re-provisioned.",
            },
            410,
            SANDBOX_PROXY_CACHE_HEADERS,
          );
        }
        return c.json({ error: message }, 502, SANDBOX_PROXY_CACHE_HEADERS);
      }
    },
  );

  // Smart-review judge: the client sends the full publish payload (status +
  // combined diff) and the cheap "fast" model tier decides whether the changes
  // need PR review. Backfills status/diff from the daemon when omitted, mirrors
  // the suggest-commit handler. On any failure the lib returns a permissive
  // verdict (requiresReview: false) so the AI's absence never blocks publish.
  app.post(
    "/:virtualMcpId/:branch/git/judge-review",
    bodyLimit({
      maxSize: SUGGEST_COMMIT_MAX_BODY_BYTES,
      onError: (c) =>
        c.json(
          { error: "Payload too large" },
          413,
          SANDBOX_PROXY_CACHE_HEADERS,
        ),
    }),
    async (c) => {
      const claim = c.get("vmClaim");
      // runner === null ⇔ sandbox-less Fast Preview (see suggest-commit).
      let runner: SandboxProvider | null = null;
      if (claim.runtime !== "cms") {
        const required = requireRunner(c);
        if (required instanceof Response) return required;
        runner = required;
      }

      const { claimName, userId, projectRef } = claim;
      const ctx = c.var.studioContext;

      try {
        const body = (await c.req.json().catch(() => ({}))) as {
          status?: GitStatusLike;
          diff?: GitDiffLike;
          language?: string;
        };

        const clientStatus = body.status;
        const clientDiff = body.diff;
        const hasClientDiff =
          clientDiff != null &&
          typeof clientDiff.diffs === "object" &&
          clientDiff.diffs !== null;

        const [status, diff] =
          isGitStatusLike(clientStatus) && hasClientDiff
            ? [clientStatus, clientDiff]
            : runner
              ? await Promise.all([
                  fetchDaemonJson<GitStatusLike>(
                    runner,
                    claimName,
                    "/_sandbox/git/status",
                    "GET",
                    { userId, projectRef },
                  ),
                  fetchDaemonJson<GitDiffLike>(
                    runner,
                    claimName,
                    "/_sandbox/git/diff",
                    "GET",
                    { userId, projectRef },
                  ),
                ])
              : await (async () => {
                  const client = await fastPreviewGitClient(c);
                  return Promise.all([
                    githubGitStatus(client, claim.branch),
                    githubGitDiff(client, claim.branch),
                  ]);
                })();
        const verdict = await judgeRequiresReviewWithLlm(
          ctx,
          status,
          diff,
          typeof body.language === "string" ? body.language : undefined,
        );
        return c.json(verdict, 200, SANDBOX_PROXY_CACHE_HEADERS);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        if (message === "SANDBOX_GONE") {
          return c.json(
            {
              error:
                "Sandbox handle is gone. The sandbox needs to be re-provisioned.",
            },
            410,
            SANDBOX_PROXY_CACHE_HEADERS,
          );
        }
        return c.json({ error: message }, 502, SANDBOX_PROXY_CACHE_HEADERS);
      }
    },
  );

  // -- Preview fetch (CORS proxy for same-origin public preview assets) --------
  // /live/_meta is fetched directly from the preview URL by the client
  // (the deco dev server allows CORS `*` for it). These must go through this
  // proxy because cloud previews don't expose them cross-origin:
  //   - /.decofile   — the committed decofile snapshot (block state)
  //   - /sprites.svg — the site's icon sprite sheet (served by the CF Assets
  //     binding with no CORS header, read here for the icon-select picker)
  //   - any storefront page (`/`, `/granado/...`) whose SSR HTML the path-param
  //     picker scrapes for category/product links
  // The preview URL is derived server-side from the authed claim (never a
  // client param), so this stays SSRF-safe. The path is client-supplied but
  // constrained to same-origin: it must start with `/` and cannot escape the
  // origin (protocol-relative `//`, traversal `..`, or backslash).
  app.get("/:virtualMcpId/:branch/preview-fetch", async (c) => {
    const runner = requireRunner(c);
    if (runner instanceof Response) return runner;

    const { claimName } = c.get("vmClaim");
    const path = c.req.query("path");
    if (
      !path ||
      !path.startsWith("/") ||
      path.startsWith("//") ||
      path.includes("..") ||
      path.includes("\\")
    ) {
      return c.json({ error: "Path not allowed" }, 403);
    }

    let previewUrl: string | null;
    try {
      previewUrl = await runner.getPreviewUrl(claimName);
    } catch {
      return c.json({ error: "Preview not available" }, 502);
    }
    if (!previewUrl) {
      return c.json({ error: "Preview not available" }, 502);
    }

    const base = previewUrl.replace(/\/+$/, "");
    const loopback = loopbackPreviewTarget(`${base}${path}`);
    return proxyPreviewUpstream(c, loopback?.url ?? `${base}${path}`, {
      ...(loopback ? { headers: { host: loopback.hostHeader } } : {}),
    });
  });

  // -- Preview invoke (loader/action resolution) ------------------------------
  app.post(
    "/:virtualMcpId/:branch/preview-invoke",
    bodyLimit({
      maxSize: PREVIEW_INVOKE_MAX_BODY_BYTES,
      onError: (c) => c.json({ error: "Payload too large" }, 413),
    }),
    async (c) => {
      const runner = requireRunner(c);
      if (runner instanceof Response) return runner;

      const { claimName } = c.get("vmClaim");
      let previewUrl: string | null;
      try {
        previewUrl = await runner.getPreviewUrl(claimName);
      } catch {
        return c.json({ error: "Preview not available" }, 502);
      }
      if (!previewUrl) {
        return c.json({ error: "Preview not available" }, 502);
      }

      let body: unknown;
      try {
        body = await c.req.json();
      } catch {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return c.json({ error: "Invalid JSON body" }, 400);
      }

      const invoke = parseLoaderInvokeRequest(body as Record<string, unknown>);
      if (!invoke) {
        return c.json({ error: "Invalid or missing __resolveType" }, 400);
      }

      const invokeUrl = buildLoaderInvokeUrl(previewUrl, invoke.resolveType);
      const loopback = loopbackPreviewTarget(invokeUrl);
      return proxyPreviewUpstream(c, loopback?.url ?? invokeUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(loopback ? { host: loopback.hostHeader } : {}),
        },
        body: JSON.stringify(invoke.payload),
        signal: AbortSignal.timeout(30_000),
      });
    },
  );

  return app;
};
