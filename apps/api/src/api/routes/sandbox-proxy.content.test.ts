import { describe, expect, it } from "bun:test";
import { Hono, type Context } from "hono";
import { serveSandboxContent } from "./sandbox-proxy";

type Handler = typeof serveSandboxContent;
type VmContext = Parameters<Handler>[0];

/**
 * The content-protocol route behind a claim like `resolveVmClaim` sets, with a
 * runner that records which daemon routes were called.
 */
function app(runtime: "sandbox" | "cms") {
  const sent: string[] = [];
  const runner = {
    proxyDaemonRequest: async (_claimName: string, path: string) => {
      sent.push(path);
      if (path === "/_sandbox/bash") {
        return Response.json({
          stdout: "@meta schema.gen.json h\n",
          exitCode: 0,
        });
      }
      if (path === "/_sandbox/read") {
        return Response.json({
          kind: "text",
          content: '1\t{"blocksMajor":8,"manifest":{"blocks":{}},"schema":{}}',
        });
      }
      return Response.json({ error: `Not found: ${path}` }, { status: 404 });
    },
  };
  const hono = new Hono();
  hono.use("/:virtualMcpId/:branch/*", async (c, next) => {
    (c as unknown as Context).set("vmClaim", {
      claimName: `claim-${runtime}`,
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
  hono.all("/:virtualMcpId/:branch/rpc", (c) =>
    serveSandboxContent(c as unknown as VmContext),
  );
  return { hono, sent };
}

describe("sandbox content protocol route", () => {
  it("runs the protocol in Studio over the daemon's file routes", async () => {
    const { hono, sent } = app("sandbox");
    const res = await hono.request("/vm1/main/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: '{"jsonrpc":"2.0","id":1,"method":"schema.get"}',
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { schema: unknown } };
    expect(body.result.schema).toMatchObject({ blocksMajor: 8 });
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(sent).toEqual(["/_sandbox/bash", "/_sandbox/read"]);
    expect(sent).not.toContain("/_sandbox/rpc");
  });

  it("answers a non-POST itself (405), as the protocol requires", async () => {
    const { hono, sent } = app("sandbox");
    const res = await hono.request("/vm1/main/rpc", { method: "GET" });
    expect(res.status).toBe(405);
    expect(sent).toHaveLength(0);
  });

  it("answers 404 for a sandbox-less session, with no daemon call", async () => {
    const { hono, sent } = app("cms");
    const res = await hono.request("/vm1/main/rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(res.status).toBe(404);
    expect(sent).toHaveLength(0);
  });
});
