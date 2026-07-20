/**
 * Mints a real MCP OAuth 2.1 + PKCE access token against the live mesh —
 * the exact primitive both `apps/mesh/src/cli/commands/auth/login.ts` and
 * `apps/desktop/crates/upstream/src/login.rs` produce for a signed-in user.
 *
 * Drives the real wire dance: dynamic client registration
 * (`POST /api/auth/mcp/register`) → authorize
 * (`GET /api/auth/mcp/authorize`, presenting the request context's already-
 * established Better Auth session cookie — e.g. from `signUpViaApi` —
 * instead of opening a browser, mirroring
 * `crates/upstream/src/bridge.rs::complete_via_cookie_jar`'s non-interactive
 * approach) → token exchange (`POST /api/auth/mcp/token`). `request` must
 * already carry a session cookie.
 *
 * Inlined here (not imported from `apps/mesh/src/cli/lib/pkce.ts` or
 * similar) per this package's isolation rule — `packages/e2e` never imports
 * app source (see `plugins/ban-e2e-app-imports.js`); a black-box test owning
 * its own contract is correct, not duplication.
 */

import { createHash, randomBytes } from "node:crypto";
import type { APIRequestContext } from "@playwright/test";

const SCOPES = "openid profile email offline_access";

export interface MintedMcpAccessToken {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
}

function base64UrlEncode(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function generatePkcePair(): { verifier: string; challenge: string } {
  const verifier = base64UrlEncode(randomBytes(32));
  const challenge = base64UrlEncode(
    createHash("sha256").update(verifier).digest(),
  );
  return { verifier, challenge };
}

export async function mintMcpAccessToken(
  request: APIRequestContext,
): Promise<MintedMcpAccessToken> {
  // Never actually connected to — only compared for exact string equality by
  // the authorize endpoint's redirect_uri check. A fixed placeholder is safe
  // across parallel workers: each registration mints its own fresh
  // `client_id`, so an identical string never collides across tests.
  const redirectUri = "http://127.0.0.1:0/callback";
  const state = `e2e-state-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const pkce = generatePkcePair();

  const registerRes = await request.post("/api/auth/mcp/register", {
    data: {
      client_name: "e2e-mcp-oauth-fixture",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      application_type: "native",
    },
  });
  if (!registerRes.ok()) {
    throw new Error(
      `mintMcpAccessToken: register failed HTTP ${registerRes.status()} — ${await registerRes.text().catch(() => "")}`,
    );
  }
  const { client_id: clientId } = (await registerRes.json()) as {
    client_id: string;
  };

  const authorizeRes = await request.get("/api/auth/mcp/authorize", {
    params: {
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      state,
      scope: SCOPES,
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
    },
    maxRedirects: 0,
  });
  if (authorizeRes.status() < 300 || authorizeRes.status() >= 400) {
    throw new Error(
      `mintMcpAccessToken: authorize did not redirect — HTTP ${authorizeRes.status()} — ${await authorizeRes.text().catch(() => "")}`,
    );
  }
  const location = authorizeRes.headers()["location"];
  if (!location) {
    throw new Error("mintMcpAccessToken: authorize redirect had no Location");
  }
  const landed = new URL(location, redirectUri);
  const code = landed.searchParams.get("code");
  const returnedState = landed.searchParams.get("state");
  if (returnedState !== state) {
    throw new Error("mintMcpAccessToken: authorize state mismatch");
  }
  if (!code) {
    throw new Error("mintMcpAccessToken: authorize redirect had no code param");
  }

  const tokenRes = await request.post("/api/auth/mcp/token", {
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: pkce.verifier,
    },
  });
  if (!tokenRes.ok()) {
    throw new Error(
      `mintMcpAccessToken: token exchange failed HTTP ${tokenRes.status()} — ${await tokenRes.text().catch(() => "")}`,
    );
  }
  const tokenBody = (await tokenRes.json()) as {
    access_token: string;
    refresh_token?: string;
    id_token?: string;
  };
  if (!tokenBody.access_token) {
    throw new Error("mintMcpAccessToken: token response had no access_token");
  }
  return {
    accessToken: tokenBody.access_token,
    refreshToken: tokenBody.refresh_token,
    idToken: tokenBody.id_token,
  };
}
