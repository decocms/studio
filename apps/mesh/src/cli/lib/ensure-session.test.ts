import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSession } from "./ensure-session";
import {
  readSession,
  type Session,
  sessionPath,
  writeSession,
} from "./session";

const TARGET = "https://studio.decocms.com";
const FIXED_NOW_MS = 1_700_000_000_000;
const NOW_S = Math.floor(FIXED_NOW_MS / 1000);

let dir: string;
let logSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-ensure-"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

function freshSession(): Session {
  return {
    target: TARGET,
    clientId: "client_abc",
    user: { sub: "u_1", email: "tlgimenes@gmail.com" },
    accessToken: "at_old",
    refreshToken: "rt_xyz",
    expiresAt: NOW_S + 3600,
    createdAt: "2026-05-28T00:00:00.000Z",
  };
}

/**
 * Build a fetch mock that simulates the full OAuth flow (register + token
 * exchange) and an openBrowser that triggers the callback. Reused across
 * tests that need ensureSession to run the interactive login path.
 */
function mockOAuth() {
  let clientId = "";
  let code = "";
  const fetchMock = mock(async (url: string, init?: RequestInit) => {
    if (url.endsWith("/api/auth/mcp/register")) {
      clientId = "client_new";
      return new Response(JSON.stringify({ client_id: clientId }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.endsWith("/api/auth/mcp/token")) {
      const body = new URLSearchParams(init?.body as string);
      // ensureSession's login path only handles authorization_code (refresh
      // is the upstream layer's job).
      expect(body.get("grant_type")).toBe("authorization_code");
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: "u_login",
          email: "tlgimenes@gmail.com",
          name: "TL",
        }),
      ).toString("base64url");
      return new Response(
        JSON.stringify({
          access_token: "at_login",
          refresh_token: "rt_login",
          expires_in: 3600,
          id_token: `h.${idTokenPayload}.s`,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });

  const openBrowser = mock(async (url: string) => {
    const parsed = new URL(url);
    const redirectUri = parsed.searchParams.get("redirect_uri")!;
    const state = parsed.searchParams.get("state")!;
    code = "code_test";
    await new Promise((r) => setTimeout(r, 10));
    await fetch(`${redirectUri}?code=${code}&state=${state}`);
  });

  return { fetchMock, openBrowser };
}

describe("ensureSession", () => {
  it("returns the session unchanged when one is already valid", async () => {
    await writeSession(dir, freshSession());
    const openBrowser = mock(async () => {
      throw new Error("should not open browser");
    });
    const fetchMock = mock(async () => {
      throw new Error("should not fetch");
    });

    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    expect(session.accessToken).toBe("at_old");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("runs interactive login when no session exists and TTY is interactive", async () => {
    const m = mockOAuth();
    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser: m.openBrowser,
      fetch: m.fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    expect(session.accessToken).toBe("at_login");
    expect(session.user.sub).toBe("u_login");

    // Persisted to disk.
    const onDisk = await readSession(dir);
    expect(onDisk?.accessToken).toBe("at_login");

    // Surfaces a user-facing message that mentions the intent.
    const logged = logSpy.mock.calls.flat().join(" ");
    expect(logged).toMatch(/sign in to Link/i);
  });

  it("throws when no session exists and TTY is non-interactive", async () => {
    const openBrowser = mock(async () => {
      throw new Error("should not open browser");
    });
    const promise = ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: false,
      openBrowser,
      fetch: mock(
        async () => new Response("", { status: 500 }),
      ) as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(promise).rejects.toThrow(/decocms auth login/);
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("translates transient refresh errors into a user-facing message and skips the browser", async () => {
    await writeSession(dir, { ...freshSession(), expiresAt: NOW_S - 60 });
    const openBrowser = mock(async () => {
      throw new Error("should not open browser");
    });
    const fetchMock = mock(async () => new Response("oops", { status: 500 }));

    const promise = ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });
    await expect(promise).rejects.toThrow(
      /Could not refresh session.*decocms auth login/,
    );
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("re-logs in against the requested studio when the cached session is for a different one", async () => {
    // Cached prod session (host-keyed); we link against staging.
    await writeSession(dir, freshSession());
    const STG = "https://studio-stg.decocms.com";
    const m = mockOAuth();

    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      target: STG,
      isInteractive: true,
      openBrowser: m.openBrowser,
      fetch: m.fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    // Logged in fresh against staging rather than reusing the prod token.
    expect(session.accessToken).toBe("at_login");
    expect(m.openBrowser).toHaveBeenCalled();
    // The prod session is preserved (studios coexist).
    expect((await readSession(dir, TARGET))?.accessToken).toBe("at_old");
  });

  it("keeps a legacy session for a different studio when non-interactive (dev bootstrap)", async () => {
    // The dev-link bootstrap writes the legacy single-file session.
    await writeFile(sessionPath(dir), JSON.stringify(freshSession()), {
      mode: 0o600,
    });
    const openBrowser = mock(async () => {
      throw new Error("should not open browser");
    });
    const fetchMock = mock(async () => {
      throw new Error("should not fetch");
    });

    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      target: "https://studio-stg.decocms.com",
      isInteractive: false,
      openBrowser,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    // Reused, not rejected — the daemon's preflight surfaces a real mismatch.
    expect(session.accessToken).toBe("at_old");
    expect(openBrowser).not.toHaveBeenCalled();
  });

  it("falls back to interactive login when refresh token is rejected", async () => {
    await writeSession(dir, { ...freshSession(), expiresAt: NOW_S - 60 });

    // First call is the refresh (rejected with invalid_grant), then the
    // login flow's register + authorization_code token exchange.
    let call = 0;
    const oauth = mockOAuth();
    const fetchMock = mock(
      async (url: string, init?: RequestInit): Promise<Response> => {
        call++;
        if (call === 1) {
          const body = new URLSearchParams(init?.body as string);
          expect(body.get("grant_type")).toBe("refresh_token");
          return new Response("invalid_grant", { status: 400 });
        }
        return oauth.fetchMock(url, init);
      },
    );

    const session = await ensureSession({
      dataDir: dir,
      intent: "Link",
      isInteractive: true,
      openBrowser: oauth.openBrowser,
      fetch: fetchMock as unknown as typeof fetch,
      now: () => FIXED_NOW_MS,
    });

    expect(session.accessToken).toBe("at_login");
    expect(oauth.openBrowser).toHaveBeenCalled();
  });
});
