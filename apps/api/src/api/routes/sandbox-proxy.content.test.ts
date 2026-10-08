import { describe, expect, it } from "bun:test";
import { Hono, type Context } from "hono";
import { proxyContentAsset, proxyContentRpc } from "./sandbox-proxy";

type Handler = typeof proxyContentRpc;
type VmContext = Parameters<Handler>[0];

interface Sent {
  claimName: string;
  path: string;
  method: string;
  contentType: string | null;
  body: Uint8Array;
}

/**
 * The two content-protocol routes behind a claim like `resolveVmClaim` sets,
 * with a runner that records what reached it.
 */
function app(runtime: "sandbox" | "cms", answer: Response) {
  const sent: Sent[] = [];
  const runner = {
    proxyDaemonRequest: async (
      claimName: string,
      path: string,
      init: { method: string; headers: Headers; body: BodyInit | null },
    ) => {
      sent.push({
        claimName,
        path,
        method: init.method,
        contentType: init.headers.get("content-type"),
        body: new Uint8Array(await new Response(init.body).arrayBuffer()),
      });
      return answer;
    },
    adoptLiveClaim: async () => false,
  };
  const hono = new Hono();
  hono.use("/:virtualMcpId/:branch/*", async (c, next) => {
    (c as unknown as Context).set("vmClaim", {
      claimName: "claim-a",
      callerUserId: "u1",
      runner: runtime === "cms" ? null : runner,
      virtualMcpId: c.req.param("virtualMcpId"),
      branch: c.req.param("branch"),
      userId: "u1",
      projectRef: "p1",
      virtualMcpMetadata: null,
      connectionIds: [],
      runtime,
    });
    await next();
  });
  const route = (h: Handler) => (c: Context) => h(c as unknown as VmContext);
  hono.post("/:virtualMcpId/:branch/rpc", route(proxyContentRpc));
  hono.put("/:virtualMcpId/:branch/assets/:name", route(proxyContentAsset));
  return { hono, sent };
}

const rpcAnswer = () =>
  new Response('{"jsonrpc":"2.0","id":1,"result":{}}', {
    headers: { "content-type": "application/json; charset=utf-8" },
  });

describe("content protocol proxy", () => {
  it("forwards an rpc request's JSON body to the daemon's /_sandbox/rpc", async () => {
    const { hono, sent } = app("sandbox", rpcAnswer());
    const body = '{"jsonrpc":"2.0","id":1,"method":"describe"}';
    const res = await hono.request("/vm1/main/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(sent).toHaveLength(1);
    expect(sent[0]!.path).toBe("/_sandbox/rpc");
    expect(sent[0]!.method).toBe("POST");
    expect(sent[0]!.contentType).toBe("application/json");
    expect(new TextDecoder().decode(sent[0]!.body)).toBe(body);
  });

  it("passes the daemon's protocol errors through unchanged", async () => {
    const { hono } = app(
      "sandbox",
      new Response(
        '{"jsonrpc":"2.0","id":null,"error":{"code":-32600,"message":"use POST"}}',
        { status: 405, headers: { "content-type": "application/json" } },
      ),
    );
    const res = await hono.request("/vm1/main/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(405);
    expect(((await res.json()) as { error: { code: number } }).error.code).toBe(
      -32600,
    );
  });

  it("forwards an asset's bytes and type to /_sandbox/assets/<name>", async () => {
    const { hono, sent } = app(
      "sandbox",
      new Response('{"path":"/assets/logo%20a.png"}', {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const bytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff]);
    const res = await hono.request(
      `/vm1/main/assets/${encodeURIComponent("logo a.png")}`,
      {
        method: "PUT",
        headers: { "content-type": "image/png" },
        body: bytes,
      },
    );
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ path: "/assets/logo%20a.png" });
    expect(sent[0]!.path).toBe("/_sandbox/assets/logo%20a.png");
    expect(sent[0]!.method).toBe("PUT");
    expect(sent[0]!.contentType).toBe("image/png");
    expect([...sent[0]!.body]).toEqual([...bytes]);
  });

  it("answers 404 for a sandbox-less session, with no daemon call", async () => {
    const { hono, sent } = app("cms", rpcAnswer());
    const res = await hono.request("/vm1/main/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});
