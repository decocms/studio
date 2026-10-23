import { expect, it } from "bun:test";
import { runMetadataFromApiKey } from "./context-factory";

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
