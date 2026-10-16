import { describe, expect, it } from "bun:test";
import type { StudioContext } from "../../core/studio-context";
import { COLLECTION_THREADS_LIST } from "./list";

describe("COLLECTION_THREADS_LIST auth resolution", () => {
  it("lists threads for an API-key caller with no user session", async () => {
    let listedCreatedBy: string | undefined;
    const ctx = {
      access: { check: async () => {} },
      auth: { apiKey: { userId: "user_api" } },
      organization: { id: "org_test" },
      storage: {
        threads: {
          list: async (createdBy: string | undefined) => {
            listedCreatedBy = createdBy;
            return { threads: [], total: 0 };
          },
        },
      },
    } as unknown as StudioContext;

    const result = await COLLECTION_THREADS_LIST.handler(
      { where: { created_by: "me" } },
      ctx,
    );

    expect(result.items).toEqual([]);
    expect(listedCreatedBy).toBe("user_api");
  });
});

describe("COLLECTION_THREADS_LIST input schema", () => {
  it("accepts a reasonably sized trigger_ids filter", () => {
    const result = COLLECTION_THREADS_LIST.inputSchema.safeParse({
      where: { trigger_ids: ["a", "b"] },
    });
    expect(result.success).toBe(true);
  });

  it("rejects an oversized trigger_ids filter", () => {
    const trigger_ids = Array.from({ length: 1001 }, (_, i) => `t${i}`);
    const result = COLLECTION_THREADS_LIST.inputSchema.safeParse({
      where: { trigger_ids },
    });
    expect(result.success).toBe(false);
  });
});
