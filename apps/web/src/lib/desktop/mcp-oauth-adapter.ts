/**
 * The desktop half of MCP OAuth: consent happens in the user's real browser,
 * and the authorization code comes back through the local API.
 *
 * `window.open` returns `null` unconditionally inside a Tauri webview —
 * WKWebView has no popup or tab concept and Tauri spawns no webview for it —
 * so the shared flow's popup and new-tab attempts both fail and it throws
 * "Popup was blocked" before the user ever sees a consent screen. Handing the
 * authorize URL to the system browser is also what keeps this working as more
 * providers are connected: Google rejects embedded webviews outright
 * (`disallowed_useragent`).
 *
 * The provider then redirects the BROWSER to `/_auth/mcp-callback`, which the
 * Rust local API owns (`crates/local-api/src/routes/mcp_callback.rs`). It
 * parks the result; this module collects it and hands it back to the shared
 * flow, which still performs the state comparison and the token exchange.
 *
 * Paths are relative on purpose: the webview's origin IS the local API in a
 * packaged build, and Vite proxies `/_auth` to it in dev, so both resolve
 * correctly and both send the per-launch session cookie that guards the read.
 */
import {
  setMcpOAuthBrowserAdapter,
  type McpOAuthCallbackData,
} from "@/sdk/lib/mcp-oauth";
import { openExternalUrlInSystemBrowser } from "./tauri-bridge";

const CALLBACK_PATH = "/_auth/mcp-callback";
const RESULT_PATH = "/_auth/mcp-callback/result";

/**
 * Install the desktop adapter. Called once at boot from the native entry;
 * the plain web build never calls it, so nothing about the browser flow
 * changes there.
 */
export function initializeDesktopMcpOAuth(): void {
  setMcpOAuthBrowserAdapter({
    // Absolute, because it is registered with the provider as a redirect URI.
    redirectUrl: new URL(CALLBACK_PATH, window.location.origin).href,

    async openAuthorizationUrl(url: string): Promise<void> {
      await openExternalUrlInSystemBrowser(url);
    },

    async discardPendingCallback(): Promise<void> {
      await fetch(RESULT_PATH, {
        method: "DELETE",
        credentials: "include",
      });
    },

    async pollCallback(): Promise<McpOAuthCallbackData | null> {
      const response = await fetch(RESULT_PATH, { credentials: "include" });
      if (!response.ok) return null;
      const body = await response.json();
      if (body?.status !== "ready") return null;
      return {
        success: body.success === true,
        code: body.code ?? undefined,
        state: body.state ?? undefined,
        error: body.error ?? undefined,
      };
    },
  });
}
