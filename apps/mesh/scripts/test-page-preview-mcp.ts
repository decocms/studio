/**
 * Closed-loop test for the Page Editor virtual MCP, full flow.
 *
 * Mints a fresh API key (the same way dispatch-run does), then drives the
 * live dev server's /mcp/virtual-mcp/<agentId> endpoint to:
 *  1. initialize
 *  2. tools/list — assert design-system + page-create tools exist
 *  3. DESIGN_SYSTEM_CREATE — scaffold a design system instantly
 *  4. PAGE_PREVIEW_PAGE_CREATE — scaffold a page bound to it
 *  5. PAGE_PREVIEW_REFRESH — bump version
 *  6. GET /api/<org>/page-preview/export?kind=page&slug=... — validate zip
 *
 * Run with the dev server already up:
 *   bun run apps/mesh/scripts/test-page-preview-mcp.ts
 */

import { auth } from "../src/auth/index";

const SERVER = process.env.MCP_SERVER ?? "http://localhost:3001";
const ORG_ID = process.env.ORG_ID ?? "qI79UDgd5ine21jyRaNFZb2XxR4jknBd";
const ORG_SLUG = process.env.ORG_SLUG ?? "guilherme-local";
const AGENT_ID = process.env.AGENT_ID ?? "vir_mi8wsIteDBpzmeRaNa4gO";
const USER_ID = process.env.USER_ID ?? "RTM5qUesVqB30TH8Ey2crCTTTuqfM1xH";

async function mintApiKey(): Promise<string> {
  const result = await auth.api.createApiKey({
    body: {
      name: "closed-loop-test",
      expiresIn: 600,
      userId: USER_ID,
      permissions: { self: ["*"] },
      metadata: {
        organization: { id: ORG_ID, slug: ORG_SLUG, name: "Guilherme Local" },
      },
    } as never,
  });
  // biome-ignore lint/suspicious/noExplicitAny: SDK type is loose
  const key = (result as any).key as string;
  if (!key) throw new Error("createApiKey returned no key");
  return key;
}

type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: number | string;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
};

function mcpHeaders(
  apiKey: string,
  sessionId?: string,
): Record<string, string> {
  const h: Record<string, string> = {
    Authorization: `Bearer ${apiKey}`,
    "x-org-id": ORG_ID,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (sessionId) h["Mcp-Session-Id"] = sessionId;
  return h;
}

async function mcpCall(
  apiKey: string,
  body: Record<string, unknown>,
  sessionId?: string,
): Promise<{ body: JsonRpcResponse; sessionId: string | null }> {
  const res = await fetch(`${SERVER}/mcp/virtual-mcp/${AGENT_ID}`, {
    method: "POST",
    headers: mcpHeaders(apiKey, sessionId),
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status} ${res.statusText} for ${JSON.stringify(body).slice(0, 80)}`,
    );
  }
  const sid = res.headers.get("Mcp-Session-Id");
  const ct = res.headers.get("content-type") ?? "";
  let parsed: JsonRpcResponse;
  if (ct.includes("text/event-stream")) {
    const text = await res.text();
    const match = text.match(/^data:\s*(\{.*\})\s*$/m);
    if (!match) throw new Error(`No SSE data frame in response:\n${text}`);
    parsed = JSON.parse(match[1]!) as JsonRpcResponse;
  } else {
    parsed = (await res.json()) as JsonRpcResponse;
  }
  return { body: parsed, sessionId: sid };
}

async function main() {
  console.log(`[test] Server=${SERVER} agent=${AGENT_ID} org=${ORG_ID}`);

  const apiKey = await mintApiKey();
  console.log(`[test] Minted apiKey prefix=${apiKey.slice(0, 8)}...`);

  // 1. initialize
  const init = await mcpCall(apiKey, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: { tools: {} },
      clientInfo: { name: "closed-loop-test", version: "1.0.0" },
    },
  });
  if (init.body.error)
    throw new Error(`initialize failed: ${init.body.error.message}`);
  const sessionId = init.sessionId;
  console.log(`[test] initialize OK; session=${sessionId ?? "<none>"}`);

  await fetch(`${SERVER}/mcp/virtual-mcp/${AGENT_ID}`, {
    method: "POST",
    headers: mcpHeaders(apiKey, sessionId ?? undefined),
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  // 2. tools/list — find the namespaced tool names we need
  const list = await mcpCall(
    apiKey,
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    sessionId ?? undefined,
  );
  if (list.body.error)
    throw new Error(`tools/list failed: ${list.body.error.message}`);
  // biome-ignore lint/suspicious/noExplicitAny: ad-hoc JSON-RPC payload
  const tools = ((list.body.result as any)?.tools ?? []) as Array<{
    name: string;
  }>;
  console.log(`[test] tools/list returned ${tools.length} tools`);

  function resolveTool(suffix: string): string {
    const exact = tools.find((t) => t.name === suffix);
    if (exact) return exact.name;
    const suff = tools.find((t) => t.name.endsWith(`_${suffix}`));
    if (suff) return suff.name;
    throw new Error(`tool not exposed: ${suffix}`);
  }

  const T = {
    DESIGN_SYSTEM_CREATE: resolveTool("DESIGN_SYSTEM_CREATE"),
    PAGE_PREVIEW_PAGE_CREATE: resolveTool("PAGE_PREVIEW_PAGE_CREATE"),
    PAGE_PREVIEW_REFRESH: resolveTool("PAGE_PREVIEW_REFRESH"),
    PAGE_PREVIEW_STATUS: resolveTool("PAGE_PREVIEW_STATUS"),
  };
  console.log("[test] Tool name resolution:");
  for (const [k, v] of Object.entries(T)) console.log(`  ${k} -> ${v}`);

  async function callTool(
    name: string,
    args: Record<string, unknown>,
    id: number,
  ) {
    const res = await mcpCall(
      apiKey,
      {
        jsonrpc: "2.0",
        id,
        method: "tools/call",
        params: { name, arguments: args },
      },
      sessionId ?? undefined,
    );
    if (res.body.error)
      throw new Error(
        `${name} failed: ${res.body.error.message}\n  full=${JSON.stringify(res.body.error)}`,
      );
    // biome-ignore lint/suspicious/noExplicitAny: ad-hoc JSON-RPC payload
    const result = res.body.result as any;
    if (result?.isError) {
      throw new Error(
        `${name} returned isError: ${JSON.stringify(result.content).slice(0, 200)}`,
      );
    }
    return result?.structuredContent ?? result;
  }

  const dsSlug = `closedloop-${Date.now().toString(36)}`;
  const dsResult = await callTool(
    T.DESIGN_SYSTEM_CREATE,
    {
      slug: dsSlug,
      name: "Closed Loop DS",
      brand: { primary: "#22D3EE", accent: "#F472B6", name: "Closed Loop" },
    },
    3,
  );
  if (dsResult?.slug !== dsSlug)
    throw new Error(`DESIGN_SYSTEM_CREATE slug mismatch: ${dsResult?.slug}`);
  if (dsResult?.status?.activeKind !== "design-system")
    throw new Error(
      `DESIGN_SYSTEM_CREATE did not activate as design-system: ${dsResult?.status?.activeKind}`,
    );
  console.log(`[test] DESIGN_SYSTEM_CREATE OK slug=${dsSlug}`);

  const pageSlug = `closedloop-page-${Date.now().toString(36)}`;
  const pageResult = await callTool(
    T.PAGE_PREVIEW_PAGE_CREATE,
    {
      slug: pageSlug,
      designSystem: dsSlug,
      title: "Closed Loop Page",
      description: "scaffolded by closed-loop test",
      // Verify the new behavior: page exists but preview stays on the DS.
    },
    4,
  );
  if (pageResult?.slug !== pageSlug)
    throw new Error(`PAGE_CREATE slug mismatch: ${pageResult?.slug}`);
  if (pageResult?.status?.activeKind !== "design-system")
    throw new Error(
      `PAGE_CREATE should leave preview on design system; got ${pageResult?.status?.activeKind}`,
    );
  const created = pageResult?.status?.pages?.find(
    (p: { slug: string }) => p.slug === pageSlug,
  );
  if (!created)
    throw new Error(`PAGE_CREATE did not record the page in status.pages`);
  if (created.designSystem !== dsSlug)
    throw new Error(`PAGE_CREATE binding mismatch: ${created.designSystem}`);
  console.log(
    `[test] PAGE_PREVIEW_PAGE_CREATE OK slug=${pageSlug} (preview stays on DS)`,
  );

  const refreshBefore = pageResult.status.refreshVersion;
  const refreshResult = await callTool(T.PAGE_PREVIEW_REFRESH, {}, 5);
  if (refreshResult?.refreshVersion <= refreshBefore)
    throw new Error(
      `REFRESH did not bump version (${refreshBefore} -> ${refreshResult?.refreshVersion})`,
    );
  console.log(
    `[test] PAGE_PREVIEW_REFRESH OK ${refreshBefore} -> ${refreshResult?.refreshVersion}`,
  );

  // Verify export endpoint returns a zip
  const exportRes = await fetch(
    `${SERVER}/api/${ORG_SLUG}/page-preview/export?kind=page&slug=${pageSlug}`,
    { headers: { Authorization: `Bearer ${apiKey}`, "x-org-id": ORG_ID } },
  );
  if (!exportRes.ok)
    throw new Error(`export endpoint returned HTTP ${exportRes.status}`);
  const ct = exportRes.headers.get("content-type");
  if (!ct?.includes("application/zip"))
    throw new Error(`export content-type unexpected: ${ct}`);
  const buf = new Uint8Array(await exportRes.arrayBuffer());
  // ZIP files start with PK\x03\x04
  if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04)
    throw new Error(
      `export bytes are not a valid zip header: ${buf.slice(0, 4).join(",")}`,
    );
  console.log(`[test] export endpoint OK; ${buf.byteLength} bytes`);

  // Status reflects the new page + design system
  const statusResult = await callTool(T.PAGE_PREVIEW_STATUS, {}, 6);
  const hasDs = statusResult?.designSystems?.some(
    (d: { slug: string }) => d.slug === dsSlug,
  );
  const hasPage = statusResult?.pages?.some(
    (p: { slug: string }) => p.slug === pageSlug,
  );
  if (!hasDs || !hasPage)
    throw new Error(
      `STATUS missing entries (ds=${hasDs} page=${hasPage}): ${JSON.stringify(statusResult).slice(0, 300)}`,
    );
  console.log(`[test] PAGE_PREVIEW_STATUS reflects both entries`);

  console.log("\n[test] PASS — full Page Editor flow works end-to-end");
  process.exit(0);
}

main().catch((err) => {
  console.error("[test] ERROR:", err);
  process.exit(1);
});
