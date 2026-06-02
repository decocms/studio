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
      "u",
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
          "u",
          "h",
          { proxyDaemonRequest: proxy } as never,
        )) {
          /* */
        }
      })(),
    ).rejects.toThrow(/boom/);
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
      "u",
      "h",
      { proxyDaemonRequest: proxy } as never,
    ))
      out.push(c);
    expect(out).toEqual([{ t: "héllo😀" }]);
  });
});
