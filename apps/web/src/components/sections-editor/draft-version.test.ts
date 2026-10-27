import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { serializeBlock } from "@decocms/blocks/protocol";
import { draftVersionOf } from "./draft-version";

/** The API's `gitBlobSha(serializeBlock(block))` (read-decofile.ts). */
function serverVersion(block: unknown): string {
  const bytes = Buffer.from(serializeBlock(block), "utf-8");
  return createHash("sha1")
    .update(`blob ${bytes.length}\0`)
    .update(bytes)
    .digest("hex");
}

describe("draftVersionOf (a hosted draft block's version, from the block)", () => {
  it("is the version the server gives the same block", async () => {
    for (const block of [
      { title: "Spring Letter F: Bruno's T.", __resolveType: "newsletter" },
      { title: "Olá, café ☕", nested: { list: [1, "two", null] } },
      {},
    ]) {
      expect(await draftVersionOf(block)).toBe(serverVersion(block));
    }
  });

  it("is git's blob id of the block's stored text", async () => {
    // `printf '{}\n' | git hash-object --stdin`
    expect(await draftVersionOf({})).toBe(
      "0967ef424bce6791893e9a57bb952f80fd536e93",
    );
  });

  it("changes with any value of the block", async () => {
    expect(await draftVersionOf({ title: "a" })).not.toBe(
      await draftVersionOf({ title: "b" }),
    );
  });
});
