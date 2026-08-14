import type { Session } from "./session";

export class RefreshFailedError extends Error {
  readonly kind: "invalid_grant" | "transient";

  constructor(kind: "invalid_grant" | "transient", message: string) {
    super(message);
    this.name = "RefreshFailedError";
    this.kind = kind;
  }
}

interface TokenResponse {
  access_token: unknown;
  refresh_token?: unknown;
  expires_in?: unknown;
  token_type?: string;
}

/**
 * Exchanges the session's refresh token for a fresh access token.
 *
 * Returns an updated Session object (caller is responsible for persisting it).
 * Throws RefreshFailedError("invalid_grant") if the refresh token is rejected
 * (4xx) or absent; throws RefreshFailedError("transient") for network/server
 * errors (5xx, fetch rejections).
 */
export async function refreshSession(
  session: Session,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): Promise<Session> {
  if (!session.refreshToken) {
    throw new RefreshFailedError(
      "invalid_grant",
      "Session has no refresh token",
    );
  }

  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: session.refreshToken,
    client_id: session.clientId,
  });

  let res: Response;
  try {
    res = await fetchImpl(`${session.target}/api/auth/mcp/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });
  } catch (err) {
    throw new RefreshFailedError(
      "transient",
      err instanceof Error ? err.message : String(err),
    );
  }

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    if (res.status >= 400 && res.status < 500) {
      throw new RefreshFailedError(
        "invalid_grant",
        `HTTP ${res.status} ${text}`,
      );
    }
    throw new RefreshFailedError("transient", `HTTP ${res.status} ${text}`);
  }

  let data: TokenResponse;
  try {
    data = (await res.json()) as TokenResponse;
  } catch (err) {
    throw new RefreshFailedError(
      "transient",
      `Token endpoint returned a non-JSON body: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  // Valid JSON (e.g. `null`) can still be a non-object — reject before property access.
  if (typeof data !== "object" || data === null) {
    throw new RefreshFailedError(
      "transient",
      "Token endpoint returned a non-object JSON body",
    );
  }

  if (typeof data.access_token !== "string" || !data.access_token) {
    throw new RefreshFailedError(
      "transient",
      "Token endpoint returned no access_token",
    );
  }

  // expires_in is untrusted server input — reject non-finite/non-positive values.
  const parsedExpiresIn = Number(data.expires_in);
  const expiresAt =
    Number.isFinite(parsedExpiresIn) && parsedExpiresIn > 0
      ? Math.floor(now() / 1000) + parsedExpiresIn
      : session.expiresAt;

  // refresh_token is untrusted server input — reject a non-string value.
  const refreshToken =
    typeof data.refresh_token === "string" && data.refresh_token
      ? data.refresh_token
      : session.refreshToken;

  return {
    ...session,
    accessToken: data.access_token,
    refreshToken,
    expiresAt,
  };
}
