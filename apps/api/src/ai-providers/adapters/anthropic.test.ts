import { afterEach, describe, expect, test } from "bun:test";
import { anthropicAdapter } from "./anthropic";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("anthropicAdapter.listModels", () => {
  test("follows has_more instead of truncating to the first page", async () => {
    const requestedAfterIds: (string | null)[] = [];
    globalThis.fetch = (async (url: unknown): Promise<Response> => {
      const afterId = new URL(String(url)).searchParams.get("after_id");
      requestedAfterIds.push(afterId);
      if (!afterId) {
        return new Response(
          JSON.stringify({
            data: [{ id: "claude-a", display_name: "Claude A" }],
            has_more: true,
            first_id: "claude-a",
            last_id: "claude-a",
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          data: [{ id: "claude-b", display_name: "Claude B" }],
          has_more: false,
          first_id: "claude-b",
          last_id: "claude-b",
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const provider = anthropicAdapter.create("secret-api-key");
    const models = await provider.listModels();

    expect(requestedAfterIds).toEqual([null, "claude-a"]);
    expect(models.map((m) => m.modelId)).toEqual(["claude-a", "claude-b"]);
  });
});
