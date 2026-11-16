import { describe, expect, it } from "bun:test";
import { DRAFT_TOMBSTONE_VERSION } from "@decocms/shared/blocks-major";
import { heldCopyVersion } from "./held-copy";
import { draftVersionOf } from "./draft-version";

describe("a held copy's hosted write guard", () => {
  const body = { __resolveType: "cms-settings", telemetry: { enabled: true } };
  const copy = { value: body, inDraft: false };

  it("a main copy matching current production can create the draft entry", async () => {
    expect(await heldCopyVersion(copy, await draftVersionOf(body))).toBeNull();
  });

  it("a main copy cannot overwrite production that moved while its form stayed open", async () => {
    const production = { ...body, telemetry: { enabled: false } };
    const guard = await heldCopyVersion(copy, await draftVersionOf(production));
    expect(guard).toBe(await draftVersionOf(body));
    expect(guard).not.toBeNull();
  });

  it("a copy removed from production is reconciled rather than recreated unasked", async () => {
    expect(await heldCopyVersion(copy, null)).toBe(await draftVersionOf(body));
  });

  it("keeps existing behavior without a production index or before a block exists", async () => {
    expect(await heldCopyVersion(copy)).toBeNull();
    expect(
      await heldCopyVersion({ value: undefined, inDraft: false }, null),
    ).toBeNull();
  });

  it("draft bodies and tombstones remain guarded by their own copies", async () => {
    expect(
      await heldCopyVersion({ value: body, inDraft: true }, "production"),
    ).toBe(await draftVersionOf(body));
    expect(
      await heldCopyVersion({ value: undefined, inDraft: true }, "production"),
    ).toBe(DRAFT_TOMBSTONE_VERSION);
  });
});
