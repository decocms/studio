import { expect, it } from "bun:test";
import { decoAiGatewayAdapter } from "./deco-ai-gateway";

it("the hosted Deco adapter exposes native decision models", () => {
  const provider = decoAiGatewayAdapter.create("sk-test-unused-no-network");
  expect(provider.info.id).toBe("deco");
  expect(provider.decisions?.model("typesafe/jev-1.13")).toMatchObject({
    modelId: "typesafe/jev-1.13",
    doEvaluate: expect.any(Function),
  });
});
