import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSession } from "../../lib/session";
import { loginCommand } from "./login";

let dir: string;
let logSpy: ReturnType<typeof spyOn>;
let errSpy: ReturnType<typeof spyOn>;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "deco-login-"));
  logSpy = spyOn(console, "log").mockImplementation(() => {});
  errSpy = spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  await rm(dir, { recursive: true, force: true });
});

/**
 * Stand up a fake decocms server that handles dynamic registration, the
 * authorize redirect (back to the CLI's callback with a code), the token
 * exchange, and userinfo. The mock simulates the browser by hitting the
 * CLI's callback URL inside `openBrowser`.
 */
function mockTarget(target: string) {
  let issuedClientId: string | undefined;
  let issuedAccessToken: string | undefined;
  let issuedCode: string | undefined;
  let pkceVerifier: string | undefined;

  const fetchMock = mock(async (url: string, init?: RequestInit) => {
    if (url === `${target}/api/auth/mcp/register`) {
      issuedClientId = `client_${Math.random().toString(36).slice(2, 8)}`;
      return new Response(
        JSON.stringify({
          client_id: issuedClientId,
          redirect_uris: ["http://127.0.0.1:0/"],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url === `${target}/api/auth/mcp/token`) {
      const body = new URLSearchParams(init?.body as string);
      pkceVerifier = body.get("code_verifier") ?? undefined;
      issuedAccessToken = `at_${Math.random().toString(36).slice(2, 10)}`;
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("code")).toBe(issuedCode ?? "");
      expect(body.get("client_id")).toBe(issuedClientId ?? "");
      const idTokenPayload = Buffer.from(
        JSON.stringify({
          sub: "user-123",
          email: "tlgimenes@gmail.com",
          name: "TL Gimenes",
        }),
      ).toString("base64url");
      const idToken = `header.${idTokenPayload}.signature`;
      return new Response(
        JSON.stringify({
          access_token: issuedAccessToken,
          token_type: "Bearer",
          expires_in: 3600,
          refresh_token: "rt_xyz",
          id_token: idToken,
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
    expect(parsed.searchParams.get("client_id")).toBe(issuedClientId ?? "");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    expect(parsed.searchParams.get("code_challenge")).toMatch(
      /^[A-Za-z0-9_-]+$/,
    );
    issuedCode = `code_${Math.random().toString(36).slice(2, 8)}`;
    // Simulate the browser hitting the CLI callback after auth.
    await new Promise((r) => setTimeout(r, 10));
    await fetch(`${redirectUri}?code=${issuedCode}&state=${state}`);
  });

  return {
    fetchMock,
    openBrowser,
    getIssuedAccessToken: () => issuedAccessToken,
    getIssuedClientId: () => issuedClientId,
    getPkceVerifier: () => pkceVerifier,
  };
}

describe("loginCommand", () => {
  it("performs the full OAuth flow and persists a session", async () => {
    const target = "https://studio.decocms.com";
    const m = mockTarget(target);

    const code = await loginCommand({
      dataDir: dir,
      target,
      openBrowser: m.openBrowser,
      fetch: m.fetchMock,
    });

    expect(code).toBe(0);

    const session = await readSession(dir);
    expect(session?.target).toBe(target);
    expect(session?.clientId).toBe(m.getIssuedClientId());
    expect(session?.accessToken).toBe(m.getIssuedAccessToken());
    expect(session?.refreshToken).toBe("rt_xyz");
    expect(session?.user.sub).toBe("user-123");
    expect(session?.user.email).toBe("tlgimenes@gmail.com");
    expect(session?.expiresAt).toBeGreaterThan(0);

    // PKCE verifier was actually sent to the token endpoint.
    expect(m.getPkceVerifier()).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("defaults the target to https://studio.decocms.com", async () => {
    const m = mockTarget("https://studio.decocms.com");
    let openedUrl: string | undefined;
    const captureOpen = mock(async (url: string) => {
      openedUrl = url;
      await m.openBrowser(url);
    });

    await loginCommand({
      dataDir: dir,
      openBrowser: captureOpen,
      fetch: m.fetchMock,
    });
    expect(openedUrl).toMatch(/^https:\/\/studio\.decocms\.com\/login\?/);
  });

  it("returns non-zero and writes no session when token exchange fails", async () => {
    const target = "https://studio.decocms.com";
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/register")) {
        return new Response(JSON.stringify({ client_id: "client_x" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      if (url.endsWith("/token")) {
        return new Response("invalid_grant", { status: 400 });
      }
      throw new Error(`Unexpected: ${url}`);
    });
    const openBrowser = mock(async (url: string) => {
      const parsed = new URL(url);
      const callback = parsed.searchParams.get("redirect_uri")!;
      const state = parsed.searchParams.get("state")!;
      await new Promise((r) => setTimeout(r, 10));
      await fetch(`${callback}?code=c&state=${state}`);
    });
    const code = await loginCommand({
      dataDir: dir,
      target,
      openBrowser,
      fetch: fetchMock,
    });
    expect(code).not.toBe(0);
    expect(await readSession(dir)).toBeNull();
  });

  it("returns non-zero when client registration fails", async () => {
    const fetchMock = mock(async (url: string) => {
      if (url.endsWith("/register")) {
        return new Response("forbidden", { status: 403 });
      }
      throw new Error(`Unexpected: ${url}`);
    });
    const openBrowser = mock(async () => {
      throw new Error("openBrowser should not be called");
    });
    const code = await loginCommand({
      dataDir: dir,
      target: "https://studio.decocms.com",
      openBrowser,
      fetch: fetchMock,
    });
    expect(code).not.toBe(0);
    expect(await readSession(dir)).toBeNull();
  });
});
