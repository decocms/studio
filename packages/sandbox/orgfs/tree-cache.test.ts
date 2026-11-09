import { describe, expect, it } from "bun:test";
import { OrgFsApiError, type OrgFsNode } from "./api";
import { type TreeSource, TreeCache } from "./tree-cache";

const parentOf = (p: string) =>
  p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "";

/** In-memory volume that counts the Studio calls the cache makes. */
function memVolume(paths: string[]) {
  const nodes = new Map<string, OrgFsNode>();
  const calls = { tree: 0, list: 0, stat: 0 };
  let tree: "ok" | "too-large" | "missing" = "ok";
  const add = (path: string, kind: "file" | "dir", size = 0) => {
    for (let d = parentOf(path); d !== ""; d = parentOf(d)) {
      if (!nodes.has(d))
        nodes.set(d, { path: d, kind: "dir", size: 0, updatedAt: "" });
    }
    nodes.set(path, { path, kind, size, updatedAt: "" });
  };
  const drop = (path: string) => {
    for (const p of [...nodes.keys()]) {
      if (p === path || p.startsWith(`${path}/`)) nodes.delete(p);
    }
  };
  for (const p of paths) {
    add(p.replace(/\/$/, ""), p.endsWith("/") ? "dir" : "file");
  }
  const api: TreeSource = {
    listTree: async () => {
      calls.tree++;
      if (tree === "missing") throw new OrgFsApiError(404, "Not Found");
      return tree === "too-large" ? null : [...nodes.values()];
    },
    listDir: async (dir) => {
      calls.list++;
      return [...nodes.values()].filter((n) => parentOf(n.path) === dir);
    },
    stat: async (p) => {
      calls.stat++;
      return nodes.get(p) ?? null;
    },
    read: async () => new Uint8Array(),
    write: async (p, b) => add(p, "file", b.length),
    mkdir: async (p) => add(p, "dir"),
    remove: async (p) => drop(p),
    move: async (from, to) => {
      for (const [p, n] of [...nodes]) {
        if (p === from || p.startsWith(`${from}/`)) {
          nodes.delete(p);
          add(to + p.slice(from.length), n.kind, n.size);
        }
      }
    },
  };
  return {
    api,
    calls,
    add,
    drop,
    setTree: (t: typeof tree) => {
      tree = t;
    },
  };
}

/** Every path reachable from the root through listDir, like `find`. */
async function walk(cache: TreeCache, dir = ""): Promise<string[]> {
  const out: string[] = [];
  for (const n of await cache.listDir(dir)) {
    expect((await cache.stat(n.path))?.kind).toBe(n.kind);
    out.push(n.path);
    if (n.kind === "dir") out.push(...(await walk(cache, n.path)));
  }
  return out.sort();
}

const TREE = ["a/b/c.md", "a/d.md", "e/f/g/h.md", "e/i/", "j.md"];

describe("TreeCache", () => {
  it("walks the whole volume with one Studio request", async () => {
    const v = memVolume(TREE);
    const cache = new TreeCache(v.api);
    expect(await walk(cache)).toEqual([
      "a",
      "a/b",
      "a/b/c.md",
      "a/d.md",
      "e",
      "e/f",
      "e/f/g",
      "e/f/g/h.md",
      "e/i",
      "j.md",
    ]);
    expect(v.calls).toEqual({ tree: 1, list: 0, stat: 0 });
  });

  it("lists a directory again only after the feed invalidates it", async () => {
    const v = memVolume(TREE);
    const cache = new TreeCache(v.api);
    await walk(cache);
    v.add("a/new.md", "file");
    expect(await cache.stat("a/new.md")).toBeNull();
    cache.invalidate("a");
    expect((await cache.stat("a/new.md"))?.kind).toBe("file");
    await walk(cache);
    expect(v.calls).toEqual({ tree: 1, list: 1, stat: 0 });
  });

  it("shows its own writes, including directories a write creates", async () => {
    const v = memVolume(TREE);
    const cache = new TreeCache(v.api);
    await walk(cache);
    await cache.write("x/y/z.md", new Uint8Array(3));
    expect((await cache.stat("x/y/z.md"))?.size).toBe(3);
    expect((await walk(cache)).filter((p) => p.startsWith("x"))).toEqual([
      "x",
      "x/y",
      "x/y/z.md",
    ]);
  });

  it("forgets everything under a removed or moved directory", async () => {
    const v = memVolume(TREE);
    const cache = new TreeCache(v.api);
    await walk(cache);
    await cache.move("e/f", "k");
    await cache.remove("a");
    expect(await cache.stat("a/b/c.md")).toBeNull();
    expect(await cache.stat("e/f/g/h.md")).toBeNull();
    expect((await cache.stat("k/g/h.md"))?.kind).toBe("file");
    expect(await walk(cache)).toEqual([
      "e",
      "e/i",
      "j.md",
      "k",
      "k/g",
      "k/g/h.md",
    ]);
  });

  it("drops a directory deleted elsewhere and refills one recreated in its place", async () => {
    const v = memVolume(TREE);
    const cache = new TreeCache(v.api);
    await walk(cache);
    v.drop("e/f");
    v.add("e/f/other.md", "file");
    cache.invalidate("e");
    cache.invalidate("e/f");
    expect(await cache.stat("e/f/g/h.md")).toBeNull();
    expect(await walk(cache)).toContain("e/f/other.md");
  });

  it("keeps a listing stale when the feed invalidates it mid-fetch", async () => {
    const v = memVolume(TREE);
    const cache = new TreeCache(v.api);
    await walk(cache);
    cache.invalidate("a");
    const listDir = v.api.listDir;
    v.api.listDir = async (dir) => {
      const result = await listDir(dir);
      v.add("a/late.md", "file");
      cache.invalidate("a");
      return result;
    };
    expect(await cache.stat("a/late.md")).toBeNull();
    v.api.listDir = listDir;
    expect((await cache.stat("a/late.md"))?.kind).toBe("file");
  });

  it("reloads the whole tree once it is older than maxAge", async () => {
    const v = memVolume(TREE);
    let now = 0;
    const cache = new TreeCache(v.api, { maxAgeMs: 1000, now: () => now });
    await walk(cache);
    v.add("missed.md", "file");
    now = 999;
    expect(await cache.stat("missed.md")).toBeNull();
    now = 1000;
    expect((await cache.stat("missed.md"))?.kind).toBe("file");
    expect(v.calls.tree).toBe(2);
  });

  for (const mode of ["too-large", "missing"] as const) {
    it(`passes through to Studio when the tree is ${mode}`, async () => {
      const v = memVolume(TREE);
      v.setTree(mode);
      const cache = new TreeCache(v.api, { log: () => {} });
      expect((await walk(cache)).length).toBe(10);
      expect(v.calls.tree).toBe(1);
      expect(v.calls.list).toBe(7);
      expect(v.calls.stat).toBe(10);
    });
  }
});
