import { describe, expect, it, mock } from "bun:test";
import { ORGANIZATION_BLOCKS_EDITOR_SET } from "./blocks-editor-set";

function makeCtx(organization: { id: string } | undefined) {
  const upsert = mock(
    async (
      organizationId: string,
      data: { flags?: Record<string, boolean> },
    ) => ({
      organizationId,
      flags: { auto_merge: true, ...data.flags },
    }),
  );
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization,
    access: { check: mock(async () => {}) },
    storage: { organizationSettings: { upsert } },
  } as unknown as Parameters<typeof ORGANIZATION_BLOCKS_EDITOR_SET.handler>[1];
  return { ctx, upsert };
}

describe("ORGANIZATION_BLOCKS_EDITOR_SET", () => {
  it("writes only the blocks-editor flag on the context's organization", async () => {
    const { ctx, upsert } = makeCtx({ id: "org-a" });

    const result = await ORGANIZATION_BLOCKS_EDITOR_SET.handler(
      { enabled: true },
      ctx,
    );

    expect(result).toEqual({ enabled: true });
    expect(upsert.mock.calls[0]).toEqual([
      "org-a",
      { flags: { new_blocks_editor: true } },
    ]);
  });

  it("persists an explicit false", async () => {
    const { ctx, upsert } = makeCtx({ id: "org-a" });

    const result = await ORGANIZATION_BLOCKS_EDITOR_SET.handler(
      { enabled: false },
      ctx,
    );

    expect(result).toEqual({ enabled: false });
    expect(upsert.mock.calls[0]?.[1]).toEqual({
      flags: { new_blocks_editor: false },
    });
  });

  it("fails closed without an organization", async () => {
    const { ctx, upsert } = makeCtx(undefined);

    await expect(
      ORGANIZATION_BLOCKS_EDITOR_SET.handler({ enabled: true }, ctx),
    ).rejects.toThrow(/organization scope/i);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("only accepts a boolean", () => {
    for (const enabled of [undefined, "true", 1, null]) {
      expect(
        ORGANIZATION_BLOCKS_EDITOR_SET.inputSchema.safeParse({ enabled })
          .success,
      ).toBe(false);
    }
  });
});
