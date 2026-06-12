import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import { createSideChannelWriter } from "../../../side-channel-writer";
import { createHtmlPageBufferFromStorage } from "./html-page-buffer-core";

async function collect(source: AsyncIterable<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

describe("createHtmlPageBufferFromStorage", () => {
  test("coalesces html writes and emits published chunks through the side channel", async () => {
    const puts: Array<{ key: string; body: Uint8Array; contentType?: string }> =
      [];
    const side = createSideChannelWriter();
    const buffer = createHtmlPageBufferFromStorage({
      storage: {
        put: async (key, body, options) => {
          puts.push({
            key,
            body:
              body instanceof Uint8Array
                ? body
                : new TextEncoder().encode(body),
            contentType: options?.contentType,
          });
        },
      },
      baseUrl: "https://studio.example.com",
      orgSlug: "acme",
      writer: side.writer,
    });

    expect(buffer.enqueue("pages/home.html", "<h1>first</h1>")).toMatchObject({
      slug: "home",
      key: "pages/home.html",
      bytes: 14,
    });
    expect(buffer.enqueue("./pages/home.html", "<h1>final</h1>")).toMatchObject(
      {
        slug: "home",
        key: "pages/home.html",
        bytes: 14,
      },
    );

    await buffer.flush();
    side.close();

    expect(puts).toHaveLength(1);
    expect(puts[0]).toMatchObject({
      key: "pages/home.html",
      contentType: "text/html; charset=utf-8",
    });
    expect(new TextDecoder().decode(puts[0]!.body)).toBe("<h1>final</h1>");
    await expect(collect(side.stream)).resolves.toEqual([
      {
        type: "data-html-page-published",
        id: "home",
        data: {
          slug: "home",
          key: "pages/home.html",
          url: "https://studio.example.com/api/acme/files/pages/home.html",
          bytes: 14,
        },
      },
    ]);
  });
});
