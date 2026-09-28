import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { z } from "zod";
import { ConfigRequestError } from "../daemon-client";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import { RemoteSandboxProvider } from "./remote";
import { SANDBOX_WATCH_PATH } from "./sandbox-api";
import { sandboxTools, sandboxWatchResponse } from "./sandbox-server";
import { computeHandle } from "./shared";

// The client against the host helpers it is paired with, over real MCP and
// SSE, registered the way @decocms/runtime registers tools (by `.shape`).

const TOKEN = "host-token";
const ID = { userId: "u1", projectRef: "agent:o1:a1:thread/contract" };
const HANDLE = computeHandle(ID);

const calls: string[] = [];
let ensureFails: Error | null = null;
const phases: ClaimPhase[] = [
  { kind: "claiming", since: 1 },
  { kind: "pulling-image", since: 2 },
  { kind: "ready" },
];

const fake = {
  ensure: async () => {
    calls.push("ensure");
    if (ensureFails) throw ensureFails;
    return {
      handle: HANDLE,
      workdir: "/app",
      previewUrl: null,
      warmPoolAdopted: true,
    };
  },
  daemonEndpoint: async () => ({ url: "http://127.0.0.1:1", token: "d-tok" }),
  delete: async () => void calls.push("delete"),
  alive: async () => true,
  getPreviewUrl: async () => null,
  lastTermination: async () => null,
  renewTtl: async () => void calls.push("renew"),
  releaseAfter: async (_h: string, ms: number) =>
    void calls.push(`release:${ms}`),
  hasSchedulableCapacity: async () => false,
  markTenantPoolsDirty: async () => ["pool-a"],
  async *watchClaimLifecycle() {
    yield* phases;
  },
};

async function serveMcp(req: Request): Promise<Response> {
  const server = new McpServer(
    { name: "host", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  for (const tool of sandboxTools(() => fake)) {
    server.registerTool(
      tool.id,
      {
        description: tool.description,
        inputSchema: (tool.inputSchema as z.ZodObject).shape,
        outputSchema: (tool.outputSchema as z.ZodObject).shape,
      },
      async (args) => {
        try {
          const result = (await tool.execute(args)) as Record<string, unknown>;
          return {
            structuredContent: result,
            content: [{ type: "text", text: JSON.stringify(result) }],
          };
        } catch (err) {
          return {
            isError: true,
            content: [{ type: "text", text: (err as Error).message }],
          };
        }
      },
    );
  }
  const transport = new WebStandardStreamableHTTPServerTransport({});
  await server.connect(transport);
  return transport.handleRequest(req);
}

let host: ReturnType<typeof Bun.serve>;
let provider: RemoteSandboxProvider;

beforeAll(() => {
  host = Bun.serve({
    port: 0,
    fetch: (req) => {
      if (req.headers.get("authorization") !== `Bearer ${TOKEN}`) {
        return new Response(null, { status: 401 });
      }
      const url = new URL(req.url);
      if (url.pathname === SANDBOX_WATCH_PATH) {
        return sandboxWatchResponse(
          fake,
          url.searchParams.get("handle") ?? "",
          req.signal,
        );
      }
      return serveMcp(req);
    },
  });
  provider = new RemoteSandboxProvider({
    baseUrl: `http://127.0.0.1:${host.port}`,
    token: TOKEN,
  });
});

afterAll(() => {
  provider.close();
  host.stop(true);
});

describe("RemoteSandboxProvider against the host tools", () => {
  it("ensures and keeps the daemon the host answered", async () => {
    ensureFails = null;
    const sandbox = await provider.ensure(ID, { image: "pinned:by-template" });
    expect(sandbox).toEqual({
      handle: HANDLE,
      workdir: "/app",
      previewUrl: null,
      warmPoolAdopted: true,
    });
    expect(await provider.resolvePreviewUpstreamUrl(HANDLE)).toBe(
      "http://127.0.0.1:1",
    );
  });

  it("surfaces a rejected bootstrap as the daemon's own error", async () => {
    ensureFails = new ConfigRequestError(409, "token already rotated");
    const err = await provider.ensure(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigRequestError);
    expect((err as ConfigRequestError).status).toBe(409);
    ensureFails = null;
  });

  it("renews without graceMs and releases with it", async () => {
    calls.length = 0;
    await provider.renewTtl(HANDLE);
    await provider.releaseAfter(HANDLE, 1500.4);
    expect(calls).toEqual(["renew", "release:1500"]);
  });

  it("maps capacity and tenant pools", async () => {
    expect(await provider.hasSchedulableCapacity()).toBe(false);
    expect(await provider.markTenantPoolsDirty("acme/app", "main")).toEqual([
      "pool-a",
    ]);
  });

  it("streams phases until the terminal one", async () => {
    const seen: ClaimPhase[] = [];
    for await (const phase of provider.watchClaimLifecycle(HANDLE)) {
      seen.push(phase);
    }
    expect(seen).toEqual(phases);
  });

  it("reads a refused watch as a failed phase", async () => {
    const stranger = new RemoteSandboxProvider({
      baseUrl: `http://127.0.0.1:${host.port}`,
      token: "wrong",
    });
    const seen: ClaimPhase[] = [];
    for await (const phase of stranger.watchClaimLifecycle(HANDLE)) {
      seen.push(phase);
    }
    expect(seen).toEqual([
      { kind: "failed", reason: "unknown", message: "watch answered 401" },
    ]);
  });
});
