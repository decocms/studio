import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidSession } from "./get-valid-session";
import { readSession, type Session, writeSession } from "./session";

const TARGET = "https://studio.decocms.com";
const FIXED_NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(FIXED_NOW_MS / 1000);

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-getvalid-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    target: TARGET,
    clientId: "client_abc",
    user: { sub: "u_1", email: "tlgimenes@gmail.com" },
    accessToken: "at_old",
    refreshToken: "rt_xyz",
    expiresAt: NOW_S + 3600, // fresh
    createdAt: "2026-05-28T00:00:00.000Z",
    ...overrides,
  };
}

describe("getValidSession", () => {
  it("returns null when no session file exists", async () => {
    const result = await getValidSession({
      dataDir: dir,
      fetch: mock(
        async () => new Response("", { status: 500 }),
      ) as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result).toBeNull();
  });

  it("returns the session when it is fresh", async () => {
    await writeSession(dir, makeSession());
    const fetchMock = mock(async () => {
      throw new Error("fetch should not be called for fresh session");
    });
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_old");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a session as expired within the 60s skew window", async () => {
    // expiresAt is 30s in the future — still inside the skew window.
    await writeSession(dir, makeSession({ expiresAt: NOW_S + 30 }));
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({ access_token: "at_new", expires_in: 3600 }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_new");
    expect(fetchMock).toHaveBeenCalled();
  });

  it("refreshes an expired session and rewrites it to disk", async () => {
    await writeSession(dir, makeSession({ expiresAt: NOW_S - 60 }));
    const fetchMock = mock(
      async () =>
        new Response(
          JSON.stringify({
            access_token: "at_new",
            refresh_token: "rt_new",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_new");
    expect(result?.refreshToken).toBe("rt_new");

    const onDisk = await readSession(dir);
    expect(onDisk?.accessToken).toBe("at_new");
    expect(onDisk?.refreshToken).toBe("rt_new");
  });

  it("returns null when an expired session has no refresh token", async () => {
    await writeSession(
      dir,
      makeSession({ expiresAt: NOW_S - 60, refreshToken: undefined }),
    );
    const fetchMock = mock(async () => new Response("", { status: 200 }));
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result).toBeNull();
  });

  it("returns null when refresh fails with invalid_grant", async () => {
    await writeSession(dir, makeSession({ expiresAt: NOW_S - 60 }));
    const fetchMock = mock(
      async () => new Response("invalid_grant", { status: 400 }),
    );
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result).toBeNull();
  });

  it("rethrows when refresh fails with a transient error", async () => {
    await writeSession(dir, makeSession({ expiresAt: NOW_S - 60 }));
    const fetchMock = mock(async () => new Response("oops", { status: 500 }));
    const promise = getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(promise).rejects.toMatchObject({ kind: "transient" });
  });

  it("returns the session as-is when expiresAt is undefined", async () => {
    await writeSession(dir, makeSession({ expiresAt: undefined }));
    const fetchMock = mock(async () => {
      throw new Error("fetch should not be called when expiresAt is unknown");
    });
    const result = await getValidSession({
      dataDir: dir,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    expect(result?.accessToken).toBe("at_old");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
