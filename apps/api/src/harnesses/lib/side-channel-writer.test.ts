import type { UIMessageChunk } from "ai";
import { describe, expect, test } from "bun:test";
import { createSideChannelWriter } from "./side-channel-writer";

async function collect(source: AsyncIterable<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = [];
  for await (const chunk of source) chunks.push(chunk);
  return chunks;
}

describe("createSideChannelWriter", () => {
  test("yields chunks written through writer.write", async () => {
    const side = createSideChannelWriter();
    side.writer.write({
      type: "data-tool-metadata",
      id: "tool-1",
      data: { latencyMs: 12 },
    } as UIMessageChunk);
    side.close();

    await expect(collect(side.stream)).resolves.toEqual([
      {
        type: "data-tool-metadata",
        id: "tool-1",
        data: { latencyMs: 12 },
      },
    ]);
  });

  test("merges async iterable chunks", async () => {
    const side = createSideChannelWriter();
    await side.writer.merge(
      (async function* () {
        yield {
          type: "data-deck-updated",
          id: "decks/home.html",
          data: { path: "decks/home.html" },
        } as UIMessageChunk;
      })() as never,
    );
    side.close();

    await expect(collect(side.stream)).resolves.toEqual([
      {
        type: "data-deck-updated",
        id: "decks/home.html",
        data: { path: "decks/home.html" },
      },
    ]);
  });

  test("ignores writes after close", async () => {
    const side = createSideChannelWriter();
    side.close();
    side.writer.write({
      type: "data-tool-metadata",
      id: "late",
      data: {},
    } as UIMessageChunk);

    await expect(collect(side.stream)).resolves.toEqual([]);
  });
});
