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
  /** Null when no sandbox runner is configured on this studio instance. */
  runner: SandboxProvider | null;
  virtualMcpId: string;
  branch: string;
  userId: string;
  projectRef: string;
  virtualMcpMetadata: Record<string, unknown> | null;
  connectionIds: string[];
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
  const claimName = computeClaimHandle({ userId, projectRef }, branch);
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
  let runner: SandboxProvider | null;
  try {
    const resolved = await resolveSandboxProvider(ctx, {
      userId,
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
    runner,
    virtualMcpId,
    branch,
    userId,
    projectRef,
    virtualMcpMetadata,
    connectionIds:
      virtualMcp.connections?.map((conn) => conn.connection_id) ?? [],
  });
  return next();
});

/** Guard for routes that need a non-null runner. Returns the runner or a 503. */
function requireRunner(c: Context<VmEnv>): SandboxProvider | Response {
  const { runner } = c.get("vmClaim");
  if (!runner) {
    return c.json({ error: "No sandbox runner configured" }, 503);
  }
  return runner;
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
  },
) {
  const runner = requireRunner(c);
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

async function fetchDaemonJson<T>(
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
    try {
      const err = JSON.parse(text) as { error?: string };
      throw new Error(err.error ?? `Daemon error (${upstream.status})`);
    } catch (parseErr) {
      if (parseErr instanceof Error && parseErr.message !== text) {
        throw parseErr;
      }
      throw new Error(`Daemon error (${upstream.status})`);
    }
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
  app.post("/:virtualMcpId/:branch/exec/:script", (c) => {
    const script = c.req.param("script");
    if (!script) return c.json({ error: "missing script name" }, 400);
    return proxyDaemon(c, `/_sandbox/exec/${encodeURIComponent(script)}`);
  });

  app.post("/:virtualMcpId/:branch/exec/:script/kill", (c) => {
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
  app.post("/:virtualMcpId/:branch/setup/:step", async (c) => {
    const step = c.req.param("step");
    if (!step || !isSetupStep(step)) {
      return c.json(
        { error: `step must be one of: ${SETUP_STEPS.join(", ")}` },
        400,
      );
    }
    // On "start", refresh the daemon's env from the virtual MCP's current
    // `metadata.runtime.env`. The dev script inherits env at spawn time, so
    // edits made after the last SANDBOX_START don't reach a running process
    // unless we push the freshly-resolved env to /config before the
    // orchestrator restarts it.
    if (step === "start") {
      const claim = c.get("vmClaim");
      if (claim.runner) {
        const organization = requireOrganization(c.var.studioContext);
        const entries = readValidatedRuntimeEnv(claim.virtualMcpMetadata);
        try {
          await resolveAndPushEnv({
            ctx: c.var.studioContext,
            runner: claim.runner,
            handle: claim.claimName,
            orgId: organization.id,
            userId: claim.userId,
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
  app.get("/:virtualMcpId/:branch/git/status", (c) =>
    proxyDaemon(c, "/_sandbox/git/status", {
      method: "GET",
      map404to410: true,
      signal: AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(GIT_STATUS_TIMEOUT_MS),
      ]),
    }),
  );
  app.post("/:virtualMcpId/:branch/git/status", (c) =>
    proxyDaemon(c, "/_sandbox/git/status", {
      map404to410: true,
      signal: AbortSignal.any([
        c.req.raw.signal,
        AbortSignal.timeout(GIT_STATUS_TIMEOUT_MS),
      ]),
    }),
  );
  app.post("/:virtualMcpId/:branch/git/diff", (c) =>
    proxyDaemon(c, "/_sandbox/git/diff", {
      forwardJsonBody: true,
      map404to410: true,
    }),
  );
  app.post("/:virtualMcpId/:branch/git/publish", async (c) => {
    const runner = requireRunner(c);
    if (runner instanceof Response) return runner;

    const { claimName, virtualMcpMetadata, connectionIds } = c.get("vmClaim");
    const ctx = c.var.studioContext;

    try {
      await patchSandboxOperator(ctx, runner, claimName);
      const githubRepo = parseGithubRepoFromMetadata(
        virtualMcpMetadata,
        connectionIds,
      );
      if (githubRepo) {
        await refreshSandboxGitCredentials(ctx, runner, claimName, githubRepo);
      }
    } catch (err) {
      if (err instanceof GitPushAuthError) {
        return c.json({ error: err.message }, 403, SANDBOX_PROXY_CACHE_HEADERS);
      }
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 502, SANDBOX_PROXY_CACHE_HEADERS);
    }

    return proxyDaemon(c, "/_sandbox/git/publish", {
      forwardJsonBody: true,
      map404to410: true,
    });
  });
  app.post("/:virtualMcpId/:branch/git/discard", (c) =>
    proxyDaemon(c, "/_sandbox/git/discard", {
      forwardJsonBody: true,
      map404to410: true,
    }),
  );
  app.post("/:virtualMcpId/:branch/git/rebase", async (c) => {
    const runner = requireRunner(c);
    if (runner instanceof Response) return runner;

    const { claimName } = c.get("vmClaim");
    const ctx = c.var.studioContext;

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
      const runner = requireRunner(c);
      if (runner instanceof Response) return runner;

      const { claimName, userId, projectRef } = c.get("vmClaim");
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
            : await Promise.all([
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
              ]);
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

  // -- Preview fetch (CORS proxy for /.decofile) ----------------------------
  // /live/_meta is fetched directly from the preview URL by the client
  // (the deco dev server allows CORS `*` for it). /.decofile must go through
  // this proxy because cloud previews don't expose it cross-origin.
  app.get("/:virtualMcpId/:branch/preview-fetch", async (c) => {
    const runner = requireRunner(c);
    if (runner instanceof Response) return runner;

    const { claimName } = c.get("vmClaim");
    const path = c.req.query("path");
    if (path !== "/.decofile") {
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
    let upstream: Response;
    try {
      upstream = await fetch(loopback?.url ?? `${base}${path}`, {
        ...(loopback ? { headers: { host: loopback.hostHeader } } : {}),
      });
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
      let upstream: Response;
      try {
        upstream = await fetch(loopback?.url ?? invokeUrl, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(loopback ? { host: loopback.hostHeader } : {}),
          },
          body: JSON.stringify(invoke.payload),
          signal: AbortSignal.timeout(30_000),
        });
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
    },
  );

  return app;
};
