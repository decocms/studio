import { describe, expect, it } from "bun:test";
import { signRequest } from "@/links/protocol";
import { makeControlPlaneHandler } from "./control-plane";
import { createDesktopSandboxProvider } from "./user-desktop-provider";

const SECRET = "test-link-secret";

function buildHandler() {
  let portCounter = 30000;
  const provider = createDesktopSandboxProvider({
    dataDir: "/tmp/link-cp-test",
    spawnDaemon: () => ({ port: 0, kill: () => {} }),
    postConfig: async () => {},
    waitForHealth: async () => {},
    openDaemonTunnel: async ({ subDomain }) => ({
      publicUrl: `https://${subDomain}`,
      closed: new Promise<void>(() => {}),
      close: () => {},
    }),
    pickPort: () => portCounter++,
  });
  const nonces = new Set<string>();
  const handler = makeControlPlaneHandler({
    provider,
    linkSecret: SECRET,
    seenNonce: (n) => nonces.has(n),
    recordNonce: (n) => nonces.add(n),
  });
  return { handler, provider };
}

describe("control plane handler", () => {
  it("rejects unsigned requests with 401", async () => {
    const { handler } = buildHandler();
    const res = await handler(
      new Request("http://localhost:5174/api/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ handle: "abc" }),
      }),
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body).toMatchObject({ error: "unauthorized" });
  });

  it("accepts signed POST /api/sandboxes and returns sandboxApiUrl", async () => {
    const { handler } = buildHandler();
    const body = JSON.stringify({ handle: "abc" });
    const sig = signRequest({
      secret: SECRET,
      method: "POST",
      path: "/api/sandboxes",
      body,
    });
    const res = await handler(
      new Request("http://localhost:5174/api/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json", ...sig },
        body,
      }),
    );
    expect(res.status).toBe(200);
    const out = (await res.json()) as { sandboxApiUrl: string };
    expect(out.sandboxApiUrl).toBe("https://abc.deco.host");
  });

  it("rejects nonce replay", async () => {
    const { handler } = buildHandler();
    const body = JSON.stringify({ handle: "abc" });
    const sig = signRequest({
      secret: SECRET,
      method: "POST",
      path: "/api/sandboxes",
      body,
    });
    const make = () =>
      new Request("http://localhost:5174/api/sandboxes", {
        method: "POST",
        headers: { "content-type": "application/json", ...sig },
        body,
      });
    const first = await handler(make());
    expect(first.status).toBe(200);
    const second = await handler(make());
    expect(second.status).toBe(401);
    const reason = (await second.json()) as { reason: string };
    expect(reason.reason).toBe("nonce_replay");
  });

  it("returns 404 for unrecognised paths after auth passes", async () => {
    const { handler } = buildHandler();
    const sig = signRequest({
      secret: SECRET,
      method: "GET",
      path: "/something-else",
      body: "",
    });
    const res = await handler(
      new Request("http://localhost:5174/something-else", {
        method: "GET",
        headers: { ...sig },
      }),
    );
    expect(res.status).toBe(404);
  });
});
