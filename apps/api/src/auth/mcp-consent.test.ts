import { describe, expect, it } from "bun:test";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { mcp } from "better-auth/plugins";
import {
  consentCovers,
  isAllowedMcpRedirectUri,
  mcpOAuthBeforeHook,
  studioHostsOf,
} from "./mcp-consent";

const STUDIO = "http://localhost:3000";
const HOSTS = new Set(["localhost:3000"]);

describe("isAllowedMcpRedirectUri", () => {
  it("allows loopback, native app schemes, and third-party HTTPS", () => {
    for (const uri of [
      "http://127.0.0.1:49152/callback",
      "http://localhost:8080/cb",
      "http://[::1]:9000/cb",
      "cursor://anysphere.cursor-mcp/oauth/callback",
      "https://claude.ai/api/mcp/auth_callback",
      `${STUDIO}/oauth/callback`,
    ]) {
      expect(isAllowedMcpRedirectUri(uri, HOSTS)).toBe(true);
    }
  });

  it("rejects pages on Studio that could read a code from their own URL", () => {
    for (const uri of [
      `${STUDIO}/api/acme/fs/workspace/read?path=/x.html`,
      `${STUDIO}/oauth/callback?next=/x`,
      `${STUDIO}/`,
    ]) {
      expect(isAllowedMcpRedirectUri(uri, HOSTS)).toBe(false);
    }
  });

  it("rejects script schemes, plain HTTP hosts, credentials, and junk", () => {
    for (const uri of [
      "javascript:alert(1)",
      "data:text/html,x",
      "http://attacker.example/cb",
      "https://user:pass@attacker.example/cb",
      "not a url",
      "",
    ]) {
      expect(isAllowedMcpRedirectUri(uri, HOSTS)).toBe(false);
    }
  });
});

describe("studioHostsOf", () => {
  it("covers the host a self-hosted instance is reached on without BASE_URL", () => {
    const hosts = studioHostsOf(
      "http://localhost:3000/api/auth",
      new Request("http://studio.acme.test/api/auth/mcp/register", {
        headers: { "x-forwarded-host": "Studio.Acme.Example" },
      }),
    );
    expect(hosts).toEqual(
      new Set(["localhost:3000", "studio.acme.test", "studio.acme.example"]),
    );
    for (const uri of [
      "https://studio.acme.test/api/acme/fs/workspace/read?path=/x.html",
      "https://studio.acme.example/d/deck",
    ]) {
      expect(isAllowedMcpRedirectUri(uri, hosts)).toBe(false);
    }
    expect(
      isAllowedMcpRedirectUri("https://studio.acme.test/oauth/callback", hosts),
    ).toBe(true);
  });
});

describe("consentCovers", () => {
  it("requires every requested scope", () => {
    expect(consentCovers("openid profile", ["openid"])).toBe(true);
    expect(consentCovers("openid", ["openid", "offline_access"])).toBe(false);
    expect(consentCovers(null, ["openid"])).toBe(false);
  });
});

function createAuth() {
  const table = (): Record<string, unknown>[] => [];
  const db = {
    user: table(),
    session: table(),
    account: table(),
    verification: table(),
    oauthApplication: table(),
    oauthAccessToken: table(),
    oauthConsent: table(),
  };
  const auth = betterAuth({
    baseURL: STUDIO,
    secret: "test-secret-test-secret-test-secret",
    database: memoryAdapter(db),
    emailAndPassword: { enabled: true },
    plugins: [mcp({ loginPage: "/login" })],
    hooks: { before: mcpOAuthBeforeHook },
  });
  return { auth, db };
}

async function signUp(auth: ReturnType<typeof createAuth>["auth"]) {
  const res = await auth.api.signUpEmail({
    body: { email: "victim@example.com", password: "password-123", name: "V" },
    asResponse: true,
  });
  const cookie = res.headers.get("set-cookie")?.split(";")[0] ?? "";
  expect(cookie).toContain("session_token");
  return cookie;
}

async function register(
  auth: ReturnType<typeof createAuth>["auth"],
  redirectUri: string,
) {
  return auth.handler(
    new Request(`${STUDIO}/api/auth/mcp/register`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: STUDIO },
      body: JSON.stringify({
        client_name: "probe",
        redirect_uris: [redirectUri],
        token_endpoint_auth_method: "none",
      }),
    }),
  );
}

function authorize(
  auth: ReturnType<typeof createAuth>["auth"],
  clientId: string,
  redirectUri: string,
  cookie?: string,
) {
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: "openid offline_access",
    state: "s1",
    code_challenge: "uswFsEt_dmuZIOUc3knDTRw1-AKv9Nt3j1IAc65xTlA",
    code_challenge_method: "S256",
  });
  return auth.handler(
    new Request(`${STUDIO}/api/auth/mcp/authorize?${query}`, {
      headers: cookie ? { cookie } : {},
      redirect: "manual",
    }),
  );
}

describe("MCP OAuth consent gate", () => {
  const redirectUri = "https://client.example/cb";

  it("refuses to register a redirect on a Studio page", async () => {
    const { auth } = createAuth();
    const res = await register(
      auth,
      `${STUDIO}/api/acme/fs/workspace/read?path=/x.html`,
    );
    expect(res.status).toBe(400);
  });

  it("sends a signed-in user to consent instead of issuing a code", async () => {
    const { auth, db } = createAuth();
    const cookie = await signUp(auth);
    const { client_id } = (await (
      await register(auth, redirectUri)
    ).json()) as {
      client_id: string;
    };

    const res = await authorize(auth, client_id, redirectUri, cookie);
    const location = res.headers.get("location") ?? "";
    expect(location).toStartWith("/oauth/consent?");
    expect(location).not.toContain("code=");
    expect(db.verification).toHaveLength(0);
  });

  it("issues the code once the user has consented to those scopes", async () => {
    const { auth, db } = createAuth();
    const cookie = await signUp(auth);
    const { client_id } = (await (
      await register(auth, redirectUri)
    ).json()) as {
      client_id: string;
    };
    db.oauthConsent.push({
      id: "c1",
      clientId: client_id,
      userId: db.user[0]?.id,
      scopes: "openid offline_access",
      consentGiven: true,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const res = await authorize(auth, client_id, redirectUri, cookie);
    expect(res.headers.get("location")).toStartWith(`${redirectUri}?code=`);
  });

  it("sends a signed-out user to login without the auto-issue cookie", async () => {
    const { auth } = createAuth();
    const res = await authorize(auth, "any", redirectUri);
    expect(res.headers.get("location")).toStartWith("/login?");
    expect(res.headers.get("set-cookie") ?? "").not.toContain(
      "oidc_login_prompt",
    );
  });
});
