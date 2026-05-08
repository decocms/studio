import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { startOAuthCallbackServer } from "../../lib/oauth-callback";
import { generatePkcePair } from "../../lib/pkce";
import { type Session, writeSession } from "../../lib/session";

export interface LoginOptions {
  dataDir: string;
  target?: string;
  /** Injectable for tests. Defaults to opening the user's default browser. */
  openBrowser?: (url: string) => Promise<void>;
  /** Injectable for tests. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

const DEFAULT_TARGET = "https://studio.decocms.com";

const SCOPES = "openid profile email offline_access";

interface RegisterResponse {
  client_id: string;
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expires_in?: number;
  token_type?: string;
}

interface IdTokenClaims {
  sub: string;
  email?: string;
  name?: string;
}

export async function loginCommand(options: LoginOptions): Promise<number> {
  const target = (options.target ?? DEFAULT_TARGET).replace(/\/$/, "");
  const fetchImpl = options.fetch ?? fetch;
  const openImpl = options.openBrowser ?? defaultOpenBrowser;

  const state = randomUUID();
  const pkce = generatePkcePair();

  const server = await startOAuthCallbackServer({ expectedState: state });
  try {
    const redirectUri = `${server.url}/`;

    // 1. Dynamically register this CLI install as an OAuth client.
    const clientId = await registerClient(fetchImpl, target, redirectUri);

    // 2. Build the /login URL — this triggers the existing OAuth-aware login UI,
    //    which routes to /api/auth/mcp/authorize after the user signs in.
    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    });
    const url = `${target}/login?${params.toString()}`;

    console.log(`Opening ${url} in your browser...`);
    await openImpl(url);

    // 3. Wait for the browser to redirect back with an authorization code.
    const { code } = await server.waitForCallback();

    // 4. Exchange the code for an access + id token.
    const token = await exchangeToken(
      fetchImpl,
      target,
      clientId,
      code,
      redirectUri,
      pkce.verifier,
    );

    // 5. Read the user from the id_token (the OIDC standard way — userinfo
    //    endpoint is advertised but not implemented upstream).
    if (!token.id_token) {
      throw new Error("Token endpoint returned no id_token");
    }
    const claims = decodeIdToken(token.id_token);

    const session: Session = {
      target,
      clientId,
      user: { sub: claims.sub, email: claims.email, name: claims.name },
      accessToken: token.access_token,
      refreshToken: token.refresh_token,
      expiresAt: token.expires_in
        ? Math.floor(Date.now() / 1000) + token.expires_in
        : undefined,
      createdAt: new Date().toISOString(),
    };
    await writeSession(options.dataDir, session);

    console.log(`Logged in as ${claims.email ?? claims.sub}.`);
    return 0;
  } catch (err) {
    console.error(
      `Login failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return 1;
  } finally {
    server.close();
  }
}

async function registerClient(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  target: string,
  redirectUri: string,
): Promise<string> {
  const res = await fetchImpl(`${target}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      client_name: "decocms-cli",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    }),
  });
  if (!res.ok) {
    throw new Error(
      `Client registration failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const data = (await res.json()) as RegisterResponse;
  if (typeof data?.client_id !== "string") {
    throw new Error("Client registration returned no client_id");
  }
  return data.client_id;
}

async function exchangeToken(
  fetchImpl: (input: string, init?: RequestInit) => Promise<Response>,
  target: string,
  clientId: string,
  code: string,
  redirectUri: string,
  verifier: string,
): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: redirectUri,
    client_id: clientId,
    code_verifier: verifier,
  });
  const res = await fetchImpl(`${target}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(
      `Token exchange failed: HTTP ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
  const data = (await res.json()) as TokenResponse;
  if (typeof data?.access_token !== "string") {
    throw new Error("Token endpoint returned no access_token");
  }
  return data;
}

function decodeIdToken(idToken: string): IdTokenClaims {
  const parts = idToken.split(".");
  if (parts.length !== 3 || !parts[1]) {
    throw new Error("id_token is not a valid JWT");
  }
  const payload = JSON.parse(
    Buffer.from(parts[1], "base64url").toString("utf8"),
  ) as Record<string, unknown>;
  if (typeof payload.sub !== "string") {
    throw new Error("id_token has no sub claim");
  }
  return {
    sub: payload.sub,
    email: typeof payload.email === "string" ? payload.email : undefined,
    name: typeof payload.name === "string" ? payload.name : undefined,
  };
}

async function defaultOpenBrowser(url: string): Promise<void> {
  let command: string;
  let args: string[];
  switch (process.platform) {
    case "darwin":
      command = "open";
      args = [url];
      break;
    case "win32":
      command = "cmd";
      args = ["/c", "start", "", url];
      break;
    default:
      command = "xdg-open";
      args = [url];
      break;
  }
  await new Promise<void>((resolve) => {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      console.log(
        `Could not open browser automatically. Please open this URL manually:\n  ${url}`,
      );
      resolve();
    });
    child.on("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
