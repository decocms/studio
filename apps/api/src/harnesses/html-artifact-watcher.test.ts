import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import type { StudioContext } from "@/core/studio-context";
import { withHtmlArtifactPreviews } from "./html-artifact-watcher";

function fakeCtx(feed: Array<Array<Record<string, unknown>>>): StudioContext {
  return {
    orgFs: {
      latestSeq: async () => "0",
      changes: async () => ({
        entries: feed.shift() ?? [],
        cursor: "1",
        hasMore: false,
      }),
    },
    organization: { slug: "acme" },
    auth: { user: { id: "user_1" } },
    metadata: { threadId: "thrd_1" },
  } as unknown as StudioContext;
}

const deck = {
  kind: "file",
  deletedAt: null,
  updatedBy: "user_1",
  threadId: null,
  path: "decks/launch.html",
  contentHash: "h1",
};

async function collect(
  chunks: UIMessageChunk[],
  ctx: StudioContext,
): Promise<string[]> {
  async function* source() {
    yield* chunks;
  }
  const out: string[] = [];
  for await (const chunk of withHtmlArtifactPreviews(source(), ctx)) {
    out.push(chunk.type);
  }
  return out;
}

describe("withHtmlArtifactPreviews", () => {
  test("a deck written during a step is previewed after that step", async () => {
    const types = await collect(
      [
        { type: "start" },
        { type: "start-step" },
        { type: "finish-step" },
        { type: "start-step" },
        { type: "finish-step" },
        { type: "finish" },
      ],
      fakeCtx([[deck]]),
    );
    expect(types).toEqual([
      "start",
      "start-step",
      "finish-step",
      "data-deck-updated",
      "start-step",
      "finish-step",
      "finish",
    ]);
  });

  test("a deck that lands after the last step is previewed before finish", async () => {
    const types = await collect(
      [
        { type: "start" },
        { type: "start-step" },
        { type: "finish-step" },
        { type: "finish" },
      ],
      fakeCtx([[], [deck]]),
    );
    expect(types).toEqual([
      "start",
      "start-step",
      "finish-step",
      "data-deck-updated",
      "finish",
    ]);
  });
});
