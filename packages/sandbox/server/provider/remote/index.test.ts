import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

type Handler = (req: Request) => Response | Promise<Response>;
const servers: Array<{ stop: (force?: boolean) => unknown }> = [];

afterEach(() => {
  for (const s of servers.splice(0)) s.stop(true);
});

type Seen = {
  method: string;
  url: string;
  headers: Headers;
  json: () => unknown;
};

function serve(handler: Handler) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    fetch: async (req) => {
      const text = await req.clone().text();
      seen.push({
        method: req.method,
        url: req.url,
        headers: req.headers,
        json: () => JSON.parse(text),
      });
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

const get = { method: "GET", headers: new Headers(), body: null };

describe("RemoteSandboxProvider.ensure", () => {
  it("posts the Studio-derived handle and dials the returned daemon directly", async () => {
    const d = daemon("tok");
    const ctl = serve(() => Response.json(ensureBody(d.url, "tok")));
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
    const sent = ctl.seen[0]!.json();
    expect(ctl.seen[0]!.method).toBe("POST");
    expect(new URL(ctl.seen[0]!.url).pathname).toBe("/sandboxes");
    expect(sent).toEqual({
      id,
      handle,
      opts: { sandboxImage: "android", cloneOnly: true },
    });

    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);
    expect(res.status).toBe(200);
    // The cached address served it; no status read.
    expect(ctl.seen).toHaveLength(1);
  });

  it("surfaces a rejected bootstrap as the daemon's config error", async () => {
    const ctl = serve(() =>
      Response.json(
        { error: "rotate refused", code: "bootstrap-rejected", status: 401 },
        { status: 502 },
      ),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const err = await provider.ensure(id).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigRequestError);
    expect((err as ConfigRequestError).status).toBe(401);
  });

  it("carries the controller's code and per-runtime reasons", async () => {
    const ctl = serve(() =>
      Response.json(
        {
          error: "no runtime can place this sandbox",
          code: "no-runtime",
          reasons: { "agent-sandbox": "full" },
        },
        { status: 503 },
      ),
    );
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
  ])("rejects a response with %s", async (_label, patch) => {
    const ctl = serve(() =>
      Response.json({ ...ensureBody("http://127.0.0.1:1", "t"), ...patch }),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.ensure(id)).rejects.toBeInstanceOf(
      SandboxControllerError,
    );
  });

  it("rejects a non-JSON body", async () => {
    const ctl = serve(() => new Response("<html>gateway</html>"));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.ensure(id)).rejects.toThrow("non-JSON");
  });
});

describe("RemoteSandboxProvider.proxyDaemonRequest", () => {
  it("re-reads the address on a 401 and retries once with the rotated token", async () => {
    const d = daemon("new");
    const ctl = serve((req) =>
      req.method === "POST"
        ? Response.json(ensureBody(d.url, "old"))
        : Response.json(statusBody(d.url, "new")),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.ensure(id);

    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);

    expect(res.status).toBe(200);
    const reads = ctl.seen.filter((r) => r.method === "GET");
    expect(reads).toHaveLength(1);
    expect(new URL(reads[0]!.url).search).toBe("?resurrect=1");
    expect(d.seen.map((r) => r.headers.get("authorization"))).toEqual([
      "Bearer old",
      "Bearer new",
    ]);
  });

  it("returns the 401 when the controller still hands out the same token", async () => {
    const d = daemon("other");
    const ctl = serve(() => Response.json(statusBody(d.url, "stale")));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });

    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);

    expect(res.status).toBe(401);
    expect(d.seen).toHaveLength(1);
  });

  it("does not retry a streamed body it has already consumed", async () => {
    const d = daemon("new");
    const ctl = serve((req) =>
      req.method === "POST"
        ? Response.json(ensureBody(d.url, "old"))
        : Response.json(statusBody(d.url, "new")),
    );
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
    const ctl = serve(() =>
      Response.json(
        { error: "no sandbox", code: "unknown-handle" },
        { status: 404 },
      ),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const res = await provider.proxyDaemonRequest(handle, "/_sandbox/x", get);
    expect(res.status).toBe(404);
    expect(await provider.alive(handle)).toBe(false);
  });
});

describe("RemoteSandboxProvider.delete", () => {
  it("resolves once the controller has collected the sandbox", async () => {
    const ctl = serve(() => new Response(null, { status: 204 }));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.delete(handle);
    expect(ctl.seen[0]!.method).toBe("DELETE");
    expect(new URL(ctl.seen[0]!.url).pathname).toBe(`/sandboxes/${handle}`);
  });

  it("treats 202 draining as retry, never as gone", async () => {
    const ctl = serve(() =>
      Response.json({ state: "draining" }, { status: 202 }),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await expect(provider.delete(handle)).rejects.toBeInstanceOf(
      SandboxDrainingError,
    );
  });

  it("treats an unknown handle as already gone", async () => {
    const ctl = serve(() =>
      Response.json({ error: "gone", code: "unknown-handle" }, { status: 404 }),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.delete(handle);
  });
});

describe("RemoteSandboxProvider lifetime", () => {
  it("renews and releases through PATCH lifetime", async () => {
    const ctl = serve(() => new Response(null, { status: 204 }));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.renewTtl(handle);
    await provider.releaseAfter(handle, 120_000);
    expect(ctl.seen.map((r) => r.method)).toEqual(["PATCH", "PATCH"]);
    expect(new URL(ctl.seen[0]!.url).pathname).toBe(
      `/sandboxes/${handle}/lifetime`,
    );
    expect(ctl.seen[0]!.json()).toEqual({ extendToIdleWindow: true });
    expect(ctl.seen[1]!.json()).toEqual({ graceMs: 120_000 });
  });

  it("never throws: a missed renewal costs idle minutes, not a stream", async () => {
    const ctl = serve(() =>
      Response.json({ error: "boom", code: "internal" }, { status: 500 }),
    );
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    await provider.renewTtl(handle);
    await provider.releaseAfter(handle, 1);
  });
});

describe("RemoteSandboxProvider.hasSchedulableCapacity", () => {
  it("reuses an answer for a few seconds and coalesces concurrent callers", async () => {
    const ctl = serve(() => Response.json({ schedulable: false }));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const answers = await Promise.all([
      provider.hasSchedulableCapacity(),
      provider.hasSchedulableCapacity(),
    ]);
    expect(answers).toEqual([false, false]);
    expect(await provider.hasSchedulableCapacity()).toBe(false);
    expect(ctl.seen).toHaveLength(1);
    expect(new URL(ctl.seen[0]!.url).pathname).toBe("/capacity");
  });

  it.each([
    ["an error status", () => new Response("nope", { status: 500 })],
    ["a malformed body", () => Response.json({ schedulable: "maybe" })],
  ])("admits on %s", async (_label, respond) => {
    const ctl = serve(respond);
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await provider.hasSchedulableCapacity()).toBe(true);
  });
});

describe("RemoteSandboxProvider.watchClaimLifecycle", () => {
  function sse(chunks: string[]) {
    return serve(
      () =>
        new Response(
          new ReadableStream({
            start(c) {
              for (const chunk of chunks)
                c.enqueue(new TextEncoder().encode(chunk));
              c.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    );
  }

  async function collect(provider: RemoteSandboxProvider) {
    const out = [];
    for await (const phase of provider.watchClaimLifecycle(handle))
      out.push(phase);
    return out;
  }

  it("parses phases split across chunks and skips keepalives", async () => {
    const ctl = sse([
      ": keepalive\n\n",
      'data: {"kind":"claiming","since":10}\n\ndata: {"kind":"waiting-for-',
      'capacity","since":10,"nodeClaim":"nc-1"}\n\n',
      'data: {"kind":"ready"}\n\n',
      'data: {"kind":"claiming","since":99}\n\n',
    ]);
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await collect(provider)).toEqual([
      { kind: "claiming", since: 10 },
      { kind: "waiting-for-capacity", since: 10, nodeClaim: "nc-1" },
      { kind: "ready" },
    ]);
    expect(new URL(ctl.seen[0]!.url).pathname).toBe(
      `/sandboxes/${handle}/events`,
    );
  });

  it("ends on a failed phase with its reason", async () => {
    const ctl = sse([
      'data: {"kind":"failed","reason":"image-pull-backoff","message":"no tag"}\n\n',
    ]);
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    expect(await collect(provider)).toEqual([
      { kind: "failed", reason: "image-pull-backoff", message: "no tag" },
    ]);
  });

  it("fails a stream that ends before a terminal phase", async () => {
    const ctl = sse(['data: {"kind":"pulling-image","since":1}\n\n']);
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });
    const phases = await collect(provider);
    expect(phases.map((p) => p.kind)).toEqual(["pulling-image", "failed"]);
  });

  it("fails on an error answer instead of hanging", async () => {
    const ctl = serve(() =>
      Response.json(
        { error: "runtime gone", code: "runtime-unreachable" },
        { status: 503 },
      ),
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
    const ctl = serve(() => Response.json(statusBody(d.url, "t")));
    const provider = new RemoteSandboxProvider({ baseUrl: ctl.url });

    const ok = await provider.proxyPreviewRequest(
      handle,
      new Request("https://preview.example.test/app?x=1"),
    );
    expect(await ok.text()).toBe("served /app");
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
    const ctl = serve(() =>
      Response.json({ error: "none", code: "unknown-handle" }, { status: 404 }),
    );
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

        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          tls: {
            cert: pem("controller.crt"),
            key: pem("controller.key"),
            ca: pem("ca.crt"),
            requestCert: true,
            rejectUnauthorized: true,
          },
          fetch: () => Response.json({ schedulable: false }),
        });
        servers.push(server);
        const baseUrl = `https://127.0.0.1:${server.port}`;

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
