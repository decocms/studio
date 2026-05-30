import type { OAuthClient, OAuthConfig, OAuthParams } from "./tools.ts";

/**
 * Thrown by `OAuthConfig.refreshToken` (or `exchangeCode`) implementations
 * when the upstream OAuth provider says the grant itself is permanently
 * invalid — e.g. GitHub returns `400 invalid_grant` because the user
 * revoked the app or the refresh_token was rotated out from under us.
 *
 * The `/token` handler maps this to an RFC-6749-compliant
 * `400 {"error":"invalid_grant",...}` response, so callers can tell apart
 * "the user needs to reconnect" from a transient upstream 5xx (which the
 * outer catch maps to a 500). Throwing a plain `Error` from `refreshToken`
 * will be treated as transient and surface as 500.
 */
export class OAuthInvalidGrantError extends Error {
  readonly error: string;
  readonly errorDescription?: string;
  constructor(error = "invalid_grant", errorDescription?: string) {
    super(errorDescription ?? error);
    this.name = "OAuthInvalidGrantError";
    this.error = error;
    this.errorDescription = errorDescription;
  }
}

/**
 * Generate a cryptographically secure random token
 */
function generateRandomToken(length = 32): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => chars[byte % chars.length]).join("");
}

/**
 * Validate redirect URI format per OAuth 2.1
 */
function isValidRedirectUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    return (
      url.protocol === "https:" ||
      url.hostname === "localhost" ||
      url.hostname.endsWith(".localhost") ||
      url.hostname === "127.0.0.1" ||
      // Allow custom schemes for native apps (e.g., cursor://, vscode://)
      !url.protocol.startsWith("http")
    );
  } catch {
    return false;
  }
}

/**
 * Encode data as base64url JSON
 */
function encodeState<T>(data: T): string {
  return btoa(JSON.stringify(data))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/**
 * Decode base64url JSON data
 */
function decodeState<T>(encoded: string): T | null {
  try {
    const base64 = encoded.replace(/-/g, "+").replace(/_/g, "/");
    return JSON.parse(atob(base64)) as T;
  } catch {
    return null;
  }
}

interface PendingAuthState {
  redirectUri: string;
  clientState?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
  /** The clean callback URL used for OAuth (without state param) - used in token exchange */
  oauthCallbackUri?: string;
}

interface CodePayload {
  accessToken: string;
  tokenType: string;
  refreshToken?: string;
  expiresIn?: number;
  scope?: string;
  codeChallenge?: string;
  codeChallengeMethod?: string;
}

const forceHttps = (url: URL) => {
  const isLocal =
    url.hostname === "localhost" ||
    url.hostname.endsWith(".localhost") ||
    url.hostname === "127.0.0.1";
  if (!isLocal) {
    url.protocol = "https:";
  }
  return url;
};

/**
 * Create OAuth endpoint handlers for MCP servers
 * The MCP server acts as an OAuth Authorization Server proxy
 * Stateless implementation - no persistence required
 * Per MCP Authorization spec: https://modelcontextprotocol.io/specification/draft/basic/authorization
 */
export function createOAuthHandlers(oauth: OAuthConfig) {
  /**
   * Build OAuth 2.0 Protected Resource Metadata (RFC9728)
   * Points to THIS server as the authorization server
   */
  const handleProtectedResourceMetadata = (req: Request): Response => {
    const url = forceHttps(new URL(req.url));
    const resourceUrl = `${url.origin}/mcp`;

    return Response.json({
      resource: resourceUrl,
      // Point to ourselves - we are the authorization server proxy
      authorization_servers: [url.origin],
      scopes_supported: ["*"],
      bearer_methods_supported: ["header"],
      resource_signing_alg_values_supported: ["RS256", "none"],
    });
  };

  /**
   * Build OAuth 2.0 Authorization Server Metadata (RFC8414)
   * Exposes our endpoints for authorization, token exchange, and registration
   */
  const handleAuthorizationServerMetadata = (req: Request): Response => {
    const url = forceHttps(new URL(req.url));
    const baseUrl = url.origin;

    return Response.json({
      issuer: baseUrl,
      authorization_endpoint: `${baseUrl}/authorize`,
      token_endpoint: `${baseUrl}/token`,
      registration_endpoint: `${baseUrl}/register`,
      scopes_supported: ["*"],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
      code_challenge_methods_supported: ["S256", "plain"],
    });
  };

  /**
   * Handle authorization request - redirects to external OAuth provider
   * Stateless: encodes all needed info in the state parameter
   */
  const handleAuthorize = (req: Request): Response => {
    const url = forceHttps(new URL(req.url));
    const redirectUri = url.searchParams.get("redirect_uri");
    const responseType = url.searchParams.get("response_type");
    const clientState = url.searchParams.get("state");
    const codeChallenge = url.searchParams.get("code_challenge");
    const codeChallengeMethod = url.searchParams.get("code_challenge_method");

    // Validate required params
    if (!redirectUri) {
      return Response.json(
        {
          error: "invalid_request",
          error_description: "redirect_uri required",
        },
        { status: 400 },
      );
    }

    if (responseType !== "code") {
      return Response.json(
        {
          error: "unsupported_response_type",
          error_description: "Only 'code' is supported",
        },
        { status: 400 },
      );
    }

    // Build callback URL pointing to our internal callback (without state yet)
    const callbackUrl = forceHttps(new URL(`${url.origin}/oauth/callback`));
    // Store the clean callback URL for token exchange
    const oauthCallbackUri = callbackUrl.toString();

    // Encode pending auth state (including the clean callback URL)
    const pendingState: PendingAuthState = {
      redirectUri,
      clientState: clientState ?? undefined,
      codeChallenge: codeChallenge ?? undefined,
      codeChallengeMethod: codeChallengeMethod ?? undefined,
      oauthCallbackUri,
    };
    const encodedState = encodeState(pendingState);

    // Add state to callback URL
    callbackUrl.searchParams.set("state", encodedState);

    // Get the external authorization URL from the config
    const externalAuthUrl = oauth.authorizationUrl(callbackUrl.toString());

    // Redirect to external OAuth provider
    return Response.redirect(externalAuthUrl, 302);
  };

  /**
   * Handle OAuth callback from external provider
   * Stateless: decodes state to get redirect info, encodes token in code
   */
  const handleOAuthCallback = async (req: Request): Promise<Response> => {
    const url = forceHttps(new URL(req.url));
    const code = url.searchParams.get("code");
    const encodedState = url.searchParams.get("state");
    const error = url.searchParams.get("error");

    // Decode state
    const pending = encodedState
      ? decodeState<PendingAuthState>(encodedState)
      : null;

    if (error) {
      const errorDescription =
        url.searchParams.get("error_description") ?? "Authorization failed";
      if (pending?.redirectUri) {
        const redirectUrl = forceHttps(new URL(pending.redirectUri));
        redirectUrl.searchParams.set("error", error);
        redirectUrl.searchParams.set("error_description", errorDescription);
        if (pending.clientState)
          redirectUrl.searchParams.set("state", pending.clientState);
        return Response.redirect(redirectUrl.toString(), 302);
      }
      return Response.json(
        { error, error_description: errorDescription },
        { status: 400 },
      );
    }

    if (!code || !pending) {
      return Response.json(
        {
          error: "invalid_request",
          error_description: "Missing code or state",
        },
        { status: 400 },
      );
    }

    try {
      // Use the clean redirect_uri from the state (same URL used in authorization request)
      // This ensures the exact same URL is used for token exchange
      const cleanRedirectUri =
        pending.oauthCallbackUri ??
        forceHttps(new URL(`${url.origin}/oauth/callback`)).toString();

      // Exchange code with external provider
      const oauthParams: OAuthParams = {
        code,
        redirect_uri: cleanRedirectUri,
      };
      const tokenResponse = await oauth.exchangeCode(oauthParams);

      // Encode the token in our own code (stateless)
      const codePayload: CodePayload = {
        accessToken: tokenResponse.access_token,
        tokenType: tokenResponse.token_type,
        refreshToken: tokenResponse.refresh_token,
        expiresIn: tokenResponse.expires_in,
        scope: tokenResponse.scope,
        codeChallenge: pending.codeChallenge,
        codeChallengeMethod: pending.codeChallengeMethod,
      };
      const ourCode = encodeState(codePayload);

      // Redirect back to client with our code
      const redirectUrl = forceHttps(new URL(pending.redirectUri));
      redirectUrl.searchParams.set("code", ourCode);
      if (pending.clientState) {
        redirectUrl.searchParams.set("state", pending.clientState);
      }

      return Response.redirect(redirectUrl.toString(), 302);
    } catch (err) {
      console.error("OAuth callback error:", err);

      // Redirect back to client with error
      const redirectUrl = forceHttps(new URL(pending.redirectUri));
      redirectUrl.searchParams.set("error", "server_error");
      redirectUrl.searchParams.set(
        "error_description",
        "Failed to exchange authorization code",
      );
      if (pending.clientState)
        redirectUrl.searchParams.set("state", pending.clientState);

      return Response.redirect(redirectUrl.toString(), 302);
    }
  };

  /**
   * Handle token exchange - decodes our code to get the actual token
   * Supports both authorization_code and refresh_token grant types
   * Stateless: token is encoded in the code
   */
  const handleToken = async (req: Request): Promise<Response> => {
    try {
      const contentType = req.headers.get("content-type") ?? "";
      let body: Record<string, unknown>;

      if (contentType.includes("application/x-www-form-urlencoded")) {
        const formData = await req.formData();
        body = Object.fromEntries(formData.entries());
      } else {
        const jsonBody = await req.json();
        if (
          typeof jsonBody !== "object" ||
          jsonBody === null ||
          Array.isArray(jsonBody)
        ) {
          return Response.json(
            {
              error: "invalid_request",
              error_description: "Request body must be a JSON object",
            },
            { status: 400 },
          );
        }
        body = jsonBody as Record<string, unknown>;
      }

      // Extract and validate OAuth parameters
      // Per RFC 6749, all parameters should be strings, but we validate at runtime
      const { code, code_verifier, grant_type, refresh_token } = body;

      // Handle refresh_token grant type
      if (grant_type === "refresh_token") {
        if (typeof refresh_token !== "string" || !refresh_token) {
          return Response.json(
            {
              error: "invalid_request",
              error_description:
                "refresh_token is required and must be a string",
            },
            { status: 400 },
          );
        }

        if (!oauth.refreshToken) {
          return Response.json(
            {
              error: "unsupported_grant_type",
              error_description: "refresh_token grant not supported",
            },
            { status: 400 },
          );
        }

        // Call the external provider to refresh the token. We catch
        // `OAuthInvalidGrantError` here (not in the outer catch) so we can
        // map it to a spec-compliant 400 instead of letting all errors fall
        // through to a generic 500. Any other thrown error is treated as
        // transient and surfaces from the outer catch as 500.
        let newTokenResponse: Awaited<
          ReturnType<NonNullable<OAuthConfig["refreshToken"]>>
        >;
        try {
          newTokenResponse = await oauth.refreshToken(refresh_token);
        } catch (err) {
          if (err instanceof OAuthInvalidGrantError) {
            return Response.json(
              {
                error: err.error,
                ...(err.errorDescription
                  ? { error_description: err.errorDescription }
                  : {}),
              },
              { status: 400 },
            );
          }
          throw err;
        }

        const tokenResponse: Record<string, unknown> = {
          access_token: newTokenResponse.access_token,
          token_type: newTokenResponse.token_type,
        };

        if (newTokenResponse.refresh_token) {
          tokenResponse.refresh_token = newTokenResponse.refresh_token;
        }
        if (newTokenResponse.expires_in !== undefined) {
          tokenResponse.expires_in = newTokenResponse.expires_in;
        }
        if (newTokenResponse.scope) {
          tokenResponse.scope = newTokenResponse.scope;
        }

        return Response.json(tokenResponse, {
          headers: {
            "Cache-Control": "no-store",
            Pragma: "no-cache",
          },
        });
      }

      // Handle authorization_code grant type
      if (grant_type !== "authorization_code") {
        return Response.json(
          {
            error: "unsupported_grant_type",
            error_description:
              "Only authorization_code and refresh_token supported",
          },
          { status: 400 },
        );
      }

      if (typeof code !== "string" || !code) {
        return Response.json(
          {
            error: "invalid_request",
            error_description: "code is required and must be a string",
          },
          { status: 400 },
        );
      }

      // Decode the code to get the token
      const payload = decodeState<CodePayload>(code);
      if (!payload || !payload.accessToken) {
        return Response.json(
          {
            error: "invalid_grant",
            error_description: "Invalid or expired code",
          },
          { status: 400 },
        );
      }

      // Verify PKCE if code challenge was provided
      if (payload.codeChallenge) {
        if (typeof code_verifier !== "string" || !code_verifier) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "code_verifier required and must be a string",
            },
            { status: 400 },
          );
        }

        // Verify the code verifier
        let computedChallenge: string;
        if (payload.codeChallengeMethod === "S256") {
          const encoder = new TextEncoder();
          const data = encoder.encode(code_verifier);
          const hash = await crypto.subtle.digest("SHA-256", data);
          computedChallenge = btoa(String.fromCharCode(...new Uint8Array(hash)))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/, "");
        } else {
          computedChallenge = code_verifier;
        }

        if (computedChallenge !== payload.codeChallenge) {
          return Response.json(
            {
              error: "invalid_grant",
              error_description: "Invalid code_verifier",
            },
            { status: 400 },
          );
        }
      }

      // Return the actual token with all fields
      const tokenResponse: Record<string, unknown> = {
        access_token: payload.accessToken,
        token_type: payload.tokenType,
      };

      // Include optional fields if present
      if (payload.refreshToken) {
        tokenResponse.refresh_token = payload.refreshToken;
      }
      if (payload.expiresIn !== undefined) {
        tokenResponse.expires_in = payload.expiresIn;
      }
      if (payload.scope) {
        tokenResponse.scope = payload.scope;
      }

      return Response.json(tokenResponse, {
        headers: {
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      });
    } catch (err) {
      console.error("Token exchange error:", err);
      return Response.json(
        {
          error: "server_error",
          error_description: "Failed to process token request",
        },
        { status: 500 },
      );
    }
  };

  /**
   * Handle dynamic client registration (RFC7591)
   * Stateless: just generates a client_id and returns it, no storage needed
   */
  const handleClientRegistration = async (req: Request): Promise<Response> => {
    try {
      const body = (await req.json()) as {
        redirect_uris?: string[];
        client_name?: string;
        grant_types?: string[];
        response_types?: string[];
        token_endpoint_auth_method?: string;
        scope?: string;
        client_uri?: string;
      };

      // Validate redirect URIs
      if (!body.redirect_uris || body.redirect_uris.length === 0) {
        return Response.json(
          {
            error: "invalid_redirect_uri",
            error_description: "At least one redirect_uri is required",
          },
          { status: 400 },
        );
      }

      for (const uri of body.redirect_uris) {
        if (!isValidRedirectUri(uri)) {
          return Response.json(
            {
              error: "invalid_redirect_uri",
              error_description: `Invalid redirect URI: ${uri}`,
            },
            { status: 400 },
          );
        }
      }

      const clientId = generateRandomToken(32);
      const clientSecret =
        body.token_endpoint_auth_method !== "none"
          ? generateRandomToken(32)
          : undefined;
      const now = Math.floor(Date.now() / 1000);

      const client: OAuthClient = {
        client_id: clientId,
        client_secret: clientSecret,
        client_name: body.client_name,
        redirect_uris: body.redirect_uris,
        grant_types: body.grant_types ?? ["authorization_code"],
        response_types: body.response_types ?? ["code"],
        token_endpoint_auth_method:
          body.token_endpoint_auth_method ?? "client_secret_post",
        scope: body.scope,
        client_id_issued_at: now,
        client_secret_expires_at: 0,
      };

      // Save client if persistence is provided
      if (oauth.persistence) {
        await oauth.persistence.saveClient(client);
      }

      return new Response(JSON.stringify(client), {
        status: 201,
        headers: {
          "Content-Type": "application/json",
          "Cache-Control": "no-store",
          Pragma: "no-cache",
        },
      });
    } catch (err) {
      console.error("Client registration error:", err);
      return Response.json(
        {
          error: "invalid_client_metadata",
          error_description: "Invalid client registration request",
        },
        { status: 400 },
      );
    }
  };

  /**
   * Return 401 with WWW-Authenticate header for unauthenticated MCP requests
   * Per MCP spec: MUST include resource_metadata URL
   */
  const createUnauthorizedResponse = (req: Request): Response => {
    const url = forceHttps(new URL(req.url));
    const resourceMetadataUrl = `${url.origin}/.well-known/oauth-protected-resource`;
    const wwwAuthenticateValue = `Bearer resource_metadata="${resourceMetadataUrl}", scope="*"`;

    return Response.json(
      {
        jsonrpc: "2.0",
        error: {
          code: -32000,
          message: "Unauthorized: Authentication required",
        },
        id: null,
      },
      {
        status: 401,
        headers: {
          "WWW-Authenticate": wwwAuthenticateValue,
          "Access-Control-Expose-Headers": "WWW-Authenticate",
        },
      },
    );
  };

  /**
   * Check if request has authentication token
   */
  const hasAuth = (req: Request) => req.headers.has("Authorization");

  return {
    handleProtectedResourceMetadata,
    handleAuthorizationServerMetadata,
    handleAuthorize,
    handleOAuthCallback,
    handleToken,
    handleClientRegistration,
    createUnauthorizedResponse,
    hasAuth,
  };
}
