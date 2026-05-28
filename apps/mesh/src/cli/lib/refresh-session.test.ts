import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { Session } from "./session";
import { RefreshFailedError, refreshSession } from "./refresh-session";

const TARGET = "https://studio.decocms.com";
const FIXED_NOW = 1_700_000_000_000; // ms

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    target: TARGET,
    clientId: "client_abc",
    user: { sub: "u_1", email: "tlgimenes@gmail.com" },
    accessToken: "old_at",
    refreshToken: "rt_xyz",
    expiresAt: Math.floor(FIXED_NOW / 1000) - 60, // expired
    createdAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("refreshSession", () => {
  it("returns an updated session on 200 success", async () => {
    const fetchMock = mock(async (url: string, init?: RequestInit) => {
      expect(url).toBe(`${TARGET}/api/auth/mcp/token`);
      const body = new URLSearchParams(init?.body as string);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("refresh_token")).toBe("rt_xyz");
      expect(body.get("client_id")).toBe("client_abc");
      return new Response(
        JSON.stringify({
          access_token: "new_at",
          refresh_token: "new_rt",
          expires_in: 3600,
          token_type: "Bearer",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const result = await refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );

    expect(result.accessToken).toBe("new_at");
    expect(result.refreshToken).toBe("new_rt");
    expect(result.expiresAt).toBe(Math.floor(FIXED_NOW / 1000) + 3600);
    expect(result.user).toEqual(makeSession().user);
    expect(result.clientId).toBe("client_abc");
    expect(result.target).toBe(TARGET);
  });

  it("keeps the previous refresh token when the server omits one", async () => {
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ access_token: "new_at", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );

    const result = await refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );

    expect(result.refreshToken).toBe("rt_xyz");
  });

  it("throws RefreshFailedError(invalid_grant) on 400", async () => {
    const fetchMock = mock(
      async () => new Response("invalid_grant", { status: 400 }),
    );
    const promise = refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toBeInstanceOf(RefreshFailedError);
    await expect(promise).rejects.toMatchObject({ kind: "invalid_grant" });
  });

  it("throws RefreshFailedError(transient) on 500", async () => {
    const fetchMock = mock(async () => new Response("oops", { status: 500 }));
    const promise = refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
  });

  it("throws RefreshFailedError(transient) when fetch rejects", async () => {
    const fetchMock = mock(async () => {
      throw new Error("ECONNREFUSED");
    });
    const promise = refreshSession(
      makeSession(),
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
  });

  it("throws when session has no refreshToken", async () => {
    const session = makeSession({ refreshToken: undefined });
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    const promise = refreshSession(
      session,
      fetchMock as unknown as typeof fetch,
      () => FIXED_NOW,
    );
    await expect(promise).rejects.toMatchObject({ kind: "invalid_grant" });
  });
});
