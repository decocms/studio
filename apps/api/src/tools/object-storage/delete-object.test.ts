import { describe, expect, it, mock } from "bun:test";
import { DELETE_OBJECT } from "./delete-object";
import { DELETE_OBJECTS } from "./delete-objects";

/** `indexed` lists the Library paths that have an index row. */
function makeCtx(indexed: string[] = []) {
  const del = mock(async (_key: string) => {});
  const fsDelete = mock(async (_volume: string, _path: string) => {});
  const ctx = {
    auth: { user: { id: "user-1" } },
    organization: { id: "org-a", slug: "acme" },
    access: { check: mock(async () => {}) },
    objectStorage: { delete: del },
    orgFs: {
      stat: mock(async (volume: string, path: string) =>
        indexed.includes(`${volume}/${path}`) ? { volume, path } : null,
      ),
      delete: fsDelete,
    },
    storage: { orgRepoSyncs: { isSyncVolume: mock(async () => false) } },
  } as unknown as Parameters<typeof DELETE_OBJECT.handler>[1];
  return { ctx, del, fsDelete };
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

  it("deletes a Library file through the org filesystem, index row included", async () => {
    const { ctx, del, fsDelete } = makeCtx(["home/pages/a.html"]);
    expect(
      await DELETE_OBJECT.handler({ key: "_fs/home/pages/a.html" }, ctx),
    ).toEqual({ success: true, key: "_fs/home/pages/a.html" });
    expect(fsDelete).toHaveBeenCalledWith("home", "pages/a.html", {
      actor: "user-1",
    });
    expect(del).not.toHaveBeenCalled();
  });

  it("removes bytes a raw write left without an index row", async () => {
    const { ctx, del, fsDelete } = makeCtx();
    await DELETE_OBJECT.handler({ key: "_fs/home/pages/orphan.html" }, ctx);
    expect(fsDelete).not.toHaveBeenCalled();
    expect(del).toHaveBeenCalledWith("_fs/home/pages/orphan.html");
  });

  it("refuses another member's personal folder", async () => {
    const { ctx, del, fsDelete } = makeCtx(["home/users/user-2/notes.md"]);
    await expect(
      DELETE_OBJECT.handler({ key: "_fs/home/users/user-2/notes.md" }, ctx),
    ).rejects.toThrow("another member");
    expect(fsDelete).not.toHaveBeenCalled();
    expect(del).not.toHaveBeenCalled();
  });
});

describe("DELETE_OBJECTS", () => {
  it("sends Library keys through the org filesystem and reports refusals per key", async () => {
    const { ctx, del, fsDelete } = makeCtx(["home/b.html"]);
    const result = await DELETE_OBJECTS.handler(
      { keys: ["pages/a.html", "_fs/home/b.html", "_fs/public-core/c.md"] },
      ctx,
    );
    expect(result.deleted.sort()).toEqual(["_fs/home/b.html", "pages/a.html"]);
    expect(result.errors).toEqual([
      { key: "_fs/public-core/c.md", message: "Public volumes are read-only" },
    ]);
    expect(del).toHaveBeenCalledWith("pages/a.html");
    expect(fsDelete).toHaveBeenCalledWith("home", "b.html", {
      actor: "user-1",
    });
  });
});
