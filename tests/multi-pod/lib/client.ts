/**
 * Pod-pinned HTTP client.
 *
 * Every helper takes a `PodInfo` so tests can target a specific pod (no LB,
 * no sticky sessions, no guesswork). Auth is passed per call rather than
 * stored on the client — most multi-pod scenarios share one auth context
 * across multiple pod targets, so the client itself stays auth-agnostic.
 *
 * Header building (Origin, Bearer, Cookie) lives in
 * `tests/shared/lib/fetch.ts` so this stack and resilience can't drift
 * on what Better Auth expects.
 */

import {
  type AuthOpts as Auth,
  fetchWithAuth,
  type FetchWithAuthOpts,
} from "../../shared/lib/fetch";
import type { PodInfo } from "./pods";

export type { Auth };
export type FetchOpts = FetchWithAuthOpts;

/** Low-level: `fetch` against a specific pod, auth applied. */
export async function fetchOn(
  pod: PodInfo,
  path: string,
  opts?: FetchOpts,
): Promise<Response> {
  return fetchWithAuth(pod.baseUrl, path, opts);
}

/** POST + JSON body convenience. Throws on non-2xx so tests fail loudly. */
export async function postJson(
  pod: PodInfo,
  path: string,
  body: unknown,
  opts?: FetchOpts,
): Promise<Response> {
  const headers = new Headers(opts?.headers);
  headers.set("Content-Type", "application/json");

  const res = await fetchOn(pod, path, {
    ...opts,
    method: "POST",
    body: JSON.stringify(body),
    headers,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(
      `POST ${pod.service} ${path} → HTTP ${res.status}: ${text}`,
    );
  }
  return res;
}

/** GET + JSON convenience. */
export async function getJson<T = unknown>(
  pod: PodInfo,
  path: string,
  opts?: FetchOpts,
): Promise<T> {
  const res = await fetchOn(pod, path, opts);
  if (!res.ok) {
    const text = await res.text().catch(() => "<unreadable>");
    throw new Error(`GET ${pod.service} ${path} → HTTP ${res.status}: ${text}`);
  }
  return (await res.json()) as T;
}

/**
 * Extract session cookies from a Set-Cookie response. Better Auth replies
 * with multiple cookies (session token + CSRF token); we collapse them into
 * a single `name=value; name=value` header value ready to re-send.
 */
export function extractSessionCookie(res: Response): string {
  const setCookies = res.headers.getSetCookie?.() ?? [];
  return setCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");
}

/**
 * Open an SSE stream and yield each `data:` payload until the response
 * ends or the abort signal fires. The /stream endpoint emits AI-SDK UI
 * message chunks as SSE; the consumer typically only cares about
 * specific `type` values (e.g. "text-delta") and aborts once it's
 * collected enough.
 */
export async function* sse(
  pod: PodInfo,
  path: string,
  opts?: FetchOpts,
): AsyncGenerator<string, void, unknown> {
  const headers = new Headers(opts?.headers);
  headers.set("Accept", "text/event-stream");

  const res = await fetchOn(pod, path, { ...opts, headers });
  if (!res.ok || !res.body) {
    const text = res.ok
      ? "<no body>"
      : await res.text().catch(() => "<unreadable>");
    throw new Error(
      `SSE GET ${pod.service} ${path} → HTTP ${res.status}: ${text}`,
    );
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });

      // SSE frames are delimited by a blank line ("\n\n"). Each frame may
      // span multiple "data: ..." lines; we concat them and yield once.
      let sepIdx: number;
      while ((sepIdx = buffer.indexOf("\n\n")) !== -1) {
        const frame = buffer.slice(0, sepIdx);
        buffer = buffer.slice(sepIdx + 2);
        const payload = frame
          .split("\n")
          .filter((l) => l.startsWith("data:"))
          .map((l) => l.slice(5).trimStart())
          .join("\n");
        if (payload) yield payload;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
