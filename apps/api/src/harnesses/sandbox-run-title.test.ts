import { describe, expect, test } from "bun:test";
import type { UIMessageChunk } from "ai";
import { DEFAULT_THREAD_TITLE } from "@/api/routes/decopilot/constants";
import { TITLE_RESULT_CHUNK_TYPE } from "@/harnesses/lib/title-chunk";
import { withRunTitle } from "./sandbox-run-title";

async function* harness(): AsyncIterable<UIMessageChunk> {
  yield { type: "start", messageId: "m1" } as UIMessageChunk;
  yield { type: "finish", finishReason: "stop" } as UIMessageChunk;
}

const collect = async (it: AsyncIterable<UIMessageChunk>) => {
  const out: UIMessageChunk[] = [];
  for await (const c of it) out.push(c);
  return out;
};

const titleChunks = (chunks: UIMessageChunk[]) =>
  chunks.filter(
    (c) => (c as { type: string }).type === TITLE_RESULT_CHUNK_TYPE,
  ) as unknown as { data: { title: string } }[];

const run = (overrides: Partial<Parameters<typeof withRunTitle>[1]> = {}) =>
  collect(
    withRunTitle(harness(), {
      currentThreadTitle: DEFAULT_THREAD_TITLE,
      isSubagent: false,
      userText: "Fix the login button on mobile",
      slots: [],
      signal: new AbortController().signal,
      ...overrides,
    }),
  );

describe("withRunTitle", () => {
  test("the first turn gets exactly one title, alongside every harness chunk", async () => {
    const chunks = await run();
    expect(titleChunks(chunks)).toEqual([
      expect.objectContaining({
        data: { title: "Fix the login button on mobile" },
      }),
    ]);
    expect(chunks.map((c) => (c as { type: string }).type)).toEqual(
      expect.arrayContaining(["start", "finish"]),
    );
  });

  test("a thread that already has a title is not retitled", async () => {
    const chunks = await run({ currentThreadTitle: "Pricing page copy" });
    expect(titleChunks(chunks)).toEqual([]);
    expect(chunks).toHaveLength(2);
  });

  test("a subagent run never titles its parent thread", async () => {
    expect(titleChunks(await run({ isSubagent: true }))).toEqual([]);
  });

  test("a model that cannot be built falls back to the user's words", async () => {
    const chunks = await run({
      slots: [
        {
          selection: { id: "m", credentialId: "c", title: "M" },
          source: { providerId: "nope", apiKey: "k", modelId: "m" },
        } as unknown as NonNullable<
          Parameters<typeof withRunTitle>[1]["slots"][number]
        >,
      ],
    });
    expect(titleChunks(chunks)[0]?.data.title).toBe(
      "Fix the login button on mobile",
    );
  });
});
