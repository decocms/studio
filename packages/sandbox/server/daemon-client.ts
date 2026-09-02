/**
 * Pure helpers for the unified daemon's HTTP API. Daemon endpoints live
 * under `/_sandbox/*` (except `/health` at root, which is unauth).
 */

import type { ConfigPatch, TenantConfig } from "../daemon-protocol";
import { sleep } from "../shared";
import { retry, type RetryOptions } from "@decocms/shared/std";

export type { ConfigPatch };

/** Error thrown by config requests when the daemon responds non-2xx; carries
 *  the HTTP status so callers can branch (e.g. 401 → re-auth with another
 *  token rather than tear the sandbox down). */
export class ConfigRequestError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(`sandbox daemon /_sandbox/config returned ${status}: ${body}`);
    this.name = "ConfigRequestError";
  }
}

/** Returns true if an error is transient and should be retried. Distinguishes
 * network/timeout failures (retriable) from other errors (permanent). */
function isTransientError(err: unknown): boolean {
  // Network errors (DNS, connection refused, etc.) are transient
  if (err instanceof TypeError) {
    return true;
  }
  // AbortError from timeout is transient
  if (err instanceof DOMException && err.name === "AbortError") {
    return true;
  }
  return false;
}

/**
 * Call a daemon endpoint and read its whole body, labelling any transport
 * failure with the endpoint that failed. Retries on transient errors
 * (network timeouts, connection failures) with exponential backoff.
 *
 * `AbortSignal.timeout()` rejects with a bare DOMException whose message is
 * "The operation timed out." — no URL, no endpoint, no hint that a sandbox was
 * even involved. Unwrapped, that string is what a run surfaces to the user: a
 * montecarlo run failed with exactly `Error: The operation timed out.` and
 * nothing anywhere — not the thread row, not the logs — recorded what had timed
 * out. Every other timeout on this path already says what it was waiting for;
 * these are the ones that did not.
 *
 * The body is read HERE, not by the caller, because the same signal aborts it:
 * a daemon that sends headers and then stalls rejects the `.text()`, and a
 * `.text()` awaited outside this try is exactly the unlabelled DOMException
 * again. Every caller wants the body anyway.
 *
 * `timeoutMs` is applied via a *fresh* `AbortSignal.timeout()` on every
 * attempt — not one built once by the caller and reused. A signal that has
 * already fired stays fired, so reusing it across retries would make every
 * attempt after the first one that times out fail instantly with the same
 * stale AbortError instead of getting its own timeout window.
 */
async function daemonRequest(
  url: string,
  init: Omit<RequestInit, "signal">,
  endpoint: string,
  timeoutMs: number,
): Promise<{ status: number; ok: boolean; body: string }> {
  try {
    const retryOpts: RetryOptions = {
      maxAttempts: 3,
      minTimeout: 50,
      maxTimeout: 500,
      multiplier: 2,
      jitter: 0.5,
      isRetriable: isTransientError,
    };

    return await retry(async () => {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, ok: res.ok, body: await res.text() };
    }, retryOpts);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `[SANDBOX_UNREACHABLE] sandbox daemon ${endpoint} request failed: ${message}`,
      {
        cause: err,
      },
    );
  }
}

const HEALTH_PROBE_TIMEOUT_MS = 500;
// Config application can run a cold clone + install on a heavy sandbox; 10s was
// too tight and routinely tripped `AbortSignal.timeout()`, surfacing benign
// "operation timed out" aborts as a chronic error spike. 30s gives cold starts
// headroom. Callers may override per-call via `postConfig`'s `timeoutMs`.
const CONFIG_TIMEOUT_MS = 30_000;
const READY_ATTEMPTS = 25;
const READY_INTERVAL_MS = 200;
const READY_JITTER_MS = 50;

export interface ConfigResponse {
  bootId: string;
  transition: string;
  config: TenantConfig;
}

export interface DaemonHealth {
  ready: boolean;
  bootId: string;
  configured: boolean;
  setup: { running: boolean; done: boolean };
}

export async function probeDaemonHealth(
  daemonUrl: string,
): Promise<DaemonHealth | null> {
  try {
    const res = await fetch(`${daemonUrl}/health`, {
      signal: AbortSignal.timeout(HEALTH_PROBE_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as Partial<DaemonHealth>;
    if (
      typeof body === "object" &&
      body !== null &&
      typeof body.bootId === "string" &&
      typeof body.ready === "boolean" &&
      body.setup &&
      typeof body.setup.running === "boolean" &&
      typeof body.setup.done === "boolean"
    ) {
      return body as DaemonHealth;
    }
    return null;
  } catch {
    return null;
  }
}

/** Polls /health; throws on timeout. Resolves as soon as the daemon's /health returns a valid shape (setup may still be in-flight). */
export async function waitForDaemonReady(daemonUrl: string): Promise<void> {
  for (let i = 0; i < READY_ATTEMPTS; i++) {
    if ((await probeDaemonHealth(daemonUrl)) !== null) return;
    const jitter = (Math.random() * 2 - 1) * READY_JITTER_MS;
    await sleep(READY_INTERVAL_MS + jitter);
  }
  throw new Error(
    `sandbox daemon at ${daemonUrl} did not respond on /health within ${
      (READY_ATTEMPTS * READY_INTERVAL_MS) / 1000
    }s`,
  );
}

/**
 * Optional bootstrap-time fields that travel alongside the tenant patch.
 * Stripped from the persisted config daemon-side; consumed only as
 * side-effects on the request itself.
 */
export interface ConfigAuthPatch {
  /**
   * Replace the daemon's in-memory bearer token. Authorized via the
   * *current* token (i.e. the `token` argument to `postConfig`); on
   * success, subsequent calls must use `rotateToken`. Used by the
   * agent-sandbox runner's warm-pool bootstrap to swap the
   * SandboxTemplate-baked sentinel for a per-claim secret without
   * needing a separate endpoint.
   */
  rotateToken?: string;
}

export interface ConfigRequestOptions {
  /** Override the abort timeout (ms). Defaults to `CONFIG_TIMEOUT_MS`. */
  timeoutMs?: number;
}

/**
 * POST /_sandbox/config — set initial tenant config (or patch via
 * the same payload semantics; deep-merge happens daemon-side).
 *
 * `/config` is the trust boundary endpoint; the daemon's NetworkPolicy is
 * the auth on its port. 200 = applied (or no-op); 400 = invalid;
 * 409 = identity conflict (e.g., cloneUrl mismatch).
 *
 * `auth.rotateToken` is applied *before* the tenant patch — see
 * `ConfigAuthPatch.rotateToken`.
 */
export async function postConfig(
  daemonUrl: string,
  token: string,
  payload: ConfigPatch,
  auth?: ConfigAuthPatch,
  opts?: ConfigRequestOptions,
): Promise<ConfigResponse> {
  return configRequest(daemonUrl, token, "POST", payload, auth, opts);
}

async function configRequest(
  daemonUrl: string,
  token: string,
  method: "POST" | "PUT",
  payload: ConfigPatch,
  auth?: ConfigAuthPatch,
  opts?: ConfigRequestOptions,
): Promise<ConfigResponse> {
  const wire: Record<string, unknown> = { ...payload };
  if (auth && auth.rotateToken !== undefined) wire.auth = auth;
  const res = await daemonRequest(
    `${daemonUrl}/_sandbox/config`,
    {
      method,
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(wire),
    },
    "/_sandbox/config",
    opts?.timeoutMs ?? CONFIG_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new ConfigRequestError(res.status, res.body);
  }
  return parseJsonResponse<ConfigResponse>(res.body, "/_sandbox/config");
}

/**
 * POST /_sandbox/setup/{step} — re-run a setup step against the config the
 * daemon already holds. `clone` chains into install + start, so it is the one
 * call a warm-pool refresh needs: fetch + reset to origin, reinstall only if
 * the lockfile moved, restart dev.
 */
export async function postSetupStep(
  daemonUrl: string,
  token: string,
  step: "clone" | "install" | "start",
): Promise<void> {
  const res = await daemonRequest(
    `${daemonUrl}/_sandbox/setup/${step}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
    },
    `/_sandbox/setup/${step}`,
    CONFIG_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(
      `sandbox daemon /_sandbox/setup/${step} returned ${res.status}: ${res.body}`,
    );
  }
}

/**
 * POST /_sandbox/orgfs-config — relay the org-fs mount config (a JSON
 * `OrgFsMountConfig`) for the pod's privileged sidecar. Separate from
 * `/config` on purpose: an orgFs-only TenantConfig patch classifies as no-op
 * and would be dropped by the daemon's config store. Returns whether the
 * daemon actually relayed it (false = no sidecar configured).
 */
export async function postOrgFsConfig(
  daemonUrl: string,
  token: string,
  configJson: string,
): Promise<{ written: boolean }> {
  const res = await daemonRequest(
    `${daemonUrl}/_sandbox/orgfs-config`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: configJson,
    },
    "/_sandbox/orgfs-config",
    CONFIG_TIMEOUT_MS,
  );
  if (!res.ok) {
    throw new Error(
      `sandbox daemon /_sandbox/orgfs-config returned ${res.status}: ${res.body}`,
    );
  }
  return parseJsonResponse<{ written: boolean }>(
    res.body,
    "/_sandbox/orgfs-config",
  );
}

/**
 * A malformed 2xx body (truncated response, a proxy's HTML error page mistaken
 * for success) must not surface as a bare, unlabelled `SyntaxError` — see the
 * rationale on `daemonRequest` above for why every failure on this path names
 * its endpoint.
 */
function parseJsonResponse<T>(body: string, endpoint: string): T {
  try {
    return JSON.parse(body) as T;
  } catch (err) {
    throw new Error(
      `sandbox daemon ${endpoint} returned a malformed JSON body: ${body.slice(0, 200)}`,
      { cause: err },
    );
  }
}

const STRIP_REQUEST_HEADERS = [
  "cookie",
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "accept-encoding",
  "content-length",
];

export async function proxyDaemonRequest(
  daemonUrl: string,
  token: string,
  path: string,
  init: {
    method: string;
    headers: Headers;
    body: BodyInit | null;
    signal?: AbortSignal;
  },
): Promise<Response> {
  const headers = new Headers(init.headers);
  for (const h of STRIP_REQUEST_HEADERS) headers.delete(h);
  headers.set("authorization", `Bearer ${token}`);
  const hasBody = init.method !== "GET" && init.method !== "HEAD";
  const target = `${daemonUrl}${path.startsWith("/") ? path : `/${path}`}`;
  return fetch(target, {
    method: init.method,
    headers,
    body: hasBody ? init.body : undefined,
    redirect: "manual",
    signal: init.signal,
    // @ts-expect-error Bun/Undici-only: allow streaming request body.
    duplex: hasBody ? "half" : undefined,
  });
}
