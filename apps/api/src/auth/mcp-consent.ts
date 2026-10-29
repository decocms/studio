/**
 * Consent and redirect rules for the MCP OAuth server.
 *
 * Better Auth's `mcp()` plugin has no consent step of its own. These hooks
 * ask the user to approve each client before it receives a code, and limit
 * the redirect targets a client may register.
 */

import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";

const MCP_CONSENT_PAGE = "/oauth/consent";

/** The only Studio page that may receive a code: it posts it to its opener only. */
const STUDIO_CALLBACK_PATH = "/oauth/callback";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

const BLOCKED_SCHEMES = new Set([
  "javascript:",
  "data:",
  "vbscript:",
  "file:",
  "blob:",
  "about:",
]);

/**
 * Loopback HTTP (CLI and desktop clients), native app schemes, and HTTPS
 * hosts other than Studio itself. On Studio's hosts only the callback page
 * is allowed: any other path may serve member-authored HTML that would read
 * the code from its own URL. Hosts are matched without the scheme, since a
 * self-hosted instance may sit behind a TLS-terminating proxy.
 */
export function isAllowedMcpRedirectUri(
  raw: string,
  studioHosts: ReadonlySet<string>,
): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (BLOCKED_SCHEMES.has(url.protocol)) return false;
  if (url.username || url.password) return false;
  if (studioHosts.has(url.host.toLowerCase())) {
    return url.pathname === STUDIO_CALLBACK_PATH && !url.search;
  }
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return true;
}

/**
 * The configured base URL's host plus the host this request reached, so the
 * rule still holds on a self-hosted instance whose BASE_URL is unset or stale.
 */
export function studioHostsOf(
  baseURL: string,
  request: Request | undefined,
): Set<string> {
  const hosts = new Set<string>();
  for (const raw of [baseURL, request?.url]) {
    if (!raw) continue;
    try {
      hosts.add(new URL(raw).host.toLowerCase());
    } catch {
      // unparsable: contributes no host
    }
  }
  const forwarded = request?.headers.get("x-forwarded-host");
  for (const host of forwarded?.split(",") ?? []) {
    if (host.trim()) hosts.add(host.trim().toLowerCase());
  }
  return hosts;
}

export function parseScopes(scope: unknown): string[] {
  if (typeof scope !== "string") return ["openid"];
  const scopes = scope.split(" ").filter(Boolean);
  return scopes.length > 0 ? scopes : ["openid"];
}

/** True when every requested scope was already granted. */
export function consentCovers(
  granted: string | null | undefined,
  requested: string[],
): boolean {
  if (!granted) return false;
  const set = new Set(granted.split(" ").filter(Boolean));
  return requested.every((scope) => set.has(scope));
}

interface ConsentRow {
  scopes: string | null;
  consentGiven: boolean;
}

export const mcpOAuthBeforeHook = createAuthMiddleware(async (ctx) => {
  if (ctx.path === "/mcp/register") {
    const studioHosts = studioHostsOf(ctx.context.baseURL, ctx.request);
    const body = ctx.body as { redirect_uris?: unknown } | undefined;
    const uris = Array.isArray(body?.redirect_uris) ? body.redirect_uris : [];
    const invalid = uris.filter(
      (uri) =>
        typeof uri !== "string" || !isAllowedMcpRedirectUri(uri, studioHosts),
    );
    if (invalid.length > 0) {
      throw new APIError("BAD_REQUEST", {
        error: "invalid_redirect_uri",
        error_description: "redirect_uris contains a disallowed URI",
      });
    }
    return;
  }

  if (ctx.path !== "/mcp/authorize") return;

  const search = ctx.request ? new URL(ctx.request.url).search : "";
  const session = await getSessionFromCtx(ctx);
  if (!session) {
    // Skip the plugin's login-prompt cookie: its after-login hook issues a code without consent.
    throw ctx.redirect(`/login${search}`);
  }

  const query = ctx.query as Record<string, unknown> | undefined;
  const clientId = query?.client_id;
  if (typeof clientId !== "string") return;

  const prompt = typeof query?.prompt === "string" ? query.prompt : "";
  if (!prompt.split(" ").includes("consent")) {
    const consent = await ctx.context.adapter.findOne<ConsentRow>({
      model: "oauthConsent",
      where: [
        { field: "clientId", value: clientId },
        { field: "userId", value: session.user.id },
      ],
    });
    if (
      consent?.consentGiven &&
      consentCovers(consent.scopes, parseScopes(query?.scope))
    ) {
      return;
    }
  }

  throw ctx.redirect(`${MCP_CONSENT_PAGE}${search}`);
});
