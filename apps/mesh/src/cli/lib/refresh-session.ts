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
  access_token: string;
  refresh_token?: string;
  expires_in?: number;
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

  const data = (await res.json()) as TokenResponse;
  if (typeof data.access_token !== "string") {
    throw new RefreshFailedError(
      "transient",
      "Token endpoint returned no access_token",
    );
  }

  return {
    ...session,
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? session.refreshToken,
    expiresAt: data.expires_in
      ? Math.floor(now() / 1000) + data.expires_in
      : session.expiresAt,
  };
}
