/**
 * Native web transport bootstrap.
 *
 * The packaged UI is served by local-api at the same HTTP origin as its API.
 * Native development preserves that contract through Vite's same-origin
 * proxy. Consequently this module does not patch `fetch`, rewrite URLs, or
 * attach a bearer token to application requests.
 *
 * Before React mounts, `initializeDesktopTransport()` exchanges the one-time
 * secret returned by Tauri IPC for an HttpOnly local session cookie. Every
 * subsequent relative request then uses ordinary browser credentials. The
 * secret is kept in this module's initialization closure and is never exposed.
 */
import { fetchLocalApiInfo } from "@/lib/desktop/tauri-bridge";
import { initializeDesktopMcpOAuth } from "@/lib/desktop/mcp-oauth-adapter";

let initializationPromise: Promise<void> | null = null;

async function responseDetail(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return body
    ? `${response.status} ${body.slice(0, 300)}`
    : `${response.status} ${response.statusText}`.trim();
}

async function probeLocalSession(): Promise<Response> {
  return fetch("/_local/session", {
    method: "GET",
    credentials: "include",
    headers: { Accept: "application/json" },
  });
}

async function establishLocalSession(secret: string): Promise<void> {
  const existing = await probeLocalSession();
  if (existing.status === 204) return;
  if (existing.status !== 401) {
    throw new Error(
      `Could not check the native session: ${await responseDetail(existing)}`,
    );
  }

  const bootstrap = await fetch("/_local/session/bootstrap", {
    method: "POST",
    credentials: "include",
    headers: { Authorization: `Bearer ${secret}` },
  });
  if (bootstrap.status !== 204) {
    throw new Error(
      `Could not establish the native session: ${await responseDetail(bootstrap)}`,
    );
  }

  // Verify that WebKit accepted the HttpOnly cookie. This catches cookie
  // attribute or dev-origin drift immediately instead of letting the shell
  // mount and turn every API request into an unrelated 401.
  const verified = await probeLocalSession();
  if (verified.status !== 204) {
    throw new Error(
      `The native session was not retained: ${await responseDetail(verified)}`,
    );
  }
}

/**
 * Establish the local browser session exactly once, before React mounts.
 * Concurrent callers share the same initialization and one-time secret.
 */
export function initializeDesktopTransport(): Promise<void> {
  if (!initializationPromise) {
    initializationPromise = fetchLocalApiInfo().then(async (info) => {
      await establishLocalSession(info.token);
      // After the session exists, since the adapter's callback read is guarded
      // by it. Synchronous and side-effect-free beyond installing the hook.
      initializeDesktopMcpOAuth();
    });
  }
  return initializationPromise;
}
