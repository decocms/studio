import { fetchWithAuth } from "../../shared/lib/fetch";
import { pollUntil } from "./poll-until";

const STUDIO_URL = "http://127.0.0.1:13000";
const SUBSCRIBER_MOCK_URL = "http://127.0.0.1:13003";

// ---------------------------------------------------------------------------
// Generic fetch helper
// ---------------------------------------------------------------------------

/**
 * Fetch from Studio server. Prepends `STUDIO_URL` to the given path and
 * optionally attaches an `Authorization: Bearer` header when `apiKey` is
 * supplied, or a `Cookie` header when `cookie` is supplied. Origin and
 * header-shaping live in `tests/shared/lib/fetch.ts` so this stack and
 * multi-pod can't drift on what Better Auth expects.
 */
export async function fetchStudio(
  path: string,
  opts?: RequestInit & { apiKey?: string; cookie?: string },
): Promise<Response> {
  const { apiKey, cookie, ...init } = opts ?? {};
  return fetchWithAuth(STUDIO_URL, path, {
    ...init,
    auth: { apiKey, cookie },
  });
}

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------

export interface HealthResponse {
  status: string;
  services: Record<string, { status: string }>;
}

/**
 * Single health-check call. Returns the parsed JSON response.
 */
export async function healthCheck(): Promise<HealthResponse> {
  const res = await fetchStudio("/health/ready");
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`healthCheck failed: HTTP ${res.status} — ${body}`);
  }
  return (await res.json()) as HealthResponse;
}

/**
 * Poll the health endpoint until `condition` returns `true`.
 */
export async function waitForHealth(
  condition: (health: HealthResponse) => boolean,
  timeoutMs: number,
): Promise<void> {
  await pollUntil(
    async () => {
      const h = await healthCheck();
      return condition(h);
    },
    { timeoutMs, intervalMs: 1000, label: "waitForHealth" },
  );
}

// ---------------------------------------------------------------------------
// Subscriber mock helpers
// ---------------------------------------------------------------------------

/**
 * Retrieve all events the subscriber-mock has received so far.
 */
export async function getReceivedEvents(): Promise<any[]> {
  const res = await fetch(`${SUBSCRIBER_MOCK_URL}/received`);
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`getReceivedEvents failed: HTTP ${res.status} — ${body}`);
  }
  return (await res.json()) as any[];
}

/**
 * Clear the subscriber-mock's event buffer.
 */
export async function clearReceivedEvents(): Promise<void> {
  const res = await fetch(`${SUBSCRIBER_MOCK_URL}/received`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "<unreadable>");
    throw new Error(`clearReceivedEvents failed: HTTP ${res.status} — ${body}`);
  }
}

// ---------------------------------------------------------------------------
// MCP JSON-RPC helper
// ---------------------------------------------------------------------------

interface McpCallResult {
  result: any;
  durationMs: number;
}

/**
 * Send a JSON-RPC 2.0 request to an MCP endpoint exposed by Studio.
 *
 * @param endpoint  The MCP route segment, e.g. `"{orgId}_self"` or a
 *                  connection identifier such as `"conn_abc123"`.
 * @param method    JSON-RPC method, e.g. `"tools/call"`.
 * @param params    JSON-RPC params payload.
 * @param auth      Supply either `apiKey` (Bearer) or `cookie` for auth.
 * @param opts      Optional overrides (timeout).
 */
export async function mcpCall(
  endpoint: string,
  method: string,
  params: any,
  auth: { apiKey?: string; cookie?: string; callerConnectionId?: string },
  opts?: { timeoutMs?: number },
): Promise<McpCallResult> {
  const body = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method,
    params,
  });

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (auth.apiKey) {
    headers["Authorization"] = `Bearer ${auth.apiKey}`;
  }
  if (auth.cookie) {
    headers["Cookie"] = auth.cookie;
  }
  if (auth.callerConnectionId) {
    headers["x-caller-id"] = auth.callerConnectionId;
  }

  const controller = new AbortController();
  const timeoutId =
    opts?.timeoutMs != null
      ? setTimeout(() => controller.abort(), opts.timeoutMs)
      : undefined;

  const start = performance.now();
  try {
    const res = await fetch(`${STUDIO_URL}/mcp/${endpoint}`, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    const durationMs = performance.now() - start;

    if (!res.ok) {
      const text = await res.text().catch(() => "<unreadable>");
      throw new Error(
        `mcpCall(${endpoint}, ${method}) HTTP ${res.status} — ${text}`,
      );
    }

    const json = await res.json();

    if (json.error) {
      throw new Error(
        `mcpCall(${endpoint}, ${method}) JSON-RPC error: ${JSON.stringify(json.error)}`,
      );
    }

    return { result: json.result, durationMs };
  } finally {
    if (timeoutId != null) clearTimeout(timeoutId);
  }
}

// ---------------------------------------------------------------------------
// Tool call convenience wrapper
// ---------------------------------------------------------------------------

/**
 * Call a tool on a connection via Studio MCP proxy using HTTP.
 *
 * This wraps `mcpCall` with the `tools/call` method and the conventional
 * `{orgId}_{connectionId}` endpoint format.
 */
export async function callToolViaHttp(
  orgId: string,
  connectionId: string,
  toolName: string,
  args: Record<string, unknown>,
  apiKey: string,
  opts?: { timeoutMs?: number },
): Promise<McpCallResult> {
  return mcpCall(
    `${orgId}_${connectionId}`,
    "tools/call",
    { name: toolName, arguments: args },
    { apiKey },
    opts,
  );
}

// ---------------------------------------------------------------------------
// Auth helpers
// ---------------------------------------------------------------------------

/**
 * Sign up a test user and sign in to get a session cookie.
 * Then create or join an organization and return the cookie + orgId.
 */
export async function getTestSession(): Promise<{
  cookie: string;
  orgId: string;
}> {
  const email = `resilience-test-${Date.now()}@test.local`;
  const password = "test-password-resilience-2026!";
  const name = "Resilience Test User";

  // 1. Sign up
  const signUpRes = await fetchStudio("/api/auth/sign-up/email", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password, name }),
  });

  if (!signUpRes.ok) {
    const body = await signUpRes.text().catch(() => "<unreadable>");
    throw new Error(`signUp failed: HTTP ${signUpRes.status} — ${body}`);
  }

  // Extract session cookies from sign-up response.
  // getSetCookie returns full Set-Cookie strings; we only need the name=value part.
  const setCookies = signUpRes.headers.getSetCookie?.() ?? [];
  let cookie = setCookies
    .map((c) => c.split(";")[0].trim())
    .filter(Boolean)
    .join("; ");

  // If sign-up didn't return cookies, sign in explicitly
  if (!cookie) {
    const signInRes = await fetchStudio("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, password }),
    });
    if (!signInRes.ok) {
      const body = await signInRes.text().catch(() => "<unreadable>");
      throw new Error(`signIn failed: HTTP ${signInRes.status} — ${body}`);
    }
    const signInCookies = signInRes.headers.getSetCookie?.() ?? [];
    cookie = signInCookies
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  }

  if (!cookie) {
    throw new Error("getTestSession: no session cookie received");
  }

  // 2. Create an organization
  const createOrgRes = await fetchStudio("/api/auth/organization/create", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({
      name: "Resilience Test Org",
      slug: `resilience-test-${Date.now()}`,
    }),
  });

  if (!createOrgRes.ok) {
    const body = await createOrgRes.text().catch(() => "<unreadable>");
    throw new Error(`createOrg failed: HTTP ${createOrgRes.status} — ${body}`);
  }

  const orgJson = (await createOrgRes.json()) as any;
  const orgId: string = orgJson.id ?? orgJson.organizationId ?? "";

  if (!orgId) {
    // Try to list organizations to find one
    const listRes = await fetchStudio(
      "/api/auth/organization/list-organizations",
      {
        method: "GET",
        headers: { Cookie: cookie },
      },
    );
    if (listRes.ok) {
      const orgs = (await listRes.json()) as any[];
      if (orgs.length > 0) {
        return { cookie, orgId: orgs[0].id };
      }
    }
    throw new Error(
      `getTestSession: could not extract orgId from: ${JSON.stringify(orgJson)}`,
    );
  }

  // 3. Set active organization
  await fetchStudio("/api/auth/organization/set-active", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ organizationId: orgId }),
  });

  // Re-extract cookies after setting active org
  const refreshRes = await fetchStudio("/api/auth/session", {
    method: "GET",
    headers: { Cookie: cookie },
  });
  const refreshCookies = refreshRes.headers.getSetCookie?.() ?? [];
  if (refreshCookies.length > 0) {
    cookie = refreshCookies
      .map((c) => c.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
  }

  return { cookie, orgId };
}

/**
 * Create an API key via the built-in `API_KEY_CREATE` tool on the `self`
 * connection.
 */
export async function createApiKey(
  cookie: string,
  orgId: string,
): Promise<{ key: string }> {
  const { result } = await mcpCall(
    `${orgId}_self`,
    "tools/call",
    {
      name: "API_KEY_CREATE",
      arguments: {
        name: `resilience-test-${Date.now()}`,
        permissions: { "*": ["*"] },
      },
    },
    { cookie },
  );

  // The tool returns structured content with the key.
  const structured = result?.structuredContent;
  const key: string =
    structured?.key ??
    (() => {
      // Fallback: parse the text content
      const text = result?.content?.[0]?.text;
      if (text) {
        try {
          return JSON.parse(text).key;
        } catch {}
      }
      return undefined;
    })();

  if (!key) {
    throw new Error(
      `createApiKey: unexpected result shape: ${JSON.stringify(result)}`,
    );
  }

  return { key };
}
