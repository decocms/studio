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

/**
 * Simple hash function for server URLs
 */
function hashServerUrl(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Override origin for OAuth redirect URIs.
 * Set via `setOAuthRedirectOrigin()` when the browser runs behind a proxy
 * (e.g. tokyo.localhost) that external OAuth servers may not accept.
 */
let _oauthRedirectOrigin: string | null = null;

/**
 * Set a custom origin for OAuth redirect URIs.
 * Call this at app init with the server's internal URL (e.g. http://localhost:3000)
 * so that external OAuth servers accept the redirect URI.
 */
export function setOAuthRedirectOrigin(origin: string): void {
  _oauthRedirectOrigin = origin;
}

/**
 * Get the origin to use for OAuth redirect URIs.
 * Returns the override if set, otherwise falls back to window.location.origin.
 */
function getOAuthRedirectOrigin(): string {
  return _oauthRedirectOrigin ?? window.location.origin;
}

/**
 * Check if we're in a local dev environment (localhost or .localhost subdomain).
 */
function isLocalDev(): boolean {
  const { hostname } = window.location;
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname.endsWith(".localhost")
  );
}

/**
 * Check if a postMessage origin is allowed.
 * In local dev, accept both the current origin and localhost variants.
 */
function isAllowedOrigin(origin: string): boolean {
  if (origin === window.location.origin) return true;
  if (!isLocalDev()) return false;
  try {
    const url = new URL(origin);
    return (
      url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname.endsWith(".localhost")
    );
  } catch {
    return false;
  }
}

/**
 * Global in-memory store for active OAuth sessions.
 */
const activeOAuthSessions = new Map<string, McpOAuthProvider>();

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
  private serverUrl: string;
  private _clientMetadata: OAuthClientMetadata;
  private _redirectUrl: string;
  private _windowMode: OAuthWindowMode;

  // In-memory storage for OAuth flow data
  private _state: string | null = null;
  private _codeVerifier: string | null = null;
  private _clientInfo: OAuthClientInformation | null = null;
  private _tokens: OAuthTokens | null = null;

  constructor(options: McpOAuthProviderOptions) {
    this.serverUrl = options.serverUrl;
    this._redirectUrl =
      options.callbackUrl ?? `${getOAuthRedirectOrigin()}/oauth/callback`;
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
      client_name: options.clientName ?? "Deco Studio MCP client",
      // Only include scope if explicitly provided - some servers have their own scope requirements
      ...(scopeStr && { scope: scopeStr }),
    };

    // Register this session for callback handling
    activeOAuthSessions.set(hashServerUrl(this.serverUrl), this);
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

  getServerUrl(): string {
    return this.serverUrl;
  }

  cleanup(): void {
    activeOAuthSessions.delete(hashServerUrl(this.serverUrl));
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
}

/**
 * Authenticate with an MCP server using OAuth
 * @param params.connectionId - The connection ID to authenticate
 * @param params.meshUrl - Mesh server URL (optional, defaults to window.location.origin for same-origin apps)
 * @param params.clientName - OAuth client name
 * @param params.clientUri - OAuth client URI
 * @param params.callbackUrl - OAuth callback URL (defaults to current origin + /oauth/callback)
 * @param params.timeout - Timeout in ms (default 120000)
 * @param params.scope - OAuth scopes to request
 * @param params.windowMode - "popup" (default) or "tab" (for devices that block popups)
 */
export async function authenticateMcp(params: {
  connectionId: string;
  /** Mesh server URL - optional, defaults to window.location.origin (for external apps, provide your Mesh server URL) */
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
  const baseUrl = params.meshUrl ?? window.location.origin;
  const serverUrl = new URL(`/mcp/${params.connectionId}`, baseUrl);
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
        const timeout = params.timeout || 120000;
        let timeoutId: ReturnType<typeof setTimeout>;
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
            });
          } catch (err) {
            cleanup();
            reject(err);
          }
        };

        // Primary: Listen for postMessage from popup
        const handleMessage = async (event: MessageEvent) => {
          if (!isAllowedOrigin(event.origin)) return;
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

    // Start the auth flow
    const result: AuthResult = await auth(provider, { serverUrl });

    if (result === "REDIRECT") {
      const fullResult = await oauthCompletePromise;
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
        },
        error: null,
      };
    }

    // If we got here without redirect, check for tokens
    const tokens = provider.tokens();
    const clientInfo = provider.clientInformation();
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
    return {
      token: null,
      tokenInfo: null,
      error: error instanceof Error ? error.message : String(error),
    };
  } finally {
    provider.cleanup();
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
    // In local dev the redirect URI (localhost:PORT) may differ from the
    // opener origin (e.g. proxy.localhost). Use the configured redirect origin
    // so the message is scoped to a known origin rather than "*".
    const target = isLocalDev()
      ? getOAuthRedirectOrigin()
      : window.location.origin;
    window.opener.postMessage(data, target);
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
 * Extract connection ID from MCP proxy URL
 */
function extractConnectionIdFromUrl(url: string): string | null {
  try {
    // Use current origin as base for relative URLs (browser only)
    const base = getCurrentOrigin();
    const urlObj = base ? new URL(url, base) : new URL(url);
    const match = urlObj.pathname.match(/^\/mcp\/([^/]+)/);
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

/**
 * Check if connection has a stored OAuth token
 * @param connectionId - The connection ID to check
 * @param apiBaseUrl - Base URL for the API call (optional, defaults to relative path)
 */
async function checkOAuthTokenStatus(
  connectionId: string,
  apiBaseUrl?: string,
): Promise<{ hasToken: boolean }> {
  try {
    const path = `/api/connections/${connectionId}/oauth-token/status`;
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
 * @param params.url - The MCP URL to check
 * @param params.token - Authorization token (optional)
 * @param params.meshUrl - Mesh server URL for API calls (optional, defaults to URL origin)
 */
export async function isConnectionAuthenticated({
  url,
  token,
  meshUrl,
}: {
  url: string;
  token: string | null;
  /** Mesh server URL for API calls - optional, defaults to extracting from url parameter */
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
            name: "Deco Studio MCP client",
            version: "1.0.0",
          },
        },
      }),
    });

    // Extract connection ID for OAuth token status check
    const connectionId = extractConnectionIdFromUrl(url);
    // Determine base URL for API calls (meshUrl > URL origin > current origin)
    // Use current origin as base for relative URLs (browser only)
    const base = getCurrentOrigin();
    const apiBaseUrl =
      meshUrl ?? (base ? new URL(url, base).origin : new URL(url).origin);

    if (response.ok) {
      // Check if we have an OAuth token stored for this connection
      const oauthStatus = connectionId
        ? await checkOAuthTokenStatus(connectionId, apiBaseUrl)
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
    return {
      isAuthenticated: false,
      supportsOAuth: false,
      hasOAuthToken: false,
      error: (error as Error).message,
    };
  }
}
