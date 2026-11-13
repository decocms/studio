import { expect, it } from "bun:test";
import { runMetadataFromApiKey, threadIdFromApiKey } from "./context-factory";
import { mintSignedGrant } from "./signed-grant";

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

it("reads a key's bound thread only from a grant Studio signed for its org", () => {
  const grant = (over: Record<string, unknown> = {}) =>
    mintSignedGrant({
      threadId: "thrd_1",
      organizationId: "org_1",
      expiresAt: 2_000,
      ...over,
    });
  expect(threadIdFromApiKey({ threadGrant: grant() }, "org_1", 1_000)).toBe(
    "thrd_1",
  );
  const forged = `${grant().split(".")[0]}.${"A".repeat(43)}`;
  for (const [metadata, org] of [
    [undefined, "org_1"],
    [{ threadId: "thrd_1" }, "org_1"],
    [{ threadGrant: forged }, "org_1"],
    [{ threadGrant: grant() }, "org_2"],
    [{ threadGrant: grant({ expiresAt: 1_000 }) }, "org_1"],
    [{ threadGrant: grant({ threadId: "" }) }, "org_1"],
  ] as const)
    expect(
      threadIdFromApiKey(metadata as Record<string, unknown>, org, 1_000),
    ).toBeUndefined();
});
