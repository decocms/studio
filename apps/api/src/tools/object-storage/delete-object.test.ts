import { describe, expect, it, mock } from "bun:test";
import { DELETE_OBJECT } from "./delete-object";
import { DELETE_OBJECTS } from "./delete-objects";

function makeCtx() {
  const del = mock(async (_key: string) => {});
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization: { id: "org-a" },
    access: { check: mock(async () => {}) },
    objectStorage: { delete: del },
  } as unknown as Parameters<typeof DELETE_OBJECT.handler>[1];
  return { ctx, del };
}

describe("DELETE_OBJECT", () => {
  it("deletes an ordinary key", async () => {
    const { ctx, del } = makeCtx();
    expect(await DELETE_OBJECT.handler({ key: "pages/a.html" }, ctx)).toEqual({
      success: true,
      key: "pages/a.html",
    });
    expect(del).toHaveBeenCalledWith("pages/a.html");
  });

  it("refuses org filesystem keys instead of orphaning their index rows", async () => {
    const { ctx, del } = makeCtx();
    await expect(
      DELETE_OBJECT.handler({ key: "_fs/home/pages/a.html" }, ctx),
    ).rejects.toThrow("org filesystem");
    expect(del).not.toHaveBeenCalled();
  });
});

describe("DELETE_OBJECTS", () => {
  it("refuses the whole batch when any key is in the org filesystem", async () => {
    const { ctx, del } = makeCtx();
    await expect(
      DELETE_OBJECTS.handler(
        { keys: ["pages/a.html", "_fs/home/b.html"] },
        ctx,
      ),
    ).rejects.toThrow("org filesystem");
    expect(del).not.toHaveBeenCalled();
  });
});
