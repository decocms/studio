/**
 * MCP OAuth Client Utilities
 *
 * Provides OAuth authentication flow for MCP servers.
 * Uses the MCP SDK's auth module with in-memory storage.
 */

import {
  auth,
  exchangeAuthorization,
  discoverOAuthProtectedResourceMetadata,
  discoverAuthorizationServerMetadata,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientProvider,
  AuthResult,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientMetadata,
  OAuthClientInformation,
  OAuthClientInformationFull,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import { resolveStudioUrl } from "./studio-url";

function getOAuthRedirectOrigin(): string {
  return window.location.origin;
}

/**
 * Check if we're in a local dev environment (localhost or .localhost subdomain).
 */
function isLocalDev(): boolean {
  try {
    const hostname = window.location.hostname;
    return (
      hostname === "localhost" ||
      hostname.endsWith(".localhost") ||
      hostname === "127.0.0.1" ||
      hostname === "::1"
    );
  } catch {
    return false;
  }
}

/**
 * Storage key prefix for OAuth callback fallback
 */
const OAUTH_CALLBACK_STORAGE_KEY = "mcp:oauth:callback:";

/**
 * Window mode for OAuth flow
 * - "popup": Opens in a popup window (default, may be blocked on some devices)
 * - "tab": Opens in a new tab (works on all devices, uses localStorage for communication)
 */
export type OAuthWindowMode = "popup" | "tab";

/** One OAuth callback, however it reached us. */
export interface McpOAuthCallbackData {
  success: boolean;
  code?: string;
  state?: string;
  error?: string;
}

/**
 * Completes the consent step in the user's real browser instead of a popup.
 *
 * Installed by hosts where `window.open` cannot work. In a Tauri webview it
 * returns `null` unconditionally — WKWebView has no popup or tab concept and
 * Tauri spawns no webview for it — so both attempts in
 * `redirectToAuthorization` fail and the flow dies with "Popup was blocked"
 * before the user sees a consent screen.
 *
 * Once consent happens in a different browser process, neither of this
 * module's return channels can carry the result home: `window.opener` is not
 * reachable across processes, and the `storage` event needs a shared
 * `localStorage`. So an adapter supplies its own redirect target and its own
 * way to collect what landed there.
 *
 * This is injected rather than imported so the SDK stays host-agnostic — a
 * direct import would pull the host's platform bindings into every build,
 * including plain web.
 */
export interface McpOAuthBrowserAdapter {
  /** Absolute URL the provider is told to redirect back to. */
  redirectUrl: string;
  /** Hand the authorize URL to the real browser. */
  openAuthorizationUrl(url: string): Promise<void>;
  /** Drop a callback left over from a flow nobody is waiting for. */
  discardPendingCallback(): Promise<void>;
  /** One poll: the callback, or `null` while none has landed yet. */
  pollCallback(): Promise<McpOAuthCallbackData | null>;
}

let browserAdapter: McpOAuthBrowserAdapter | null = null;

/** Install (or clear, with `null`) the browser-completed OAuth adapter. */
export function setMcpOAuthBrowserAdapter(
  adapter: McpOAuthBrowserAdapter | null,
): void {
  browserAdapter = adapter;
}

/** How often to ask the adapter whether the callback has landed. */
const ADAPTER_POLL_INTERVAL_MS = 600;

/** How often to read the localStorage callback key directly. The `storage`
 * event is not delivered reliably everywhere (observed lost in Edge after
 * GitHub's COOP hop severs `window.opener`, leaving localStorage as the only
 * channel home), so the event listener gets this poll as a belt. */
const STORAGE_POLL_INTERVAL_MS = 1_000;

/**
 * Default ceiling for the whole consent round trip. First-time authorizations
 * routinely take minutes (provider login, 2FA, org/app install screens), and a
 * shorter timer was killing flows the user then completed into a void — the
 * popup reported success while nobody was listening anymore. We cannot watch
 * the popup instead: after a COOP-severing hop (github.com) its WindowProxy is
 * disowned and `closed` reads true mid-flow.
 */
const DEFAULT_OAUTH_TIMEOUT_MS = 10 * 60_000;

/**
 * Ceiling for the `initialize` probe in `isConnectionAuthenticated`. Without
 * it, a hung MCP server left the caller waiting on the browser's own fetch
 * timeout (which can be minutes), showing a stuck "checking connection" UI
 * instead of a clear error.
 */
const CONNECTION_CHECK_TIMEOUT_MS = 15_000;

/**
 * Options for the MCP OAuth provider
 */
export interface McpOAuthProviderOptions {
  /** MCP server URL */
  serverUrl: string;
  /** OAuth client name */
  clientName?: string;
  /** OAuth client URI */
  clientUri?: string;
  /** OAuth callback URL */
  callbackUrl?: string;
  /** OAuth scopes to request (space-separated or array). If not provided, no scope is requested */
  scope?: string | string[];
  /** Window mode: "popup" (default) or "tab" (for devices that block popups) */
  windowMode?: OAuthWindowMode;
}

/**
 * MCP OAuth client provider using in-memory storage only.
 * No localStorage or sessionStorage - everything is ephemeral.
 */
class McpOAuthProvider implements OAuthClientProvider {
  private _clientMetadata: OAuthClientMetadata;
  private _redirectUrl: string;
  private _windowMode: OAuthWindowMode;

  // In-memory storage for OAuth flow data
  private _state: string | null = null;
  private _codeVerifier: string | null = null;
  private _clientInfo: OAuthClientInformation | null = null;
  private _tokens: OAuthTokens | null = null;

  constructor(options: McpOAuthProviderOptions) {
    // An explicit callbackUrl still wins; otherwise an installed adapter picks
    // the target, because the page that receives the redirect has to be one
    // the adapter can actually read the result back out of.
    this._redirectUrl =
      options.callbackUrl ??
      browserAdapter?.redirectUrl ??
      `${getOAuthRedirectOrigin()}/oauth/callback`;
    this._windowMode = options.windowMode ?? "popup";

    // Build scope string if provided
    const scopeStr = options.scope
      ? Array.isArray(options.scope)
        ? options.scope.join(" ")
        : options.scope
      : undefined;

    this._clientMetadata = {
      redirect_uris: [this._redirectUrl],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: options.clientName ?? "Deco Studio",
      // Only include scope if explicitly provided - some servers have their own scope requirements
      ...(scopeStr && { scope: scopeStr }),
    };
  }

  get redirectUrl(): string {
    return this._redirectUrl;
  }

  get clientMetadata(): OAuthClientMetadata {
    return this._clientMetadata;
  }

  state(): string {
    if (!this._state) {
      this._state = crypto.randomUUID();
    }
    return this._state;
  }

  getStoredState(): string | null {
    return this._state;
  }

  clientInformation(): OAuthClientInformation | undefined {
    return this._clientInfo ?? undefined;
  }

  saveClientInformation(clientInfo: OAuthClientInformationFull): void {
    this._clientInfo = clientInfo;
  }

  tokens(): OAuthTokens | undefined {
    return this._tokens ?? undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    this._tokens = tokens;
  }

  redirectToAuthorization(authorizationUrl: URL): void {
    // Hosts without a working `window.open` hand consent to the real browser.
    // Fire-and-forget by contract: this method is synchronous, and the result
    // arrives through the adapter's own channel, not through a window handle.
    if (browserAdapter) {
      void browserAdapter.openAuthorizationUrl(authorizationUrl.toString());
      return;
    }
    if (this._windowMode === "tab") {
      // Open in new tab - uses localStorage for cross-tab communication
      const tab = window.open(authorizationUrl.toString(), "_blank");
      if (!tab) {
        throw new Error("Tab was blocked");
      }
    } else {
      // Open in popup (default)
      const width = 600;
      const height = 700;
      const left = window.screenX + (window.outerWidth - width) / 2;
      const top = window.screenY + (window.outerHeight - height) / 2;

      const popup = window.open(
        authorizationUrl.toString(),
        "mcp-oauth",
        `width=${width},height=${height},left=${left},top=${top},popup=yes`,
      );

      if (!popup) {
        // Popup was blocked - fallback to new tab (uses localStorage for communication)
        const tab = window.open(authorizationUrl.toString(), "_blank");
        if (!tab) {
          throw new Error("Popup was blocked");
        }
      }
    }
  }

  saveCodeVerifier(codeVerifier: string): void {
    this._codeVerifier = codeVerifier;
  }

  codeVerifier(): string {
    if (!this._codeVerifier) {
      throw new Error("Code verifier not found");
    }
    return this._codeVerifier;
  }

  invalidateCredentials(): void {
    this._clientInfo = null;
    this._tokens = null;
    this._codeVerifier = null;
    this._state = null;
  }
}

/**
 * Full OAuth token info for persistence
 */
export interface OAuthTokenInfo {
  accessToken: string;
  refreshToken: string | null;
  expiresIn: number | null;
  scope: string | null;
  // Dynamic Client Registration info
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
  /** OIDC ID token (JWT) returned by some providers (e.g. Google). Contains user identity claims like email. */
  idToken: string | null;
  /** OIDC userinfo endpoint URL from authorization server metadata. Can be called with the access token to retrieve user identity. */
  userinfoEndpoint: string | null;
}

/**
 * Result from authenticateMcp
 */
export interface AuthenticateMcpResult {
  token: string | null;
  /** Full token info for persistence (includes refresh token) */
  tokenInfo: OAuthTokenInfo | null;
  error: string | null;
}

/**
 * Extended token result with all info needed for persistence
 */
interface FullTokenResult {
  tokens: OAuthTokens;
  clientId: string | null;
  clientSecret: string | null;
  tokenEndpoint: string | null;
  userinfoEndpoint: string | null;
}

/**
 * Authenticate with an MCP server using OAuth
 * @param params.connectionId - The connection ID to authenticate
 * @param params.studioUrl - Studio server URL (optional, defaults to window.location.origin for same-origin apps)
 * @param params.clientName - OAuth client name
 * @param params.clientUri - OAuth client URI
 * @param params.callbackUrl - OAuth callback URL (defaults to current origin + /oauth/callback)
 * @param params.timeout - Timeout in ms (default 600000 — see DEFAULT_OAUTH_TIMEOUT_MS)
 * @param params.scope - OAuth scopes to request
 * @param params.windowMode - "popup" (default) or "tab" (for devices that block popups)
 */
export async function authenticateMcp(params: {
  connectionId: string;
  /** Organization slug — used to build the org-scoped /api/:org/mcp/... URL. */
  orgSlug?: string;
  /** Studio server URL - optional, defaults to window.location.origin (for external apps, provide your Studio server URL) */
  studioUrl?: string;
  /** @deprecated Use `studioUrl` instead. */
  meshUrl?: string;
  clientName?: string;
  clientUri?: string;
  callbackUrl?: string;
  timeout?: number;
  /** OAuth scopes to request. If not provided, no scope is requested (server decides) */
  scope?: string | string[];
  /** Window mode: "popup" (default) or "tab" (for devices that block popups). Tab mode uses localStorage for cross-tab communication. */
  windowMode?: OAuthWindowMode;
}): Promise<AuthenticateMcpResult> {
  const baseUrl = resolveStudioUrl(params, window.location.origin);
  const path = params.orgSlug
    ? `/api/${encodeURIComponent(params.orgSlug)}/mcp/${params.connectionId}`
    : `/mcp/${params.connectionId}`;
  const serverUrl = new URL(path, baseUrl);
  const provider = new McpOAuthProvider({
    serverUrl: serverUrl.href,
    clientName: params.clientName,
    clientUri: params.clientUri,
    callbackUrl: params.callbackUrl,
    scope: params.scope,
    windowMode: params.windowMode,
  });

  // Object to hold the abort function - using an object wrapper so TypeScript
  // properly tracks mutations inside closures
  const oauthAbort: { fn: ((error: Error) => void) | null } = { fn: null };

  try {
    // Wait for OAuth callback message from popup and handle token exchange
    // Uses both postMessage (primary) and localStorage (fallback for when opener is lost)
    const oauthCompletePromise = new Promise<FullTokenResult>(
      (resolve, reject) => {
        const timeout = params.timeout || DEFAULT_OAUTH_TIMEOUT_MS;
        let timeoutId: ReturnType<typeof setTimeout>;
        let pollId: ReturnType<typeof setInterval> | undefined;
        let storagePollId: ReturnType<typeof setInterval> | undefined;
        let resolved = false;
        // Use the OAuth state as the storage key - it's already unique per flow
        // and will be available to the callback page via URL params
        const oauthState = provider.state();
        const storageKey = `${OAUTH_CALLBACK_STORAGE_KEY}${oauthState}`;

        const cleanup = () => {
          // Note: Race condition prevention is handled in processCallback by setting
          // resolved = true immediately. This function just does the actual cleanup.
          window.removeEventListener("message", handleMessage);
          window.removeEventListener("storage", handleStorageEvent);
          clearTimeout(timeoutId);
          clearInterval(pollId);
          clearInterval(storagePollId);
          // Clean up storage key
          try {
            localStorage.removeItem(storageKey);
          } catch {
            // Ignore storage errors
          }
        };

        // Expose abort function so we can clean up if auth() throws
        oauthAbort.fn = (error: Error) => {
          if (resolved) return;
          resolved = true;
          cleanup();
          reject(error);
        };

        const processCallback = async (data: {
          success: boolean;
          code?: string;
          state?: string;
          error?: string;
        }) => {
          // Set resolved immediately to prevent race condition with concurrent callbacks
          if (resolved) return;
          resolved = true;

          if (!data.success) {
            cleanup();
            reject(new Error(data.error || "OAuth authentication failed"));
            return;
          }

          const { code, state } = data;

          if (!code) {
            cleanup();
            reject(new Error("Missing authorization code"));
            return;
          }

          // Verify state matches
          const storedState = provider.getStoredState();
          if (storedState !== state) {
            cleanup();
            reject(new Error("OAuth state mismatch - possible CSRF attack"));
            return;
          }

          try {
            // Do token exchange in parent window (we have provider in memory)
            const resourceMetadata =
              await discoverOAuthProtectedResourceMetadata(serverUrl);
            const authServerUrl =
              resourceMetadata?.authorization_servers?.[0] || serverUrl;
            const authServerMetadata =
              await discoverAuthorizationServerMetadata(authServerUrl);

            const clientInfo = provider.clientInformation();
            if (!clientInfo) {
              cleanup();
              reject(new Error("Client information not found"));
              return;
            }

            const codeVerifier = provider.codeVerifier();

            const tokens = await exchangeAuthorization(authServerUrl, {
              metadata: authServerMetadata,
              clientInformation: clientInfo,
              authorizationCode: code,
              codeVerifier,
              redirectUri: provider.redirectUrl,
              resource: new URL(serverUrl),
            });

            cleanup();

            // Resolve with full result including client info for token refresh
            resolve({
              tokens,
              clientId: clientInfo.client_id ?? null,
              clientSecret:
                "client_secret" in clientInfo
                  ? (clientInfo.client_secret as string)
                  : null,
              tokenEndpoint: authServerMetadata?.token_endpoint ?? null,
              userinfoEndpoint:
                (authServerMetadata?.userinfo_endpoint as
                  | string
                  | null
                  | undefined) ?? null,
            });
          } catch (err) {
            cleanup();
            reject(err);
          }
        };

        // Primary: Listen for postMessage from popup
        const handleMessage = async (event: MessageEvent) => {
          // In local dev, accept messages from any origin because the popup
          // runs at localhost:PORT while the opener may be at *.localhost (proxy)
          if (!isLocalDev() && event.origin !== window.location.origin) return;
          if (event.data?.type === "mcp:oauth:callback") {
            await processCallback(event.data);
          }
        };

        // Fallback: Listen for localStorage events (when window.opener is lost)
        const handleStorageEvent = async (event: StorageEvent) => {
          if (event.key !== storageKey || !event.newValue) return;
          try {
            const data = JSON.parse(event.newValue);
            await processCallback(data);
          } catch {
            // Ignore parse errors
          }
        };

        window.addEventListener("message", handleMessage);
        window.addEventListener("storage", handleStorageEvent);

        // Belt for the storage listener above — read the key directly too,
        // since the event alone is what gets lost (see
        // STORAGE_POLL_INTERVAL_MS). processCallback dedupes via `resolved`.
        storagePollId = setInterval(() => {
          if (resolved) return;
          let raw: string | null = null;
          try {
            raw = localStorage.getItem(storageKey);
          } catch {
            return; // Storage unavailable — rely on the other channels.
          }
          if (!raw) return;
          try {
            void processCallback(JSON.parse(raw));
          } catch {
            // Ignore parse errors, same as the storage-event path.
          }
        }, STORAGE_POLL_INTERVAL_MS);

        // Third channel: when consent completes in a separate browser process
        // neither listener above can ever fire, so ask the adapter instead.
        // A failed poll is not fatal — the app may simply be mid-restart —
        // so it retries until the shared timeout below gives up.
        if (browserAdapter) {
          const adapter = browserAdapter;
          pollId = setInterval(() => {
            if (resolved) return;
            adapter
              .pollCallback()
              .then(async (data) => {
                if (data && !resolved) await processCallback(data);
              })
              .catch(() => {});
          }, ADAPTER_POLL_INTERVAL_MS);
        }

        timeoutId = setTimeout(() => {
          if (resolved) return;
          resolved = true;
          cleanup();
          reject(new Error("OAuth authentication timeout"));
        }, timeout);
      },
    );

    // Attach a no-op catch to prevent unhandled rejection if auth() throws
    // (we'll abort the promise properly in the catch block, but this is a safety net)
    oauthCompletePromise.catch(() => {});

    // Drop anything parked by a flow nobody is waiting for (consent granted,
    // then the app quit before collecting it). The state check would reject a
    // stale entry anyway, but the user would see "state mismatch — possible
    // CSRF attack" instead of a working connection. Must happen before `auth`
    // opens the browser, and never blocks the flow if it fails.
    if (browserAdapter) {
      await browserAdapter.discardPendingCallback().catch(() => {});
    }

    // Start the auth flow
    const result: AuthResult = await auth(provider, { serverUrl });

    if (result === "REDIRECT") {
      const fullResult = await oauthCompletePromise;
      const rawTokens = fullResult.tokens as unknown as Record<string, unknown>;
      return {
        token: fullResult.tokens.access_token,
        tokenInfo: {
          accessToken: fullResult.tokens.access_token,
          refreshToken: fullResult.tokens.refresh_token ?? null,
          expiresIn: fullResult.tokens.expires_in ?? null,
          scope: fullResult.tokens.scope ?? null,
          clientId: fullResult.clientId,
          clientSecret: fullResult.clientSecret,
          tokenEndpoint: fullResult.tokenEndpoint,
          userinfoEndpoint: fullResult.userinfoEndpoint,
          idToken:
            typeof rawTokens.id_token === "string" ? rawTokens.id_token : null,
        },
        error: null,
      };
    }

    // If we got here without redirect, check for tokens
    const tokens = provider.tokens();
    const clientInfo = provider.clientInformation();
    const rawTokens = tokens as unknown as Record<string, unknown> | null;
    return {
      token: tokens?.access_token || null,
      tokenInfo: tokens
        ? {
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token ?? null,
            expiresIn: tokens.expires_in ?? null,
            scope: tokens.scope ?? null,
            clientId: clientInfo?.client_id ?? null,
            clientSecret:
              clientInfo && "client_secret" in clientInfo
                ? (clientInfo.client_secret as string)
                : null,
            tokenEndpoint: null, // Would need to be passed through
            userinfoEndpoint: null,
            idToken:
              rawTokens && typeof rawTokens.id_token === "string"
                ? rawTokens.id_token
                : null,
          }
        : null,
      error: null,
    };
  } catch (error) {
    // Abort the OAuth promise to trigger cleanup (clear timeout, remove event listeners)
    // This prevents unhandled promise rejections and lingering listeners
    if (oauthAbort.fn) {
      oauthAbort.fn(error instanceof Error ? error : new Error(String(error)));
    }
    const raw = error instanceof Error ? error.message : String(error);
    const looksLikeFigmaDcr = /figma|mcp catalog/i.test(raw);
    return {
      token: null,
      tokenInfo: null,
      error: looksLikeFigmaDcr
        ? `${raw} Studio is not on Figma's MCP Catalog yet — a PAT will not work. https://www.figma.com/mcp-catalog/`
        : raw,
    };
  }
}

/**
 * Send callback data via postMessage or localStorage fallback
 * @param data - The callback data to send
 * @param state - The OAuth state parameter (used as localStorage key for fallback)
 */
function sendCallbackData(
  data: {
    type: string;
    success: boolean;
    code?: string;
    state?: string;
    error?: string;
  },
  state: string | null,
): boolean {
  // Try postMessage first (primary method)
  if (window.opener && !window.opener.closed) {
    // In local dev, use "*" because the popup (localhost:PORT) and opener
    // (*.localhost proxy) are different origins — targeted postMessage would be silently dropped
    const targetOrigin = isLocalDev() ? "*" : window.location.origin;
    window.opener.postMessage(data, targetOrigin);
    return true;
  }

  // Fallback: Use localStorage to communicate with parent window
  // This works even when window.opener is lost due to redirects
  // Use the OAuth state as the key since the parent window knows it
  if (state) {
    try {
      const storageKey = `${OAUTH_CALLBACK_STORAGE_KEY}${state}`;
      localStorage.setItem(storageKey, JSON.stringify(data));
      return true;
    } catch {
      // Ignore storage errors
    }
  }

  return false;
}

/**
 * Handle the OAuth callback (to be called from the callback page)
 *
 * Forwards the authorization code to the parent window via postMessage.
 * Falls back to localStorage if window.opener is not available (common with OAuth redirects).
 * The parent window handles the token exchange.
 */
export async function handleOAuthCallback(): Promise<{
  success: boolean;
  error?: string;
}> {
  const params = new URLSearchParams(window.location.search);
  const code = params.get("code");
  let state = params.get("state");
  const errorParam = params.get("error");
  const errorDescription = params.get("error_description");

  // Try to decode wrapped state from deco.cx first (needed for localStorage key)
  let decodedState = state;
  if (state) {
    try {
      const decoded = atob(state);
      const stateObj = JSON.parse(decoded);
      if (stateObj.clientState) {
        decodedState = stateObj.clientState;
      }
    } catch {
      // Use state as-is
    }
  }

  if (errorParam) {
    const errorMsg = errorDescription || errorParam;
    sendCallbackData(
      {
        type: "mcp:oauth:callback",
        success: false,
        error: errorMsg,
      },
      decodedState,
    );
    return {
      success: false,
      error: errorMsg,
    };
  }

  if (!code || !state) {
    const error = "Missing code or state parameter";
    sendCallbackData(
      {
        type: "mcp:oauth:callback",
        success: false,
        error,
      },
      decodedState,
    );
    return {
      success: false,
      error,
    };
  }

  // Use the decoded state for the callback
  state = decodedState || state;

  // Forward code and state to parent window for token exchange
  const sent = sendCallbackData(
    {
      type: "mcp:oauth:callback",
      success: true,
      code,
      state,
    },
    state,
  );

  if (sent) {
    return { success: true };
  }

  return {
    success: false,
    error: "Parent window not available",
  };
}

/**
 * Authentication status for an MCP connection
 */
export interface McpAuthStatus {
  /** Whether the connection is authenticated and working */
  isAuthenticated: boolean;
  /** Whether the server supports OAuth (has WWW-Authenticate header on 401) */
  supportsOAuth: boolean;
  /** Whether the current authentication is via OAuth (has stored OAuth token) */
  hasOAuthToken: boolean;
  /** Error message if authentication failed */
  error?: string;
  /** Whether this was a server error (5xx) - OAuth support is unknown in this case */
  isServerError?: boolean;
}

/**
 * Get the current origin for URL resolution.
 * Returns window.location.origin in browser, undefined on server.
 */
function getCurrentOrigin(): string | undefined {
  if (typeof window !== "undefined" && window.location?.origin) {
    return window.location.origin;
  }
  return undefined;
}

/**
 * Extract connection ID from MCP proxy URL.
 * Supports both legacy `/mcp/:id` and org-scoped `/api/:org/mcp/:id` paths.
 */
function extractConnectionIdFromUrl(url: string): string | null {
  try {
    // Use current origin as base for relative URLs (browser only)
    const base = getCurrentOrigin();
    const urlObj = base ? new URL(url, base) : new URL(url);
    const orgScoped = urlObj.pathname.match(/^\/api\/[^/]+\/mcp\/([^/]+)/);
    if (orgScoped) return orgScoped[1] ?? null;
    const legacy = urlObj.pathname.match(/^\/mcp\/([^/]+)/);
    return legacy?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Extract org slug from an org-scoped MCP proxy URL (`/api/:org/mcp/...`).
 * Returns null for legacy `/mcp/...` URLs.
 */
function extractOrgSlugFromUrl(url: string): string | null {
  try {
    const base = getCurrentOrigin();
    const urlObj = base ? new URL(url, base) : new URL(url);
    const match = urlObj.pathname.match(/^\/api\/([^/]+)\/mcp\//);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if connection has a stored OAuth token
 * @param connectionId - The connection ID to check
 * @param orgSlug - Organization slug used to build the org-scoped path
 * @param apiBaseUrl - Base URL for the API call (optional, defaults to relative path)
 */
async function checkOAuthTokenStatus(
  connectionId: string,
  orgSlug: string,
  apiBaseUrl?: string,
): Promise<{ hasToken: boolean }> {
  try {
    const path = `/api/${encodeURIComponent(orgSlug)}/connections/${connectionId}/oauth-token/status`;
    const url = apiBaseUrl ? new URL(path, apiBaseUrl).href : path;
    const currentOrigin = getCurrentOrigin();
    const isSameOrigin =
      !apiBaseUrl || new URL(apiBaseUrl).origin === currentOrigin;
    const response = await fetch(url, {
      credentials: isSameOrigin ? "include" : "omit", // Don't send cookies for cross-origin
    });
    if (!response.ok) {
      return { hasToken: false };
    }
    const data = await response.json();
    return { hasToken: data.hasToken === true };
  } catch {
    return { hasToken: false };
  }
}

/**
 * Check if an MCP connection is authenticated and whether it supports OAuth
 * @param params.url - The org-scoped MCP URL to check (`/api/:org/mcp/...`)
 * @param params.token - Authorization token (optional)
 * @param params.orgId - Organization ID (deprecated; org is now resolved from the URL path)
 * @param params.studioUrl - Studio server URL for API calls (optional, defaults to URL origin)
 */
export async function isConnectionAuthenticated({
  url,
  token,
  orgId: _orgId,
  studioUrl,
  meshUrl,
}: {
  url: string;
  token: string | null;
  /** @deprecated Org is resolved from the URL path; this is kept for call-site compatibility. */
  orgId?: string;
  /** Studio server URL for API calls - optional, defaults to extracting from url parameter */
  studioUrl?: string;
  /** @deprecated Use `studioUrl` instead. */
  meshUrl?: string;
}): Promise<McpAuthStatus> {
  try {
    const headers = new Headers();
    headers.set("Content-Type", "application/json");
    headers.set("Accept", "application/json, text/event-stream");
    if (token) {
      headers.set("Authorization", `Bearer ${token}`);
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: {
            name: "Deco Studio",
            version: "1.0.0",
          },
        },
      }),
      signal: AbortSignal.timeout(CONNECTION_CHECK_TIMEOUT_MS),
    });

    // Extract connection ID for OAuth token status check
    const connectionId = extractConnectionIdFromUrl(url);
    const orgSlug = extractOrgSlugFromUrl(url);
    // Determine the Studio base URL for API calls.
    // Use current origin as base for relative URLs (browser only)
    const base = getCurrentOrigin();
    const apiBaseUrl = resolveStudioUrl(
      { studioUrl, meshUrl },
      base ? new URL(url, base).origin : new URL(url).origin,
    );

    if (response.ok) {
      // Check if we have an OAuth token stored for this connection
      const oauthStatus =
        connectionId && orgSlug
          ? await checkOAuthTokenStatus(connectionId, orgSlug, apiBaseUrl)
          : { hasToken: false };

      return {
        isAuthenticated: true,
        // When authenticated, we can't determine OAuth support from the response
        // (no 401 to check WWW-Authenticate header). Default to false.
        supportsOAuth: false,
        hasOAuthToken: oauthStatus.hasToken,
      };
    }

    // Try to get error message from response body
    let error: string | undefined;
    try {
      const body = await response.json();
      error = body.error || body.message;
    } catch {
      // Ignore JSON parse errors
    }

    // Handle 5xx server errors separately - we can't determine OAuth support
    if (response.status >= 500) {
      return {
        isAuthenticated: false,
        supportsOAuth: false,
        hasOAuthToken: false,
        error: error || `HTTP ${response.status}`,
        isServerError: true,
      };
    }

    // For 401/403, check if server supports OAuth by looking for WWW-Authenticate header
    const wwwAuth = response.headers.get("WWW-Authenticate");
    const supportsOAuth = !!wwwAuth;

    return {
      isAuthenticated: false,
      supportsOAuth,
      hasOAuthToken: false,
      error: error || `HTTP ${response.status}`,
    };
  } catch (error) {
    console.error("[isConnectionAuthenticated] Error:", error);
    const isTimeout = error instanceof Error && error.name === "TimeoutError";
    return {
      isAuthenticated: false,
      supportsOAuth: false,
      hasOAuthToken: false,
      error: isTimeout
        ? `Connection check timed out after ${CONNECTION_CHECK_TIMEOUT_MS / 1000}s`
        : (error as Error).message,
    };
  }
}
