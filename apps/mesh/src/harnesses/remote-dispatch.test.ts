import { describe, expect, it } from "bun:test";
import { remoteDispatch } from "./remote-dispatch";

function resFromSse(events: string[]): Response {
  const body = events.map((e) => `data: ${e}\n\n`).join("");
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("remoteDispatch over proxyDaemonRequest", () => {
  it("yields ui-message-chunks from the SSE Response", async () => {
    const proxy = async () =>
      resFromSse([
        JSON.stringify({ type: "ui-message-chunk", chunk: { t: 1 } }),
        JSON.stringify({ type: "done" }),
      ]);
    const out: unknown[] = [];
    for await (const c of remoteDispatch(
      "claude-code",
      { runId: "r", messages: [] } as never,
      "h",
      { proxyDaemonRequest: proxy } as never,
    ))
      out.push(c);
    expect(out).toEqual([{ t: 1 }]);
  });

  it("throws on a non-2xx Response BEFORE SSE parsing (no silent empty stream)", async () => {
    const proxy = async () =>
      new Response(JSON.stringify({ error: "boom" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    await expect(
      (async () => {
        for await (const _ of remoteDispatch(
          "codex",
          { runId: "r" } as never,
          "h",
          { proxyDaemonRequest: proxy } as never,
        )) {
          /* */
        }
      })(),
    ).rejects.toThrow(/boom/);
  });

  it("offloads messages and emits a messagesRef envelope when oversized", async () => {
    const captured: { body?: string } = {};
    const proxy = async (_h: string, _p: string, init: { body?: string }) => {
      captured.body = init.body;
      return resFromSse([JSON.stringify({ type: "done" })]);
    };
    const big = "x".repeat(900 * 1024);
    const offload = {
      supported: true,
      put: async () => ({ url: "https://s/r", bytes: 1, sha256: "ab" }),
      cleanup: async () => {},
    };
    for await (const _ of remoteDispatch(
      "claude-code",
      { runId: "r", messages: [{ role: "user", content: big }] } as never,
      "h",
      { proxyDaemonRequest: proxy, offload } as never,
    )) {
      /* */
    }
    const env = JSON.parse(captured.body!);
    expect(env.messagesRef).toEqual({
      url: "https://s/r",
      bytes: 1,
      sha256: "ab",
    });
    expect(env.input.messages).toEqual([]); // offloaded out of band
  });

  it("throws when oversized but the daemon lacks body-offload support", async () => {
    const proxy = async () => resFromSse([]);
    const big = "x".repeat(900 * 1024);
    const offload = {
      supported: false,
      put: async () => {
        throw new Error("nope");
      },
      cleanup: async () => {},
    };
    await expect(
      (async () => {
        for await (const _ of remoteDispatch(
          "claude-code",
          { runId: "r", messages: [{ role: "user", content: big }] } as never,
          "h",
          { proxyDaemonRequest: proxy, offload } as never,
        )) {
          /* */
        }
      })(),
    ).rejects.toThrow(/too old|too large|cannot/i);
  });

  it("does NOT offload a small body (sends inline)", async () => {
    const captured: { body?: string } = {};
    const proxy = async (_h: string, _p: string, init: { body?: string }) => {
      captured.body = init.body;
      return resFromSse([JSON.stringify({ type: "done" })]);
    };
    const offload = {
      supported: true,
      put: async () => {
        throw new Error("should not be called");
      },
      cleanup: async () => {},
    };
    for await (const _ of remoteDispatch(
      "claude-code",
      { runId: "r", messages: [{ role: "user", content: "hi" }] } as never,
      "h",
      { proxyDaemonRequest: proxy, offload } as never,
    )) {
      /* */
    }
    const env = JSON.parse(captured.body!);
    expect(env.messagesRef).toBeUndefined();
    expect(env.input.messages).toEqual([{ role: "user", content: "hi" }]);
  });

  it("calls offload cleanup after a clean completion", async () => {
    let cleanupKey: string | null = null;
    const proxy = async () => resFromSse([JSON.stringify({ type: "done" })]);
    const big = "x".repeat(900 * 1024);
    const offload = {
      supported: true,
      put: async () => ({ url: "https://s/r", bytes: 1, sha256: "ab" }),
      cleanup: async (key: string) => {
        cleanupKey = key;
      },
    };
    for await (const _ of remoteDispatch(
      "claude-code",
      { runId: "r", messages: [{ role: "user", content: big }] } as never,
      "h",
      { proxyDaemonRequest: proxy, offload } as never,
    )) {
      /* */
    }
    // give the void cleanup().catch() microtask a tick to run
    await new Promise((r) => setTimeout(r, 0));
    expect(cleanupKey).not.toBeNull();
    expect(cleanupKey).toMatch(/^link-dispatch\//);
  });

  it("reassembles a multi-byte UTF-8 SSE event split across two Response chunks", async () => {
    const enc = new TextEncoder();
    const full = `data: ${JSON.stringify({ type: "ui-message-chunk", chunk: { t: "héllo😀" } })}\n\n`;
    const bytes = enc.encode(full);
    const cut = 12; // mid multi-byte
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(bytes.slice(0, cut));
        c.enqueue(bytes.slice(cut));
        c.close();
      },
    });
    const proxy = async () =>
      new Response(stream, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      });
    const out: unknown[] = [];
    for await (const c of remoteDispatch(
      "claude-code",
      { runId: "r" } as never,
      "h",
      { proxyDaemonRequest: proxy } as never,
    ))
      out.push(c);
    expect(out).toEqual([{ t: "héllo😀" }]);
  });
});
