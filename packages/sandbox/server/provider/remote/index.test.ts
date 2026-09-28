import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import {
  CallToolRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import { ConfigRequestError } from "../../daemon-client";
import { computeHandle } from "../shared";
import type { SandboxId } from "../types";
import {
  RemoteSandboxProvider,
  SandboxControllerError,
  SandboxDrainingError,
  toClaimPhase,
} from "./index";

const id: SandboxId = {
  userId: "user_1",
  projectRef: "agent:org_1:vmcp_1:thread:thrd_1/conn_1",
};
const handle = computeHandle(id);

const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

type Seen = { headers: Headers; url: string };

function serve(handler: (req: Request) => Response | Promise<Response>) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: (req) => {
      seen.push({ headers: req.headers, url: req.url });
      return handler(req);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}

/** A daemon that accepts exactly one bearer. */
function daemon(token: string) {
  return serve((req) =>
    req.headers.get("authorization") === `Bearer ${token}`
      ? Response.json({ ok: true, path: new URL(req.url).pathname })
      : Response.json({ error: "unauthorized" }, { status: 401 }),
  );
}

type Progress = (message: string) => Promise<void>;
type Tool = (
  args: Record<string, unknown>,
  progress: Progress,
) => CallToolResult | Promise<CallToolResult>;

const ok = (value: unknown): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value as Record<string, unknown>,
});

const fail = (body: unknown): CallToolResult => ({
  isError: true,
  content: [{ type: "text", text: JSON.stringify(body) }],
});

/** A stateless MCP controller answering each tool with `tools[name]`. */
function controller(
  tools: Record<string, Tool>,
  tls?: Bun.TLSOptions,
): { url: string; calls: Array<{ tool: string; args: unknown }> } {
  const calls: Array<{ tool: string; args: unknown }> = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    ...(tls ? { tls } : {}),
    fetch: async (req) => {
      const mcp = new Server(
        { name: "fake-controller", version: "0" },
        { capabilities: { tools: {} } },
      );
      mcp.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
        const { name, arguments: args = {} } = request.params;
        calls.push({ tool: name, args });
        const tool = tools[name];
        if (!tool) return fail({ error: `no tool ${name}`, code: "internal" });
        let n = 0;
        const token = request.params._meta?.progressToken;
        return tool(args, async (message) => {
          if (token === undefined) return;
          await extra.sendNotification({
            method: "notifications/progress",
            params: { progressToken: token, progress: ++n, message },
          });
        });
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
      });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, calls };
}

function ensureBody(daemonUrl: string, token: string) {
  return {
    handle,
    workdir: "/app",
    previewUrl: `https://${handle}.preview.example.test/`,
    daemon: { url: daemonUrl, token },
    runtime: "agent-sandbox",
    image: { requested: "default", served: "default" },
    warmPoolAdopted: false,
    capabilities: ["preview", "ttl-extend", "from-a-newer-controller"],
  };
}

function statusBody(daemonUrl: string | null, token: string, alive = true) {
  return {
    handle,
    alive,
    previewUrl: null,
    daemon: daemonUrl ? { url: daemonUrl, token } : null,
    runtime: "agent-sandbox",
    image: null,
    capabilities: [],
    lastTermination: null,
  };
}

const unknownHandle = () =>
  fail({ error: "no sandbox", code: "unknown-handle" });

const get = { method: "GET", headers: new Headers(), body: null };

describe("RemoteSandboxProvider.ensure", () => {
  it("sends the Studio-derived handle and dials the returned daemon directly", async () => {
    const d = daemon("tok");
    const ctl = controller({
      SANDBOX_ENSURE: () => ok(ensureBody(d.url, "tok")),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });

    const sandbox = await provider.ensure(id, {
      image: "pinned-by-template",
      sandboxImage: "android",
      cloneOnly: true,
    });

    expect(sandbox).toEqual({
      handle,
      workdir: "/app",
      previewUrl: `https://${handle}.preview.example.test/`,
      warmPoolAdopted: false,
    });
    expect(ctl.calls).toEqual([
      {
        tool: "SANDBOX_ENSURE",
        args: {
          id,
          handle,
          opts: { sandboxImage: "android", cloneOnly: true },
        },
      },
    ]);

    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);
    expect(res.status).toBe(200);
    // The cached address served it; no status read.
    expect(ctl.calls).toHaveLength(1);
  });

  it("surfaces a rejected bootstrap as the daemon's config error", async () => {
    const ctl = controller({
      SANDBOX_ENSURE: () =>
        fail({
          error: "rotate refused",
          code: "bootstrap-rejected",
          status: 401,
        }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const err = await provider.ensure(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigRequestError);
    expect((err as ConfigRequestError).status).toBe(401);
  });

  it("carries the controller's code and per-runtime reasons", async () => {
    const ctl = controller({
      SANDBOX_ENSURE: () =>
        fail({
          error: "no runtime can place this sandbox",
          code: "no-runtime",
          reasons: { "agent-sandbox": "full" },
        }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const err = await provider.ensure(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SandboxControllerError);
    expect((err as SandboxControllerError).code).toBe("no-runtime");
    expect((err as Error).message).toContain("agent-sandbox: full");
  });

  it.each([
    ["a missing daemon token", { daemon: { url: "http://x" } }],
    ["a non-http daemon url", { daemon: { url: "file:///etc", token: "t" } }],
    ["a string warmPoolAdopted", { warmPoolAdopted: "yes" }],
    ["another handle", { handle: "someone-else" }],
  ])("rejects a result with %s", async (_label, patch) => {
    const ctl = controller({
      SANDBOX_ENSURE: () =>
        ok({ ...ensureBody("http://127.0.0.1:1", "t"), ...patch }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.ensure(id)).rejects.toBeInstanceOf(
      SandboxControllerError,
    );
  });

  it("words an error that is not an ErrorResponse", async () => {
    const ctl = controller({
      SANDBOX_ENSURE: () => ({
        isError: true,
        content: [{ type: "text", text: "validating arguments: boom" }],
      }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.ensure(id)).rejects.toThrow("validating arguments");
  });

  it("fails on a controller that does not speak MCP", async () => {
    const ctl = serve(() => new Response("<html>gateway</html>"));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.ensure(id)).rejects.toThrow();
  });
});

describe("RemoteSandboxProvider.proxyDaemonRequest", () => {
  it("re-reads the address on a 401 and retries once with the rotated token", async () => {
    const d = daemon("new");
    const ctl = controller({
      SANDBOX_ENSURE: () => ok(ensureBody(d.url, "old")),
      SANDBOX_STATUS: () => ok(statusBody(d.url, "new")),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.ensure(id);

    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);

    expect(res.status).toBe(200);
    expect(ctl.calls.filter((c) => c.tool === "SANDBOX_STATUS")).toEqual([
      { tool: "SANDBOX_STATUS", args: { handle, resurrect: true } },
    ]);
    expect(d.seen.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer old",
      "Bearer new",
    ]);
  });

  it("returns the 401 when the controller still hands out the same token", async () => {
    const d = daemon("other");
    const ctl = controller({
      SANDBOX_STATUS: () => ok(statusBody(d.url, "stale")),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });

    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);

    expect(res.status).toBe(401);
    expect(d.seen).toHaveLength(1);
  });

  it("does not retry a streamed body it has already consumed", async () => {
    const d = daemon("new");
    const ctl = controller({
      SANDBOX_ENSURE: () => ok(ensureBody(d.url, "old")),
      SANDBOX_STATUS: () => ok(statusBody(d.url, "new")),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.ensure(id);

    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", {
      method: "POST",
      headers: new Headers(),
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode("{}"));
          c.close();
        },
      }),
    });

    expect(res.status).toBe(401);
    expect(d.seen).toHaveLength(1);
  });

  it("answers 404 when the controller has no such sandbox", async () => {
    const ctl = controller({ SANDBOX_STATUS: unknownHandle });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);
    expect(res.status).toBe(404);
    expect(await provider.alive(handle)).toBe(false);
  });
});

describe("RemoteSandboxProvider.delete", () => {
  it("resolves once the controller has collected the sandbox", async () => {
    const ctl = controller({ SANDBOX_DELETE: () => ok({ state: "deleted" }) });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.delete(handle);
    expect(ctl.calls).toEqual([{ tool: "SANDBOX_DELETE", args: { handle } }]);
  });

  it("treats draining as retry, never as gone", async () => {
    const ctl = controller({ SANDBOX_DELETE: () => ok({ state: "draining" }) });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.delete(handle)).rejects.toBeInstanceOf(
      SandboxDrainingError,
    );
  });

  it("treats an unknown handle as already gone", async () => {
    const ctl = controller({ SANDBOX_DELETE: unknownHandle });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.delete(handle);
  });

  it("throws any other failure", async () => {
    const ctl = controller({
      SANDBOX_DELETE: () => fail({ error: "boom", code: "internal" }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.delete(handle)).rejects.toBeInstanceOf(
      SandboxControllerError,
    );
  });
});

describe("RemoteSandboxProvider lifetime", () => {
  it("renews and releases through the lifetime tool", async () => {
    const ctl = controller({ SANDBOX_LIFETIME: () => ok({}) });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.renewTtl(handle);
    await provider.releaseAfter(handle, 120_000);
    expect(ctl.calls).toEqual([
      { tool: "SANDBOX_LIFETIME", args: { handle, extendToIdleWindow: true } },
      { tool: "SANDBOX_LIFETIME", args: { handle, graceMs: 120_000 } },
    ]);
  });

  it("never throws: a missed renewal costs idle minutes, not a stream", async () => {
    const ctl = controller({
      SANDBOX_LIFETIME: () => fail({ error: "boom", code: "internal" }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.renewTtl(handle);
    await provider.releaseAfter(handle, 1);
  });
});

describe("RemoteSandboxProvider.listSandboxImages", () => {
  const images = (runtimes: unknown) =>
    controller({ SANDBOX_IMAGES: () => ok({ runtimes }) });

  it("merges every runtime's variants into one sorted list", async () => {
    const ctl = images([
      {
        runtime: "agent-sandbox",
        images: [{ name: "flutter", baseTag: "1.2.0" }, { name: "android" }],
      },
      { runtime: "docker", images: [{ name: "android" }] },
    ]);
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await provider.listSandboxImages()).toEqual(["android", "flutter"]);
    expect(ctl.calls[0]!.tool).toBe("SANDBOX_IMAGES");
  });

  it("drops default and names a repository cannot store", async () => {
    const ctl = images([
      {
        runtime: "agent-sandbox",
        images: [
          { name: "default" },
          { name: "Android" },
          { name: "" },
          { name: "x".repeat(40) },
          { name: "android" },
        ],
      },
    ]);
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await provider.listSandboxImages()).toEqual(["android"]);
  });

  it("answers an empty list when no runtime is available", async () => {
    const provider = new RemoteSandboxProvider({ baseUrl: images([]).url });
    expect(await provider.listSandboxImages()).toEqual([]);
  });

  it.each([
    ["a failed call", () => fail({ error: "nope", code: "internal" })],
    ["a malformed result", () => ok({ runtimes: "all" })],
  ])("throws on %s", async (_label, respond) => {
    const ctl = controller({ SANDBOX_IMAGES: respond });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.listSandboxImages()).rejects.toBeInstanceOf(
      SandboxControllerError,
    );
  });
});

describe("RemoteSandboxProvider.markTenantPoolsDirty", () => {
  it("sends the push and answers the pools the controller marked", async () => {
    const ctl = controller({
      SANDBOX_TENANT_POOLS_PUSH: () => ok({ pools: ["tenant-acme-site-ci"] }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(
      await provider.markTenantPoolsDirty("acme/site", "refs/heads/main"),
    ).toEqual(["tenant-acme-site-ci"]);
    expect(ctl.calls).toEqual([
      {
        tool: "SANDBOX_TENANT_POOLS_PUSH",
        args: { repo: "acme/site", ref: "refs/heads/main" },
      },
    ]);
  });

  it.each([
    ["a failed call", () => fail({ error: "nope", code: "internal" })],
    ["a malformed result", () => ok({ pools: "all" })],
  ])("answers no pools on %s", async (_label, respond) => {
    const ctl = controller({ SANDBOX_TENANT_POOLS_PUSH: respond });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(
      await provider.markTenantPoolsDirty("acme/site", "refs/heads/main"),
    ).toEqual([]);
  });
});

describe("RemoteSandboxProvider.hasSchedulableCapacity", () => {
  it("reuses an answer for a few seconds and coalesces concurrent callers", async () => {
    const ctl = controller({
      SANDBOX_CAPACITY: () => ok({ schedulable: false }),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const answers = await Promise.all([
      provider.hasSchedulableCapacity(),
      provider.hasSchedulableCapacity(),
    ]);
    expect(answers).toEqual([false, false]);
    expect(await provider.hasSchedulableCapacity()).toBe(false);
    expect(ctl.calls).toHaveLength(1);
  });

  it.each([
    ["a failed call", () => fail({ error: "nope", code: "internal" })],
    ["a malformed result", () => ok({ schedulable: "maybe" })],
  ])("admits on %s", async (_label, respond) => {
    const ctl = controller({ SANDBOX_CAPACITY: respond });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await provider.hasSchedulableCapacity()).toBe(true);
  });
});

describe("RemoteSandboxProvider.watchClaimLifecycle", () => {
  /** A watch that reports `phases` as progress, then returns `result`. */
  function watching(phases: unknown[], result: CallToolResult) {
    return controller({
      SANDBOX_WATCH: async (_args, progress) => {
        for (const p of phases) await progress(JSON.stringify(p));
        return result;
      },
    });
  }

  async function collect(provider: RemoteSandboxProvider) {
    const out = [];
    for await (const phase of provider.watchClaimLifecycle(handle))
      out.push(phase);
    return out;
  }

  it("yields each progress phase and stops at ready", async () => {
    const ctl = watching(
      [
        { kind: "claiming", since: 10 },
        { kind: "waiting-for-capacity", since: 10, nodeClaim: "nc-1" },
        { kind: "ready" },
      ],
      ok({ kind: "ready" }),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await collect(provider)).toEqual([
      { kind: "claiming", since: 10 },
      { kind: "waiting-for-capacity", since: 10, nodeClaim: "nc-1" },
      { kind: "ready" },
    ]);
    expect(ctl.calls).toEqual([{ tool: "SANDBOX_WATCH", args: { handle } }]);
  });

  it("ends on a failed phase with its reason", async () => {
    const failed = {
      kind: "failed",
      reason: "image-pull-backoff",
      message: "no tag",
    };
    const ctl = watching([failed], ok(failed));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await collect(provider)).toEqual([failed]);
  });

  it("fails a watch that ends before a terminal phase", async () => {
    const ctl = watching(
      [{ kind: "pulling-image", since: 1 }],
      fail({ error: "ended early", code: "internal" }),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const phases = await collect(provider);
    expect(phases.map((p) => p.kind)).toEqual(["pulling-image", "failed"]);
  });

  it("fails on an error answer instead of hanging", async () => {
    const ctl = watching(
      [],
      fail({ error: "runtime gone", code: "runtime-unreachable" }),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const phases = await collect(provider);
    expect(phases).toHaveLength(1);
    expect(phases[0]!.kind).toBe("failed");
  });

  it.each([
    ["non-JSON", "{nope"],
    ["an unknown kind", '{"kind":"teleporting"}'],
    ["an unknown failure reason", '{"kind":"failed","reason":"gremlins"}'],
  ])("turns %s into a failed phase", (_label, data) => {
    expect(toClaimPhase(data)).toMatchObject({
      kind: "failed",
      reason: "unknown",
    });
  });
});

describe("RemoteSandboxProvider.proxyPreviewRequest", () => {
  it("forwards to the daemon and refuses mutating /_sandbox calls", async () => {
    const d = serve(
      (req) => new Response(`served ${new URL(req.url).pathname}`),
    );
    const ctl = controller({
      SANDBOX_STATUS: () => ok(statusBody(d.url, "t")),
    });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });

    const served = await provider.proxyPreviewRequest(
      handle,
      new Request("https://preview.example.test/app?x=1"),
    );
    expect(await served.text()).toBe("served /app");
    const refused = await provider.proxyPreviewRequest(
      handle,
      new Request("https://preview.example.test/_sandbox/exec", {
        method: "POST",
      }),
    );
    expect(refused.status).toBe(404);
    expect(d.seen).toHaveLength(1);
  });

  it("marks a missing sandbox as not ready", async () => {
    const ctl = controller({ SANDBOX_STATUS: unknownHandle });
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const res = await provider.proxyPreviewRequest(
      handle,
      new Request("https://preview.example.test/"),
    );
    expect(res.status).toBe(404);
    expect(res.headers.get("x-sandbox-preview-not-ready")).toBe("1");
  });
});

const haveOpenssl = Bun.which("openssl") !== null;

describe("RemoteSandboxProvider mTLS", () => {
  it.skipIf(!haveOpenssl)(
    "presents Studio's certificate to a controller that requires one",
    async () => {
      const dir = mkdtempSync(join(tmpdir(), "remote-provider-mtls-"));
      try {
        const run = (...args: string[]) => {
          const r = Bun.spawnSync(["openssl", ...args], { cwd: dir });
          if (r.exitCode !== 0) throw new Error(r.stderr.toString());
        };
        const ec = [
          "-newkey",
          "ec",
          "-pkeyopt",
          "ec_paramgen_curve:prime256v1",
          "-nodes",
        ];
        run(
          "req",
          "-x509",
          ...ec,
          "-keyout",
          "ca.key",
          "-out",
          "ca.crt",
          "-days",
          "1",
          "-subj",
          "/CN=test-ca",
        );
        const issue = (name: string, ext: string) => {
          writeFileSync(join(dir, `${name}.ext`), ext);
          run(
            "req",
            ...ec,
            "-keyout",
            `${name}.key`,
            "-out",
            `${name}.csr`,
            "-subj",
            `/CN=${name}`,
          );
          run(
            "x509",
            "-req",
            "-in",
            `${name}.csr`,
            "-CA",
            "ca.crt",
            "-CAkey",
            "ca.key",
            "-CAcreateserial",
            "-out",
            `${name}.crt`,
            "-days",
            "1",
            "-extfile",
            `${name}.ext`,
          );
        };
        issue(
          "controller",
          "subjectAltName=IP:127.0.0.1\nextendedKeyUsage=serverAuth\n",
        );
        issue(
          "studio",
          "subjectAltName=DNS:studio\nextendedKeyUsage=clientAuth\n",
        );
        const pem = (f: string) => readFileSync(join(dir, f), "utf8");

        const ctl = controller(
          { SANDBOX_CAPACITY: () => ok({ schedulable: false }) },
          {
            cert: pem("controller.crt"),
            key: pem("controller.key"),
            ca: pem("ca.crt"),
            requestCert: true,
            rejectUnauthorized: true,
          },
        );
        const baseUrl = ctl.url.replace("http:", "https:");

        const withCert = new RemoteSandboxProvider({
          baseUrl,
          tls: {
            cert: pem("studio.crt"),
            key: pem("studio.key"),
            ca: pem("ca.crt"),
          },
        });
        expect(await withCert.hasSchedulableCapacity()).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
