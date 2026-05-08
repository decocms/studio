/**
 * Pure helpers for the unified daemon's HTTP API. Daemon endpoints live
 * under `/_decopilot_vm/*` (except `/health` at root, which is unauth).
 * POST/PUT bodies are base64-encoded JSON — the daemon decodes on its side.
 */

import type { TenantConfig } from "../daemon/types";
import { sleep } from "../shared";
import type { ExecInput, ExecOutput } from "./runner/types";

const DEFAULT_EXEC_TIMEOUT_MS = 60_000;
const HEALTH_PROBE_TIMEOUT_MS = 500;
const CONFIG_TIMEOUT_MS = 10_000;
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

/**
 * POST /_decopilot_vm/config — set initial tenant config (or patch via
 * the same payload semantics; deep-merge happens daemon-side).
 *
 * `/config` is the trust boundary endpoint; the daemon's NetworkPolicy is
 * the auth on its port. Body is base64-encoded JSON like every other
 * `/_decopilot_vm/*` route. 200 = applied (or no-op); 400 = invalid;
 * 409 = identity conflict (e.g., cloneUrl mismatch).
 *
 * `auth.rotateToken` is applied *before* the tenant patch — see
 * `ConfigAuthPatch.rotateToken`.
 */
export async function postConfig(
  daemonUrl: string,
  token: string,
  payload: Partial<TenantConfig>,
  auth?: ConfigAuthPatch,
): Promise<ConfigResponse> {
  return configRequest(daemonUrl, token, "POST", payload, auth);
}

async function configRequest(
  daemonUrl: string,
  token: string,
  method: "POST" | "PUT",
  payload: Partial<TenantConfig>,
  auth?: ConfigAuthPatch,
): Promise<ConfigResponse> {
  const wire: Record<string, unknown> = { ...payload };
  if (auth && auth.rotateToken !== undefined) wire.auth = auth;
  const rawBody = JSON.stringify(wire);
  const b64Body = Buffer.from(rawBody, "utf-8").toString("base64");
  const res = await fetch(`${daemonUrl}/_decopilot_vm/config`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: b64Body,
    signal: AbortSignal.timeout(CONFIG_TIMEOUT_MS),
  });
  const body = await res.text();
  if (!res.ok) {
    throw new Error(
      `sandbox daemon /_decopilot_vm/config returned ${res.status}: ${body}`,
    );
  }
  return JSON.parse(body) as ConfigResponse;
}

export async function daemonBash(
  daemonUrl: string,
  token: string,
  input: ExecInput,
): Promise<ExecOutput> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_EXEC_TIMEOUT_MS;
  const rawBody = JSON.stringify({
    command: input.command,
    timeout: timeoutMs,
    cwd: input.cwd,
    env: input.env,
  });
  const b64Body = Buffer.from(rawBody, "utf-8").toString("base64");
  const response = await fetch(`${daemonUrl}/_decopilot_vm/bash`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: b64Body,
    signal: AbortSignal.timeout(timeoutMs + 5_000),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `sandbox daemon /_decopilot_vm/bash returned ${response.status}${body ? `: ${body}` : ""}`,
    );
  }
  const json = (await response.json()) as {
    stdout?: string;
    stderr?: string;
    exitCode?: number;
    timedOut?: boolean;
  };
  return {
    stdout: json.stdout ?? "",
    stderr: json.stderr ?? "",
    exitCode: json.exitCode ?? -1,
    timedOut: Boolean(json.timedOut),
  };
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
