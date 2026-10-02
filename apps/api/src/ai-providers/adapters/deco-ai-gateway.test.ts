import { expect, it, mock } from "bun:test";
import { decoAiGatewayAdapter } from "./deco-ai-gateway";

it("the hosted Deco adapter exposes native decision models", () => {
  const provider = decoAiGatewayAdapter.create("sk-test-unused-no-network");
  expect(provider.info.id).toBe("deco");
  expect(provider.decisions?.model("typesafe/jev-1.13")).toMatchObject({
    modelId: "typesafe/jev-1.13",
    doEvaluate: expect.any(Function),
  });
});

it("getEntitlements retries a transient 500 before succeeding", async () => {
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = mock(() => {
    calls++;
    if (calls < 2) {
      return Promise.resolve(new Response("boom", { status: 500 }));
    }
    return Promise.resolve(
      new Response(
        JSON.stringify({
          plan: { id: "free", name: "Free" },
          features: {},
          usage: null,
          credits: null,
          tasks: { allowed: true, remaining: null, denyReason: null },
          period_start: null,
          period_end: null,
        }),
        { status: 200 },
      ),
    );
  }) as unknown as typeof fetch;

  try {
    const result = await decoAiGatewayAdapter.getEntitlements?.("jwt", "org-1");
    expect(calls).toBe(2);
    expect(result?.plan.id).toBe("free");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
