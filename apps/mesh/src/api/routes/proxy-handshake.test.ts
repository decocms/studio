import { describe, expect, it } from "bun:test";
import { peekRpcMethod, probeDecision } from "./proxy-handshake";

describe("probeDecision", () => {
  it("always probes initialize (response is local, probe is the only 401 surface)", () => {
    expect(probeDecision("initialize")).toEqual({ decision: "probe" });
  });

  it("always probes tools/call and content reads", () => {
    expect(probeDecision("tools/call")).toEqual({ decision: "probe" });
    expect(probeDecision("resources/read")).toEqual({ decision: "probe" });
    expect(probeDecision("prompts/get")).toEqual({ decision: "probe" });
  });

  it("always probes unknown methods (safe default) and resources/templates/list", () => {
    expect(probeDecision("completion/complete")).toEqual({ decision: "probe" });
    expect(probeDecision("some/future/method")).toEqual({ decision: "probe" });
    // templates list is not cache-served by the lazy client → probe
    expect(probeDecision("resources/templates/list")).toEqual({
      decision: "probe",
    });
  });

  it("defers list methods to the cold/warm cache check", () => {
    expect(probeDecision("tools/list")).toEqual({
      decision: "skip-if-list-cached",
      listType: "tools",
    });
    expect(probeDecision("resources/list")).toEqual({
      decision: "skip-if-list-cached",
      listType: "resources",
    });
    expect(probeDecision("prompts/list")).toEqual({
      decision: "skip-if-list-cached",
      listType: "prompts",
    });
  });

  it("skips ping and all notifications", () => {
    expect(probeDecision("ping")).toEqual({ decision: "skip" });
    expect(probeDecision("notifications/initialized")).toEqual({
      decision: "skip",
    });
    expect(probeDecision("notifications/cancelled")).toEqual({
      decision: "skip",
    });
  });

  it("skips when method is undefined (GET/DELETE/unparseable)", () => {
    expect(probeDecision(undefined)).toEqual({ decision: "skip" });
  });
});

function postJson(
  body: unknown,
  headers: Record<string, string> = {},
): Request {
  return new Request("https://mesh.test/mcp/conn_1", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("peekRpcMethod", () => {
  it("reads the method from a single JSON-RPC request", async () => {
    expect(
      await peekRpcMethod(
        postJson({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      ),
    ).toBe("initialize");
    expect(
      await peekRpcMethod(
        postJson({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
      ),
    ).toBe("tools/list");
  });

  it("reads the first member's method from a batch", async () => {
    expect(
      await peekRpcMethod(
        postJson([
          { jsonrpc: "2.0", method: "notifications/initialized" },
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
        ]),
      ),
    ).toBe("notifications/initialized");
  });

  it("does NOT consume the original request body (clone is read)", async () => {
    const req = postJson({ jsonrpc: "2.0", id: 1, method: "initialize" });
    await peekRpcMethod(req);
    // handleRequest reads the original body afterwards — it must still be intact.
    expect(req.bodyUsed).toBe(false);
    const reread = (await req.json()) as { method: string };
    expect(reread.method).toBe("initialize");
  });

  it("returns undefined for non-POST requests", async () => {
    const get = new Request("https://mesh.test/mcp/conn_1", { method: "GET" });
    expect(await peekRpcMethod(get)).toBeUndefined();
    const del = new Request("https://mesh.test/mcp/conn_1", {
      method: "DELETE",
    });
    expect(await peekRpcMethod(del)).toBeUndefined();
  });

  it("returns undefined for unparseable bodies", async () => {
    const req = new Request("https://mesh.test/mcp/conn_1", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "not json{",
    });
    expect(await peekRpcMethod(req)).toBeUndefined();
  });

  it("returns undefined when there is no method field", async () => {
    expect(
      await peekRpcMethod(postJson({ jsonrpc: "2.0", id: 1, result: {} })),
    ).toBeUndefined();
  });

  it("skips parsing oversized bodies (never an initialize/list)", async () => {
    const big = "x".repeat(70_000);
    const req = postJson(
      { jsonrpc: "2.0", id: 1, method: "tools/call", params: { big } },
      { "content-length": "70000" },
    );
    expect(await peekRpcMethod(req)).toBeUndefined();
    // Original body remains readable for handleRequest.
    expect(req.bodyUsed).toBe(false);
  });
});
