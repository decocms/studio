/**
 * Thin wrapper around the Tauri v2 IPC commands the shell exposes (see the
 * shared IPC/boot contract in the Phase 3 brief / `docs/plans/desktop-
 * the desktop migration contract` §3.1-3.3). Every call in this file is
 * side-effecting IPC — not unit-tested per TESTING.md ("if a test needs
 * mock.module … it's not a unit test"); the pure request/response SHAPES
 * live in `./transport-rules.ts` and the various `*-api.ts` modules, which
 * ARE unit-tested.
 *
 * `invoke()` is only ever called after confirming the Tauri IPC bridge is
 * actually present in this window (`__TAURI_INTERNALS__`) — a RUNTIME probe,
 * deliberately NOT the build-time `isDesktopAppEnvironment()` gate. The two
 * diverge in exactly the case this guard protects: the desktop bundle
 * (`VITE_TAURI_APP=1`) loaded outside Tauri (`vite preview`, or opening
 * the built `index.native.html` in a plain browser tab) — there the build flag is
 * `"1"` but no bridge exists, so `invoke()` would throw an opaque IPC error;
 * this throws a clear, typed error instead. See the "capability vs. gating"
 * note in `hooks/use-is-desktop-app.ts`.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";

declare global {
  interface Window {
    /** Injected by Tauri's webview bridge at boot. Absent in a plain browser
     *  — the presence probe `assertDesktopEnvironment` relies on. */
    __TAURI_INTERNALS__?: unknown;
  }
}

/** Runtime probe: is the Tauri IPC bridge present in this window? Distinct
 *  from `isDesktopAppEnvironment()` (a build-time flag) — see this module's
 *  header comment for why the difference matters here. */
function tauriIpcBridgePresent(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface LocalApiInfo {
  port: number;
  /** The dedicated loopback port serving ONLY the dev-server reverse proxy
   *  (a genuinely separate origin from `port`, per the port-router design —
   *  see `local_api::ServerHandle`'s doc comment). The sandbox preview
   *  iframe's `src` points here, never at `port`. */
  previewPort: number;
  /** Exact upstream Studio deployment configured for this app launch. */
  upstreamUrl: string;
  /** One-time secret exchanged for an HttpOnly local session at boot. */
  token: string;
}

export interface AuthStatus {
  signedIn: boolean;
  userLabel: string | null;
  upstreamUrl: string;
  /** A Keychain read failure is not a signed-out session. */
  storageState: "available" | "unavailable";
}

/** Mutation result omits `upstreamUrl`; callers re-fetch canonical status. */
export interface AuthResult {
  signedIn: boolean;
  userLabel: string | null;
  storageState: "available" | "unavailable";
}

const AUTH_STATUS_CHANGED_EVENT = "auth-status-changed";

/** Thrown when a desktop-only bridge call runs outside the Tauri webview.
 *  Internal to this module's `assertDesktopEnvironment` guard — nothing
 *  outside this file needs to catch it by type today. */
class NotDesktopEnvironmentError extends Error {
  constructor(command: string) {
    super(
      `Tauri command "${command}" was invoked outside the desktop app webview`,
    );
    this.name = "NotDesktopEnvironmentError";
  }
}

function assertDesktopEnvironment(command: string): void {
  if (!tauriIpcBridgePresent()) {
    throw new NotDesktopEnvironmentError(command);
  }
}

/** `invoke('local_api_info')` — the webview learns preview/upstream metadata
 *  and the one-time local-session bootstrap secret. The secret is exchanged
 *  before React mounts and never used as application-request authorization. */
export async function fetchLocalApiInfo(): Promise<LocalApiInfo> {
  assertDesktopEnvironment("local_api_info");
  return invoke<LocalApiInfo>("local_api_info");
}

/** `invoke('auth_status')`. */
export async function fetchAuthStatus(): Promise<AuthStatus> {
  assertDesktopEnvironment("auth_status");
  return invoke<AuthStatus>("auth_status");
}

/** Subscribe to auth transitions published by the native session owner. */
export async function listenForAuthStatus(
  onStatus: (status: AuthStatus) => void,
): Promise<UnlistenFn> {
  assertDesktopEnvironment(AUTH_STATUS_CHANGED_EVENT);
  return listen<AuthStatus>(AUTH_STATUS_CHANGED_EVENT, (event) => {
    onStatus(event.payload);
  });
}

/** `invoke('auth_login')` — opens the system browser for the Rust-side OAuth
 *  PKCE loopback flow; resolves once the loopback callback lands. */
export async function performAuthLogin(): Promise<AuthResult> {
  assertDesktopEnvironment("auth_login");
  return invoke<AuthResult>("auth_login");
}

/** `invoke('auth_logout')` — upstream revoke, then Keychain clear. */
export async function performAuthLogout(): Promise<AuthResult> {
  assertDesktopEnvironment("auth_logout");
  return invoke<AuthResult>("auth_logout");
}

/**
 * `invoke('auth_complete_session')` — the hybrid-login bridge command
 * (`apps/native/src-tauri/src/commands.rs`, built in parallel — see the
 * Phase 3 auth brief). Rust performs the MCP-OAuth authorize request itself
 * using the session cookie local-api's bare `/api/auth/*` proxy just
 * captured into its in-memory jar (never forwarded to this webview),
 * exchanges the resulting code for tokens into the Keychain via the
 * existing `auth_login()` path, then purges the jar.
 *
 * This command's own return value is deliberately NOT treated as the source
 * of truth for sign-in state — callers must re-check `auth_status()`
 * afterward (see `use-desktop-auth.ts`'s `completeSession`), matching the
 * contract's "(5) after bridge success auth_status flips signedIn" design.
 * Only call this after a successful `submitEmailPassword`/OTP submit
 * through the shared auth form — see `sign-in-screen.tsx` /
 * `auth-actions.ts`.
 */
export async function performAuthCompleteSession(): Promise<void> {
  assertDesktopEnvironment("auth_complete_session");
  await invoke("auth_complete_session");
}

/**
 * Open an external URL in the operating system's default browser.
 *
 * `window.open` cannot serve the desktop app's "open the preview outside the
 * app" action: the Tauri webview has no tab strip to open into, so the call
 * either no-ops or replaces the shell itself. The system browser is the only
 * meaningful target there.
 */
export async function openExternalUrlInSystemBrowser(
  url: string,
): Promise<void> {
  assertDesktopEnvironment("plugin:opener|open_url");
  await openUrl(url);
}
