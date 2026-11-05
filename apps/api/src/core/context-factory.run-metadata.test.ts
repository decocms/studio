import { expect, it } from "bun:test";
import { runMetadataFromApiKey, threadIdFromApiKey } from "./context-factory";

it("reads only a non-empty string map from a run key's metadata", () => {
  const runMetadata = { org_id: "org_1", url: "shop.example" };
  expect(runMetadataFromApiKey({ runMetadata })).toEqual(runMetadata);
  for (const bad of [
    undefined,
    {},
    { runMetadata: {} },
    { runMetadata: ["a"] },
  ])
    expect(runMetadataFromApiKey(bad)).toBeUndefined();
  expect(runMetadataFromApiKey({ runMetadata: { n: 1 } })).toBeUndefined();
});

it("reads a key's bound thread only as a non-empty string", () => {
  expect(threadIdFromApiKey({ threadId: "thrd_1" })).toBe("thrd_1");
  for (const bad of [
    undefined,
    {},
    { threadId: "" },
    { threadId: 1 },
    { threadId: ["thrd_1"] },
    { runMetadata: { threadId: "thrd_1" } },
  ])
    expect(threadIdFromApiKey(bad)).toBeUndefined();
});
