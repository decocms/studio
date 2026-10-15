import { afterEach, expect, it } from "bun:test";
import { decoAiGatewayAdapter } from "./deco-ai-gateway";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

it("the hosted Deco adapter exposes native decision models", () => {
  const provider = decoAiGatewayAdapter.create("sk-test-unused-no-network");
  expect(provider.info.id).toBe("deco");
  expect(provider.decisions?.model("typesafe/jev-1.13")).toMatchObject({
    modelId: "typesafe/jev-1.13",
    doEvaluate: expect.any(Function),
  });
});

it("degrades a malformed 2xx credits-balance body instead of throwing a raw SyntaxError", async () => {
  globalThis.fetch = (async (): Promise<Response> => {
    return new Response("not json", { status: 200 });
  }) as unknown as typeof fetch;

  await expect(
    decoAiGatewayAdapter.getCreditsBalance?.("jwt", "org-id"),
  ).rejects.toThrow("Deco AI Gateway credits balance returned malformed JSON");
});
