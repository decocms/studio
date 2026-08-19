/**
 * Errors thrown while resolving the outbound credentials for a downstream
 * MCP request.
 *
 * The MCP proxy catches these and turns them into structured tool errors so
 * Claude Desktop (or any other client) can surface an actionable message —
 * typically a URL the user has to open to finish authorising.
 */

/**
 * Thrown by the token resolver when the connection is configured with
 * `auth_mode = "per_user"` and the caller has not yet authorised the
 * downstream provider with their own account.
 *
 * `authorizeUrl` is an in-Studio URL — opening it kicks off the OAuth
 * proxy authorize flow on behalf of the current session.
 */
export class PerUserAuthorizationRequiredError extends Error {
  public readonly connectionId: string;
  public readonly authorizeUrl: string;
  public readonly connectionTitle: string;

  constructor(args: {
    connectionId: string;
    connectionTitle: string;
    authorizeUrl: string;
  }) {
    super(
      `This connection requires per-user authorization. ` +
        `Connect your "${args.connectionTitle}" account: ${args.authorizeUrl}`,
    );
    this.name = "PerUserAuthorizationRequiredError";
    this.connectionId = args.connectionId;
    this.connectionTitle = args.connectionTitle;
    this.authorizeUrl = args.authorizeUrl;
  }
}

export function isPerUserAuthorizationRequiredError(
  error: unknown,
): error is PerUserAuthorizationRequiredError {
  return error instanceof PerUserAuthorizationRequiredError;
}

/**
 * Render a `PerUserAuthorizationRequiredError` as an HTTP 401 response that
 * non-browser MCP clients (Claude Desktop, Cursor, etc.) can surface to the
 * end user. The body is intentionally simple and the authorize URL is also
 * mirrored in custom headers so dumb clients can grab it without parsing
 * JSON.
 */
export function renderPerUserAuthorizationRequired(
  error: PerUserAuthorizationRequiredError,
): Response {
  const body = {
    error: "per_user_authorization_required",
    message: error.message,
    connection_id: error.connectionId,
    connection_title: error.connectionTitle,
    authorize_url: error.authorizeUrl,
  };

  return new Response(JSON.stringify(body), {
    status: 401,
    headers: {
      "Content-Type": "application/json",
      "WWW-Authenticate": `Bearer realm="${error.connectionId}", error="per_user_authorization_required", authorize_url="${error.authorizeUrl}"`,
      "X-Authorize-Url": error.authorizeUrl,
    },
  });
}
