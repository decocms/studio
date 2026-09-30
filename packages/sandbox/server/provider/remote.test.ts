import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { z } from "zod";
import { ConfigRequestError } from "../daemon-client";
import type { ClaimPhase } from "./agent-sandbox/lifecycle-types";
import { RemoteSandboxProvider, SandboxHostError } from "./remote";
import { SANDBOX_WATCH_PATH } from "./sandbox-api";
import {
  PushedCredentials,
  sandboxTools,
  sandboxWatchResponse,
} from "./sandbox-server";
import { computeHandle } from "./shared";

// The client against the host helpers it is paired with, over real MCP and
// SSE, registered the way @decocms/runtime registers tools (by `.shape`).

const TOKEN = "host-token";
const ID = { userId: "u1", projectRef: "agent:o1:a1:thread/contract" };
const HANDLE = computeHandle(ID);

const calls: string[] = [];
let ensureFails: Error | null = null;
let ensureWaitMs = 0;
let lastEnsureOpts: unknown = null;
const store = new PushedCredentials();
const TENANT = { orgId: "o1", userId: "u1" };
const REPO = { connectionId: "c1", repo: "acme/site" };
const CLONE = "https://x-access-token:ghs_1@github.com/acme/site.git";
/** Replaces the watch route when set. */
let watchRoute: ((req: Request) => Response) | null = null;
const phases: ClaimPhase[] = [
  { kind: "claiming", since: 1 },
  { kind: "pulling-image", since: 2 },
  { kind: "ready" },
];

const fake = {
  ensure: async (_id: unknown, opts: unknown) => {
    calls.push("ensure");
    lastEnsureOpts = opts;
    if (ensureWaitMs) await Bun.sleep(ensureWaitMs);
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
  alive: async () => {
    calls.push("alive");
    return true;
  },
  getPreviewUrl: async () => "https://preview.example.com/",
  lastTermination: async () => null,
  renewTtl: async () => void calls.push("renew"),
  releaseAfter: async (_h: string, ms: number) =>
    void calls.push(`release:${ms}`),
  hasSchedulableCapacity: async () => false,
  markTenantPoolsDirty: async () => ["pool-a"],
  listSandboxes: () => [
    { handle: HANDLE, tenant: TENANT, repos: [REPO], orgFs: true },
  ],
  listTenantPools: () => [
    {
      name: "acme",
      tenant: "o1",
      size: 3,
      image: "default",
      repos: [
        {
          repoUrl: "https://github.com/acme/site",
          branch: "main",
          workload: { runtime: "node" as const },
          replicas: 2,
        },
      ],
    },
    { name: "acme-blank", tenant: "o1", size: 1, image: "android", repos: [] },
  ],
  async *watchClaimLifecycle() {
    yield* phases;
  },
};

async function serveMcp(req: Request): Promise<Response> {
  const server = new McpServer(
    { name: "host", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  for (const tool of sandboxTools(() => fake, store)) {
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
        if (watchRoute) return watchRoute(req);
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
    credentialLifetimeMs: { orgFsConfig: 60 * 60_000 },
    stallMs: STALL_MS,
  });
});

afterEach(() => {
  watchRoute = null;
  ensureWaitMs = 0;
  ensureFails = null;
});

const STALL_MS = 400;

/** An SSE response the test writes by hand. */
function sse(write: (send: (text: string) => void) => Promise<void>): Response {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream<Uint8Array>({
      async start(controller) {
        try {
          await write((text) => controller.enqueue(encoder.encode(text)));
          controller.close();
        } catch (err) {
          controller.error(err);
        }
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
}

const data = (phase: ClaimPhase) => `data: ${JSON.stringify(phase)}\n\n`;

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

  it("surfaces the host error's causes, not only its outer message", async () => {
    ensureFails = new Error("Failed to create SandboxClaim", {
      cause: new Error("503: Service Unavailable"),
    });
    const err = await provider.ensure(ID).catch((e: unknown) => e);
    expect(String(err)).toContain(
      "Failed to create SandboxClaim: 503: Service Unavailable",
    );
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
    expect(
      await provider.markTenantPoolsDirty(
        "https://github.com/acme/app",
        "refs/heads/main",
      ),
    ).toEqual(["pool-a"]);
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

  it("seeds the host's store with the credentials an ensure carries", async () => {
    const opts = {
      tenant: TENANT,
      repo: {
        cloneUrl: CLONE,
        connectionId: "c1",
        userName: "u",
        userEmail: "e",
        // A fresh installation token's own expiry.
        credentialExpiresAt: Date.now() + 55 * 60_000,
      },
      orgFsConfigJson: '{"token":"k"}',
    };
    await provider.ensure(ID, opts);
    expect(lastEnsureOpts).toEqual(opts);
    // Good for the runner's 30-minute re-mint, not for a 55-minute one.
    expect(store.cloneUrl(TENANT, REPO, 30 * 60_000)).toBe(CLONE);
    expect(store.cloneUrl(TENANT, REPO, 55 * 60_000)).toBeNull();
    expect(store.orgFsConfig(TENANT)).toBe('{"token":"k"}');
  });

  it("pushes credentials and lists sandboxes and pools over the tools", async () => {
    const expiresAt = Date.now() + 2 * 60 * 60_000;
    const pushed = await provider.pushCredentials({
      cloneUrls: [{ tenant: TENANT, repo: REPO, cloneUrl: CLONE, expiresAt }],
      poolCloneUrls: [
        {
          tenant: "o1",
          repoUrl: "https://github.com/acme/site",
          cloneUrl: CLONE,
          expiresAt,
        },
      ],
      orgFsConfigs: [{ tenant: TENANT, orgFsConfigJson: "{}", expiresAt }],
    });
    expect(pushed).toEqual({ stored: 3, kept: 0 });
    expect(store.cloneUrl(TENANT, REPO, 30 * 60_000)).toBe(CLONE);
    expect(store.poolCloneUrl("o1", "https://github.com/acme/site")).toBe(
      CLONE,
    );
    expect(await provider.list()).toEqual({
      sandboxes: [
        {
          handle: HANDLE,
          tenant: TENANT,
          repos: [REPO],
          orgFs: true,
          orgFsConfigExpiresAt: expiresAt,
        },
      ],
      pools: [
        {
          name: "acme",
          tenant: "o1",
          image: "default",
          repos: [{ repoUrl: "https://github.com/acme/site", branch: "main" }],
        },
        { name: "acme-blank", tenant: "o1", image: "android", repos: [] },
      ],
    });
  });

  it.each([
    [
      "an oversized batch",
      {
        cloneUrls: Array.from({ length: 2_001 }, () => ({
          tenant: TENANT,
          repo: REPO,
          cloneUrl: CLONE,
          expiresAt: Date.now() + 60_000,
        })),
        orgFsConfigs: [],
      },
    ],
    [
      "a clone URL that is not one",
      {
        cloneUrls: [
          { tenant: TENANT, repo: REPO, cloneUrl: "ssh://x", expiresAt: 1 },
        ],
        orgFsConfigs: [],
      },
    ],
    [
      "a repo named two ways",
      {
        cloneUrls: [
          {
            tenant: TENANT,
            repo: { ...REPO, repositoryId: "r1" },
            cloneUrl: CLONE,
            expiresAt: 1,
          },
        ],
        orgFsConfigs: [],
      },
    ],
    [
      "a clone URL with no tenant",
      {
        cloneUrls: [
          { tenant: null, repo: REPO, cloneUrl: CLONE, expiresAt: 1 },
        ],
        orgFsConfigs: [],
      },
    ],
    [
      "an oversized pool batch",
      {
        cloneUrls: [],
        poolCloneUrls: Array.from({ length: 2_001 }, () => ({
          tenant: "o1",
          repoUrl: "https://github.com/acme/site",
          cloneUrl: CLONE,
          expiresAt: Date.now() + 60_000,
        })),
        orgFsConfigs: [],
      },
    ],
    [
      "an oversized org-fs config",
      {
        cloneUrls: [],
        orgFsConfigs: [
          { tenant: TENANT, orgFsConfigJson: "x".repeat(70_000), expiresAt: 1 },
        ],
      },
    ],
  ])("refuses %s without storing", async (_label, batch) => {
    const err = await provider
      .pushCredentials(batch as never)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
  });

  it("waits out a long ensure while the host's watch keeps talking", async () => {
    ensureWaitMs = STALL_MS * 3;
    watchRoute = () =>
      sse(async (send) => {
        send(data({ kind: "pulling-image", since: 1 }));
        for (let i = 0; i < 12; i++) {
          await Bun.sleep(STALL_MS / 4);
          send(": keepalive\n\n");
        }
      });
    const sandbox = await provider.ensure(ID);
    expect(sandbox.handle).toBe(HANDLE);
  });

  it("gives up on an ensure once the host goes silent", async () => {
    ensureWaitMs = STALL_MS * 20;
    watchRoute = () => sse(() => new Promise(() => {}));
    const started = Date.now();
    const err = await provider.ensure(ID).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxHostError);
    expect(String(err)).toContain("no progress");
    expect(Date.now() - started).toBeLessThan(STALL_MS * 10);
  });

  it("answers the preview URL from the ensure it cached", async () => {
    await provider.ensure(ID);
    calls.length = 0;
    expect(await provider.getPreviewUrl(HANDLE)).toBeNull();
    expect(calls).toEqual([]);
  });

  it("reconnects a dropped watch without repeating the phase it had", async () => {
    let connections = 0;
    watchRoute = () => {
      connections++;
      if (connections === 1) {
        return sse(async (send) => {
          send(data({ kind: "claiming", since: 1 }));
          await Bun.sleep(20);
          throw new Error("idle cut");
        });
      }
      return sse(async (send) => {
        send(data({ kind: "claiming", since: 1 }));
        send(data({ kind: "ready" }));
      });
    };
    const seen: ClaimPhase[] = [];
    for await (const phase of provider.watchClaimLifecycle(HANDLE)) {
      seen.push(phase);
    }
    expect(connections).toBe(2);
    expect(seen).toEqual([{ kind: "claiming", since: 1 }, { kind: "ready" }]);
  });

  it("fails a watch only after the host stays unreachable", async () => {
    watchRoute = () => new Response(null, { status: 503 });
    const started = Date.now();
    const seen: ClaimPhase[] = [];
    for await (const phase of provider.watchClaimLifecycle(HANDLE)) {
      seen.push(phase);
    }
    expect(Date.now() - started).toBeGreaterThanOrEqual(STALL_MS);
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ kind: "failed" });
  });

  it("cuts a watch that goes silent and reconnects it", async () => {
    let connections = 0;
    watchRoute = () => {
      connections++;
      return connections === 1
        ? sse(() => new Promise(() => {}))
        : sse(async (send) => send(data({ kind: "ready" })));
    };
    const seen: ClaimPhase[] = [];
    for await (const phase of provider.watchClaimLifecycle(HANDLE)) {
      seen.push(phase);
    }
    expect(seen).toEqual([{ kind: "ready" }]);
  });
});
