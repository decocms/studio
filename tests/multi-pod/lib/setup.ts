/**
 * Multi-pod test bootstrap.
 *
 * `bootstrapSession(pod)` is a one-shot: signs up a user, creates an org,
 * mints an API key. Returns auth artifacts that scenarios pass to the
 * `client.ts` helpers. The session lives in shared Postgres, so all pods
 * recognize it — that property is exactly what makes cross-pod tests
 * possible at all.
 *
 * Each invocation creates a fresh user/org with timestamped names to
 * keep scenarios isolated; we don't reset the DB between tests.
 */

import { extractSessionCookie, fetchOn, postJson } from "./client";
import type { PodInfo } from "./pods";

export interface Session {
  /** Better Auth session cookie, name=value style, ready to re-send. */
  cookie: string;
  /** API key minted via API_KEY_CREATE (Bearer-style). */
  apiKey: string;
  /** Slug-based org id created for this session. */
  orgId: string;
  /** The unique slug used when creating the org (URL-safe). */
  orgSlug: string;
}

/**
 * Sign up, create org, set active, mint API key. Everything goes through
 * `pod` — but the resulting session is recognized cluster-wide because
 * Better Auth + the API-key table live in shared Postgres.
 */
export async function bootstrapSession(pod: PodInfo): Promise<Session> {
  const stamp = Date.now();
  const email = `multi-pod-${stamp}@test.local`;
  const password = "multi-pod-password-2026!";
  const orgSlug = `multi-pod-${stamp}`;

  // 1. Sign up — most paths return the session cookie inline.
  const signUpRes = await fetchOn(pod, "/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name: "Multi-Pod Test" }),
  });
  if (!signUpRes.ok) {
    const body = await signUpRes.text().catch(() => "<unreadable>");
    throw new Error(`signUp → HTTP ${signUpRes.status}: ${body}`);
  }
  let cookie = extractSessionCookie(signUpRes);

  // Fall back to explicit sign-in if sign-up didn't set cookies (some
  // Better Auth flows return 200 without one for the verification path).
  if (!cookie) {
    const signInRes = await fetchOn(pod, "/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!signInRes.ok) {
      const body = await signInRes.text().catch(() => "<unreadable>");
      throw new Error(`signIn → HTTP ${signInRes.status}: ${body}`);
    }
    cookie = extractSessionCookie(signInRes);
  }
  if (!cookie) throw new Error("bootstrapSession: no session cookie");

  // 2. Create org. Better Auth returns the org row; we want its id.
  const createOrgRes = await postJson(
    pod,
    "/api/auth/organization/create",
    { name: "Multi-Pod Test Org", slug: orgSlug },
    { auth: { cookie } },
  );
  const orgJson = (await createOrgRes.json()) as {
    id?: string;
    organizationId?: string;
  };
  const orgId = orgJson.id ?? orgJson.organizationId;
  if (!orgId) throw new Error(`createOrg: no id in ${JSON.stringify(orgJson)}`);

  // 3. Set active so subsequent calls (esp. MCP) resolve the org without a
  // selector header.
  await postJson(
    pod,
    "/api/auth/organization/set-active",
    { organizationId: orgId },
    { auth: { cookie } },
  );

  // Re-extract cookies in case set-active rotated them.
  const refreshRes = await fetchOn(pod, "/api/auth/get-session", {
    auth: { cookie },
  });
  const refreshed = extractSessionCookie(refreshRes);
  if (refreshed) cookie = refreshed;

  // 4. Mint an API key via the built-in API_KEY_CREATE MCP tool. The
  // `{orgId}_self` endpoint is mesh's internal MCP namespace.
  const apiKey = await mintApiKey(pod, cookie, orgId);

  return { cookie, apiKey, orgId, orgSlug };
}

async function mintApiKey(
  pod: PodInfo,
  cookie: string,
  orgId: string,
): Promise<string> {
  const res = await postJson(
    pod,
    `/mcp/${orgId}_self`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name: "API_KEY_CREATE",
        arguments: {
          name: `multi-pod-${Date.now()}`,
          permissions: { "*": ["*"] },
        },
      },
    },
    {
      auth: { cookie },
      headers: { Accept: "application/json, text/event-stream" },
    },
  );
  const json = (await res.json()) as {
    result?: {
      structuredContent?: { key?: string };
      content?: Array<{ text?: string }>;
    };
    error?: unknown;
  };
  if (json.error) {
    throw new Error(`API_KEY_CREATE failed: ${JSON.stringify(json.error)}`);
  }
  const structuredKey = json.result?.structuredContent?.key;
  if (structuredKey) return structuredKey;

  // Older MCP responses surface the payload as a text content part.
  const text = json.result?.content?.[0]?.text;
  if (text) {
    try {
      const parsed = JSON.parse(text);
      if (typeof parsed.key === "string") return parsed.key;
    } catch {
      /* fall through */
    }
  }
  throw new Error(`API_KEY_CREATE: no key in ${JSON.stringify(json.result)}`);
}
