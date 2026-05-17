/**
 * Multi-pod test bootstrap.
 *
 * `bootstrapSession(pod)` is a one-shot: signs up a user, creates an org,
 * mints an API key. Returns auth artifacts that scenarios pass to the
 * `client.ts` helpers. The session lives in shared Postgres, so all pods
 * recognize it — that property is exactly what makes cross-pod tests
 * possible at all.
 *
 * `wireMockProvider(pod, session)` is an opt-in second step for scenarios
 * that drive the decopilot dispatch pipeline. It registers an
 * `openai-compatible` credential pointing at the in-cluster mock-ai
 * service and pins the org's "smart" tier to it. Scenarios that don't
 * dispatch (smoke, session-rehoming, api-key-cross-pod) skip this.
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

export interface MockProvider {
  /** ai_provider_keys.id created for the mock-ai credential. */
  keyId: string;
  /** Model id the mock advertises (matches mock-ai/server.ts MODEL_ID). */
  modelId: string;
}

/** The internal URL mesh pods use to reach the mock-ai container. */
const MOCK_AI_INTERNAL_URL = "http://mock-ai:9000/v1";
const MOCK_AI_MODEL_ID = "mock-model";

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
  const apiKeyRes = await mcpCall<{ key?: string }>(pod, orgId, cookie, {
    name: "API_KEY_CREATE",
    arguments: {
      name: `multi-pod-${Date.now()}`,
      permissions: { "*": ["*"] },
    },
  });
  if (!apiKeyRes.key) {
    throw new Error(
      `API_KEY_CREATE returned no key: ${JSON.stringify(apiKeyRes)}`,
    );
  }

  return { cookie, apiKey: apiKeyRes.key, orgId, orgSlug };
}

/**
 * Register a credential pointing at the in-cluster mock-ai service and
 * pin the org's "smart" tier to it. After this returns, any decopilot
 * dispatch on this org will route through mock-ai instead of a real
 * provider.
 *
 * Idempotent at the scenario level: each scenario gets a fresh org via
 * bootstrapSession, so this always inserts a new credential.
 */
export async function wireMockProvider(
  pod: PodInfo,
  session: Session,
): Promise<MockProvider> {
  // 1. Create the credential. `openai-compatible` provider takes the
  // baseUrl + apiKey as a JSON string in the `apiKey` field — that JSON
  // is what the adapter parses at activate time (see
  // apps/mesh/src/ai-providers/adapters/openai-compatible.ts).
  const created = await mcpCall<{ id?: string }>(
    pod,
    session.orgId,
    session.cookie,
    {
      name: "AI_PROVIDER_KEY_CREATE",
      arguments: {
        providerId: "openai-compatible",
        label: "multi-pod-mock-ai",
        apiKey: JSON.stringify({
          baseUrl: MOCK_AI_INTERNAL_URL,
          apiKey: "test-key",
        }),
      },
    },
  );
  if (!created.id) {
    throw new Error(
      `AI_PROVIDER_KEY_CREATE returned no id: ${JSON.stringify(created)}`,
    );
  }

  // 2. Pin the "smart" tier to this credential + the mock model. Other
  // tiers stay null so any decopilot call that defaults to "smart"
  // (which most do) routes here.
  await mcpCall(pod, session.orgId, session.cookie, {
    name: "ORGANIZATION_SETTINGS_UPDATE",
    arguments: {
      organizationId: session.orgId,
      simple_mode: {
        tiers: {
          fast: null,
          smart: { keyId: created.id, modelId: MOCK_AI_MODEL_ID },
          thinking: null,
          image: null,
          web_research: null,
        },
      },
    },
  });

  return { keyId: created.id, modelId: MOCK_AI_MODEL_ID };
}

/**
 * Create a virtual MCP (agent) for the session's org. Required because
 * COLLECTION_THREADS_CREATE rejects a thread without a real virtual MCP
 * id — the UI creates one on the way in too. The agent has no
 * connections; it just satisfies the FK so thread creation can succeed.
 */
export async function createTestAgent(
  pod: PodInfo,
  session: Session,
): Promise<{ virtualMcpId: string }> {
  const created = await mcpCall<{ item?: { id?: string }; id?: string }>(
    pod,
    session.orgId,
    session.cookie,
    {
      name: "COLLECTION_VIRTUAL_MCP_CREATE",
      arguments: {
        data: {
          title: `multi-pod-agent-${Date.now()}`,
          connections: [],
        },
      },
    },
  );
  const id = created.item?.id ?? created.id;
  if (!id) {
    throw new Error(
      `COLLECTION_VIRTUAL_MCP_CREATE: no id in ${JSON.stringify(created)}`,
    );
  }
  return { virtualMcpId: id };
}

/**
 * Pre-create a thread row so /attach has something to look up the
 * instant after POST /messages returns 202. Without this, /attach
 * races against the workflow's first `prepareRun` (which is what
 * normally inserts the thread row) and 404s.
 */
export async function createTestThread(
  pod: PodInfo,
  session: Session,
  virtualMcpId: string,
  threadId?: string,
): Promise<{ threadId: string }> {
  const id =
    threadId ?? `thrd_test_${Date.now()}_${crypto.randomUUID().slice(0, 8)}`;
  await mcpCall(pod, session.orgId, session.cookie, {
    name: "COLLECTION_THREADS_CREATE",
    arguments: {
      data: { id, virtual_mcp_id: virtualMcpId },
    },
  });
  return { threadId: id };
}

interface McpEnvelope<T> {
  result?: {
    structuredContent?: T;
    content?: Array<{ text?: string }>;
  };
  error?: { message?: string };
}

/**
 * Generic MCP tool-call helper for the built-in `{orgId}_self` namespace.
 * Returns the parsed structured content (or text fallback for older
 * tools). Throws on JSON-RPC errors so tests fail loudly.
 */
async function mcpCall<T = unknown>(
  pod: PodInfo,
  orgId: string,
  cookie: string,
  params: { name: string; arguments: Record<string, unknown> },
): Promise<T> {
  const res = await postJson(
    pod,
    `/mcp/${orgId}_self`,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params,
    },
    {
      auth: { cookie },
      headers: { Accept: "application/json, text/event-stream" },
    },
  );
  const json = (await res.json()) as McpEnvelope<T>;
  if (json.error) {
    throw new Error(
      `${params.name} JSON-RPC error: ${json.error.message ?? JSON.stringify(json.error)}`,
    );
  }
  if (json.result?.structuredContent) return json.result.structuredContent;

  const text = json.result?.content?.[0]?.text;
  if (text) {
    try {
      return JSON.parse(text) as T;
    } catch {
      /* fall through */
    }
  }
  return {} as T;
}
