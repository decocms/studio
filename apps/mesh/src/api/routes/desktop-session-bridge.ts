/**
 * Desktop system-browser session bridge.
 *
 * `POST /api/auth/desktop/session-from-oauth` — the one mesh-side change
 * `apps/desktop/docs/real-ui-auth-recon.md` concluded was unavoidable to fix
 * the Google/GitHub/SAML system-browser desktop login path: an MCP OAuth
 * access token (the `oauthAccessToken` row both desktop login paths
 * ultimately hold) satisfies org-scoped `/api/:org/*` routes but is REJECTED
 * by Better Auth's native session endpoints (`get-session`,
 * `organization.list`, ...), which only recognize a session cookie (or an
 * API key, via the `apiKey()` plugin's `enableSessionForAPIKeys`) — see that
 * doc's §0-§3 for the empirical trail. The embedded email/password/OTP
 * desktop login path sidesteps this by capturing the REAL session cookie
 * Better Auth sets during that flow (`crates/upstream/src/bridge.rs`'s
 * cookie-relay bridge); the system-browser path has no equivalent capture
 * point — the cookie lands in the system browser's OWN cookie jar, a
 * separate OS process this app never has access to. This endpoint is the
 * missing piece: given a valid MCP OAuth bearer, mint a REAL Better Auth
 * session server-side and hand the caller the signed cookie VALUE (not a
 * `Set-Cookie` header — this caller is a native app process, not a browser
 * that would capture one) so it can forward that value itself, byte for
 * byte, as `Cookie: better-auth.session_token=<value>` — see
 * `apps/desktop/crates/upstream/src/login.rs`'s
 * `mint_session_from_access_token`, the Rust-side caller.
 *
 * ## Auth guard
 *
 * Dual-auth via the SAME `resolveLinkBearer` resolver `GET /api/links/me`
 * uses (MCP OAuth session primary, Better Auth API key fallback) — reusing
 * a reviewed, already-tested resolver rather than a bespoke check. In
 * practice the desktop app only ever presents a fresh MCP OAuth access
 * token here (never an API key), but there's no reason to special-case that
 * narrower expectation when the shared resolver already does the right
 * thing for either credential shape. A caller presenting neither gets
 * `401`.
 *
 * ## Minting the session + signing the cookie value
 *
 * `auth.$context` (typed and documented as part of the `Auth<Options>`
 * shape the installed `better-auth` package exports — see its
 * `dist/types/auth.d.mts`) exposes the same
 * `internalAdapter.createSession(userId, dontRememberMe)` Better Auth's own
 * `admin.impersonateUser` endpoint calls server-side
 * (`better-auth/dist/plugins/admin/routes.mjs`) to create a real session
 * row with a fresh, random token. That raw token is not by itself a valid
 * cookie value: Better Auth signs every session-cookie value with
 * HMAC-SHA256 over the raw token using `context.secret`, then
 * `${token}.${signature}` gets `encodeURIComponent`-escaped before it's set
 * as the cookie's value (read verbatim from the installed `better-call`
 * package `better-auth` depends on for this: `dist/context.mjs`'s
 * `setSignedCookie` -> `dist/cookies.mjs`'s `serializeSignedCookie` ->
 * `dist/crypto.mjs`'s `signCookieValue`/`makeSignature`).
 * `signSessionCookieValue` below reproduces exactly that algorithm rather
 * than reaching into `better-call` directly — it is a transitive
 * dependency of `better-auth`, not a direct dependency of this package, so
 * importing its internals would be fragile. The signing scheme itself is a
 * small, stable primitive (HMAC-SHA256 + base64 + URI-escape) pinned down
 * independently by this file's co-located unit test.
 */

import { createHmac } from "node:crypto";
import { Hono } from "hono";
import { auth } from "@/auth";
import {
  resolveLinkBearer,
  type LinkBearerAuthApi,
} from "./decopilot/link-bearer-auth";

const app = new Hono();

/**
 * Reproduces Better Auth's own session-cookie signing (see this file's
 * module doc for the exact source trail): HMAC-SHA256 the raw session
 * token with the auth secret, base64-encode the signature (standard
 * alphabet, not url-safe — matches `btoa` in `better-call`'s
 * `makeSignature`), concatenate as `${token}.${signature}`, then
 * `encodeURIComponent` the whole thing — the exact string Better Auth would
 * have set as the `better-auth.session_token` cookie's VALUE. A browser
 * stores and re-sends a cookie value verbatim (percent-escapes and all), so
 * encoding it here up front is what makes the caller's later `Cookie:
 * better-auth.session_token=<this value>` byte-identical to what a real
 * sign-in would have produced — and therefore something
 * `getSignedCookie`'s own decode-then-verify round trip accepts.
 */
export function signSessionCookieValue(token: string, secret: string): string {
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  return encodeURIComponent(`${token}.${signature}`);
}

app.post("/session-from-oauth", async (c) => {
  const authHeader = c.req.header("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(authHeader);
  const token = match?.[1]?.trim();
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const userId = await resolveLinkBearer(
    token,
    auth.api as unknown as LinkBearerAuthApi,
  );
  if (!userId) {
    return c.json({ error: "unauthorized" }, 401);
  }

  try {
    const ctx = await auth.$context;
    const session = await ctx.internalAdapter.createSession(userId, false);
    const sessionToken = signSessionCookieValue(session.token, ctx.secret);
    return c.json({ sessionToken });
  } catch (err) {
    console.error(
      "[desktop-session-bridge] failed to mint a session from an OAuth bearer:",
      err instanceof Error ? err.message : String(err),
    );
    return c.json({ error: "failed to mint a session" }, 500);
  }
});

export default app;
