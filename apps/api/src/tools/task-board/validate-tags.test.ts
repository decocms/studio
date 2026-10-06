/**
 * Coverage for tag validation edge cases: duplicates, empty strings, and
 * comprehensive error reporting. This validates the trust boundary where
 * caller-supplied tagIds must be checked against the org's tags.
 */
import { describe, expect, it } from "bun:test";
import type { StudioContext } from "@/core/studio-context";
import { assertValidTagIds } from "./validate-tags";

const mockContext = (orgTags: Array<{ id: string }>) =>
  ({
    storage: {
      tags: {
        listOrgTags: async () => orgTags,
      },
    },
  }) as unknown as StudioContext;

describe("assertValidTagIds", () => {
  const ORG_ID = "org_1";
  const validTags = [{ id: "tag1" }, { id: "tag2" }, { id: "tag3" }];

  it("accepts valid tag IDs", async () => {
    const ctx = mockContext(validTags);
    await assertValidTagIds(ctx, ORG_ID, ["tag1", "tag2"]);
  });

  it("accepts empty array", async () => {
    const ctx = mockContext(validTags);
    await assertValidTagIds(ctx, ORG_ID, []);
  });

  it("rejects invalid tag ID", async () => {
    const ctx = mockContext(validTags);
    try {
      await assertValidTagIds(ctx, ORG_ID, ["tag1", "invalid"]);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("invalid");
      expect(String(e)).toContain(ORG_ID);
    }
  });

  it("rejects duplicate tag IDs", async () => {
    const ctx = mockContext(validTags);
    try {
      await assertValidTagIds(ctx, ORG_ID, ["tag1", "tag2", "tag1"]);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("Duplicate");
      expect(String(e)).toContain("tag1");
    }
  });

  it("rejects empty strings in tag array", async () => {
    const ctx = mockContext(validTags);
    try {
      await assertValidTagIds(ctx, ORG_ID, ["tag1", "", "tag2"]);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("empty");
      expect(String(e)).toContain("position");
    }
  });

  it("reports multiple empty strings at their positions", async () => {
    const ctx = mockContext(validTags);
    try {
      await assertValidTagIds(ctx, ORG_ID, ["", "tag1", "", "tag2"]);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("0");
      expect(String(e)).toContain("2");
    }
  });

  it("reports all invalid tags at once", async () => {
    const ctx = mockContext(validTags);
    try {
      await assertValidTagIds(ctx, ORG_ID, ["tag1", "invalid1", "invalid2"]);
      expect.unreachable();
    } catch (e) {
      expect(String(e)).toContain("invalid1");
      expect(String(e)).toContain("invalid2");
      expect(String(e)).not.toContain("tag1");
    }
  });
});
