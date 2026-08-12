import { describe, expect, it } from "bun:test";
import {
  admit,
  type CacheIndex,
  type CacheIndexConfig,
  createIndex,
  isValidSha,
  remove,
  sanitizeSegment,
  touch,
} from "./cache-index";

function makeConfig(
  overrides: Partial<CacheIndexConfig> = {},
): CacheIndexConfig {
  return {
    maxTotalBytes: 100,
    maxMergedBytes: 50,
    maxEntryBytes: { blobs: 30, merged: 40 },
    ...overrides,
  };
}

function lruOrder(index: CacheIndex): string[] {
  return [...index.entries.keys()];
}

/** Recompute counters from entries and assert the incremental ones agree. */
function expectConsistent(index: CacheIndex): void {
  let total = 0;
  const areaBytes = { blobs: 0, merged: 0 };
  for (const entry of index.entries.values()) {
    total += entry.bytes;
    areaBytes[entry.area] += entry.bytes;
  }
  expect(index.totalBytes).toBe(total);
  expect(index.areaBytes).toEqual(areaBytes);
}

describe("createIndex", () => {
  it("builds an empty index", () => {
    const index = createIndex([], makeConfig());
    expect(index.entries.size).toBe(0);
    expect(index.totalBytes).toBe(0);
    expect(index.areaBytes).toEqual({ blobs: 0, merged: 0 });
  });

  it("seeds LRU order from mtimes, oldest first", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/b", bytes: 1, mtimeMs: 200 },
        { path: "blobs/o/r/a", bytes: 1, mtimeMs: 100 },
        { path: "merged/o/r/c.json", bytes: 1, mtimeMs: 300 },
      ],
      makeConfig(),
    );
    expect(lruOrder(index)).toEqual([
      "blobs/o/r/a",
      "blobs/o/r/b",
      "merged/o/r/c.json",
    ]);
  });

  it("derives area from the path prefix and counts bytes per area", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 },
        { path: "merged/o/r/b.json", bytes: 20, mtimeMs: 2 },
        { path: "unknown/prefix", bytes: 5, mtimeMs: 3 },
      ],
      makeConfig(),
    );
    expect(index.areaBytes).toEqual({ blobs: 15, merged: 20 });
    expect(index.totalBytes).toBe(35);
    expect(index.entries.get("unknown/prefix")?.area).toBe("blobs");
    expectConsistent(index);
  });

  it("dedupes seed paths keeping the newest-mtime occurrence, counted once", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/x", bytes: 5, mtimeMs: 1 },
        { path: "blobs/o/r/y", bytes: 3, mtimeMs: 4 },
        { path: "blobs/o/r/x", bytes: 7, mtimeMs: 9 },
      ],
      makeConfig(),
    );
    expect(index.entries.size).toBe(2);
    expect(index.entries.get("blobs/o/r/x")?.bytes).toBe(7);
    expect(index.totalBytes).toBe(10);
    // mtime 9 places the deduped entry after y (mtime 4)
    expect(lruOrder(index)).toEqual(["blobs/o/r/y", "blobs/o/r/x"]);
    expectConsistent(index);
  });

  it("tolerates a seed over budget (next admit evicts down)", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 20, mtimeMs: 1 },
        { path: "blobs/o/r/b", bytes: 20, mtimeMs: 2 },
      ],
      makeConfig({ maxTotalBytes: 30 }),
    );
    expect(index.totalBytes).toBe(40);
    const result = admit(index, {
      path: "blobs/o/r/c",
      bytes: 10,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: true, evict: ["blobs/o/r/a"] });
    expect(index.totalBytes).toBe(30);
    expectConsistent(index);
  });
});

describe("touch", () => {
  it("moves the entry to the MRU end", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 1, mtimeMs: 1 },
        { path: "blobs/o/r/b", bytes: 1, mtimeMs: 2 },
        { path: "blobs/o/r/c", bytes: 1, mtimeMs: 3 },
      ],
      makeConfig(),
    );
    touch(index, "blobs/o/r/a");
    expect(lruOrder(index)).toEqual([
      "blobs/o/r/b",
      "blobs/o/r/c",
      "blobs/o/r/a",
    ]);
    expectConsistent(index);
  });

  it("protects a touched entry from the next eviction", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 },
        { path: "blobs/o/r/b", bytes: 10, mtimeMs: 2 },
        { path: "blobs/o/r/c", bytes: 10, mtimeMs: 3 },
      ],
      makeConfig({ maxTotalBytes: 30 }),
    );
    touch(index, "blobs/o/r/a");
    const result = admit(index, {
      path: "blobs/o/r/d",
      bytes: 10,
      area: "blobs",
    });
    expect(result.evict).toEqual(["blobs/o/r/b"]);
  });

  it("is a no-op for unknown paths", () => {
    const index = createIndex(
      [{ path: "blobs/o/r/a", bytes: 1, mtimeMs: 1 }],
      makeConfig(),
    );
    touch(index, "blobs/o/r/nope");
    expect(lruOrder(index)).toEqual(["blobs/o/r/a"]);
    expect(index.totalBytes).toBe(1);
  });
});

describe("remove", () => {
  it("drops the entry and updates counters", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 },
        { path: "merged/o/r/b.json", bytes: 20, mtimeMs: 2 },
      ],
      makeConfig(),
    );
    remove(index, "merged/o/r/b.json");
    expect(index.entries.has("merged/o/r/b.json")).toBe(false);
    expect(index.totalBytes).toBe(10);
    expect(index.areaBytes).toEqual({ blobs: 10, merged: 0 });
    expectConsistent(index);
  });

  it("is a no-op for unknown paths", () => {
    const index = createIndex(
      [{ path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 }],
      makeConfig(),
    );
    remove(index, "blobs/o/r/nope");
    expect(index.entries.size).toBe(1);
    expect(index.totalBytes).toBe(10);
    expectConsistent(index);
  });
});

describe("admit — refusals", () => {
  it("refuses a blob over the blobs admission cap, leaving the index untouched", () => {
    const index = createIndex(
      [{ path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 }],
      makeConfig({ maxEntryBytes: { blobs: 30, merged: 40 } }),
    );
    const result = admit(index, {
      path: "blobs/o/r/big",
      bytes: 31,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: false, evict: [] });
    expect(index.entries.has("blobs/o/r/big")).toBe(false);
    expect(index.totalBytes).toBe(10);
    expectConsistent(index);
  });

  it("refuses a merged doc over the merged admission cap", () => {
    const index = createIndex([], makeConfig());
    const result = admit(index, {
      path: "merged/o/r/x.json",
      bytes: 41,
      area: "merged",
    });
    expect(result).toEqual({ admitted: false, evict: [] });
    expect(index.entries.size).toBe(0);
  });

  it("refuses an entry over the total budget even when under its entry cap", () => {
    const index = createIndex(
      [],
      makeConfig({
        maxTotalBytes: 100,
        maxEntryBytes: { blobs: 200, merged: 40 },
      }),
    );
    const result = admit(index, {
      path: "blobs/o/r/x",
      bytes: 150,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: false, evict: [] });
  });

  it("refuses a merged doc over the merged sub-budget even when under its entry cap", () => {
    const index = createIndex(
      [],
      makeConfig({
        maxTotalBytes: 1000,
        maxMergedBytes: 50,
        maxEntryBytes: { blobs: 30, merged: 200 },
      }),
    );
    const result = admit(index, {
      path: "merged/o/r/x.json",
      bytes: 60,
      area: "merged",
    });
    expect(result).toEqual({ admitted: false, evict: [] });
  });

  it("refuses negative and non-finite sizes", () => {
    const index = createIndex([], makeConfig());
    for (const bytes of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(
        admit(index, { path: "blobs/o/r/x", bytes, area: "blobs" }),
      ).toEqual({
        admitted: false,
        evict: [],
      });
    }
    expect(index.entries.size).toBe(0);
  });
});

describe("admit — no eviction needed", () => {
  it("admits into an empty index with an empty plan", () => {
    const index = createIndex([], makeConfig());
    const result = admit(index, {
      path: "blobs/o/r/a",
      bytes: 10,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: true, evict: [] });
    expect(index.totalBytes).toBe(10);
    expect(index.areaBytes.blobs).toBe(10);
    expectConsistent(index);
  });

  it("admits alongside existing entries when the budget allows, at the MRU end", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 },
        { path: "blobs/o/r/b", bytes: 10, mtimeMs: 2 },
      ],
      makeConfig(),
    );
    const result = admit(index, {
      path: "blobs/o/r/c",
      bytes: 10,
      area: "blobs",
    });
    expect(result.evict).toEqual([]);
    expect(lruOrder(index)).toEqual([
      "blobs/o/r/a",
      "blobs/o/r/b",
      "blobs/o/r/c",
    ]);
  });

  it("admits a zero-byte entry", () => {
    const index = createIndex([], makeConfig());
    const result = admit(index, {
      path: "blobs/o/r/z",
      bytes: 0,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: true, evict: [] });
    expect(index.totalBytes).toBe(0);
  });
});

describe("admit — evict-then-write plans", () => {
  function seedBlobs(config: CacheIndexConfig): CacheIndex {
    return createIndex(
      [
        { path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 },
        { path: "blobs/o/r/b", bytes: 10, mtimeMs: 2 },
        { path: "blobs/o/r/c", bytes: 10, mtimeMs: 3 },
      ],
      config,
    );
  }

  it("evicts exactly one oldest entry when that frees enough", () => {
    const index = seedBlobs(makeConfig({ maxTotalBytes: 30 }));
    const result = admit(index, {
      path: "blobs/o/r/d",
      bytes: 10,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: true, evict: ["blobs/o/r/a"] });
    expect(index.totalBytes).toBe(30);
    expect(lruOrder(index)).toEqual([
      "blobs/o/r/b",
      "blobs/o/r/c",
      "blobs/o/r/d",
    ]);
    expectConsistent(index);
  });

  it("evicts exactly two oldest entries when one is not enough — never a third", () => {
    const index = seedBlobs(makeConfig({ maxTotalBytes: 30 }));
    const result = admit(index, {
      path: "blobs/o/r/e",
      bytes: 15,
      area: "blobs",
    });
    expect(result).toEqual({
      admitted: true,
      evict: ["blobs/o/r/a", "blobs/o/r/b"],
    });
    expect(index.entries.has("blobs/o/r/c")).toBe(true);
    expect(index.totalBytes).toBe(25);
    expectConsistent(index);
  });

  it("spans both areas, oldest first, for the total budget", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 },
        { path: "merged/o/r/m.json", bytes: 10, mtimeMs: 2 },
        { path: "blobs/o/r/b", bytes: 10, mtimeMs: 3 },
      ],
      makeConfig({ maxTotalBytes: 30, maxMergedBytes: 30 }),
    );
    const result = admit(index, {
      path: "blobs/o/r/c",
      bytes: 15,
      area: "blobs",
    });
    expect(result.evict).toEqual(["blobs/o/r/a", "merged/o/r/m.json"]);
    expect(index.totalBytes).toBe(25);
    expect(index.areaBytes).toEqual({ blobs: 25, merged: 0 });
    expectConsistent(index);
  });

  it("merged sub-budget evicts only merged entries, even when blobs are older", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/old", bytes: 30, mtimeMs: 1 },
        { path: "merged/o/r/m1.json", bytes: 30, mtimeMs: 2 },
        { path: "merged/o/r/m2.json", bytes: 20, mtimeMs: 3 },
      ],
      makeConfig({
        maxTotalBytes: 1000,
        maxMergedBytes: 50,
        maxEntryBytes: { blobs: 40, merged: 40 },
      }),
    );
    const result = admit(index, {
      path: "merged/o/r/m3.json",
      bytes: 20,
      area: "merged",
    });
    expect(result.evict).toEqual(["merged/o/r/m1.json"]);
    expect(index.entries.has("blobs/o/r/old")).toBe(true);
    expect(index.areaBytes.merged).toBe(40);
    expectConsistent(index);
  });

  it("runs the total pass after the merged pass without double-evicting", () => {
    // merged pass frees m1 (30); total still over, so the oldest blob goes too.
    const index = createIndex(
      [
        { path: "merged/o/r/m1.json", bytes: 30, mtimeMs: 1 },
        { path: "blobs/o/r/b1", bytes: 20, mtimeMs: 2 },
      ],
      makeConfig({
        maxTotalBytes: 45,
        maxMergedBytes: 40,
        maxEntryBytes: { blobs: 30, merged: 40 },
      }),
    );
    const result = admit(index, {
      path: "merged/o/r/m2.json",
      bytes: 30,
      area: "merged",
    });
    expect(result.evict).toEqual(["merged/o/r/m1.json", "blobs/o/r/b1"]);
    expect(index.totalBytes).toBe(30);
    expect(index.areaBytes).toEqual({ blobs: 0, merged: 30 });
    expectConsistent(index);
  });

  it("stops when the merged pass alone satisfies the total budget", () => {
    const index = createIndex(
      [
        { path: "merged/o/r/m1.json", bytes: 30, mtimeMs: 1 },
        { path: "blobs/o/r/b1", bytes: 20, mtimeMs: 2 },
      ],
      makeConfig({
        maxTotalBytes: 50,
        maxMergedBytes: 40,
        maxEntryBytes: { blobs: 30, merged: 40 },
      }),
    );
    const result = admit(index, {
      path: "merged/o/r/m2.json",
      bytes: 30,
      area: "merged",
    });
    expect(result.evict).toEqual(["merged/o/r/m1.json"]);
    expect(index.entries.has("blobs/o/r/b1")).toBe(true);
    expectConsistent(index);
  });
});

describe("admit — re-admitting an existing path", () => {
  it("replaces the bytes, moves to MRU, and never evicts itself", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 10, mtimeMs: 1 },
        { path: "blobs/o/r/b", bytes: 10, mtimeMs: 2 },
      ],
      makeConfig(),
    );
    const result = admit(index, {
      path: "blobs/o/r/a",
      bytes: 20,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: true, evict: [] });
    expect(index.entries.get("blobs/o/r/a")?.bytes).toBe(20);
    expect(index.totalBytes).toBe(30);
    expect(lruOrder(index)).toEqual(["blobs/o/r/b", "blobs/o/r/a"]);
    expectConsistent(index);
  });

  it("counts only the size delta against the budget when replacing", () => {
    const index = createIndex(
      [
        { path: "blobs/o/r/a", bytes: 20, mtimeMs: 1 },
        { path: "blobs/o/r/b", bytes: 10, mtimeMs: 2 },
      ],
      makeConfig({ maxTotalBytes: 30 }),
    );
    const result = admit(index, {
      path: "blobs/o/r/a",
      bytes: 25,
      area: "blobs",
    });
    expect(result).toEqual({ admitted: true, evict: ["blobs/o/r/b"] });
    expect(result.evict).not.toContain("blobs/o/r/a");
    expect(index.totalBytes).toBe(25);
    expectConsistent(index);
  });

  it("updates merged counters when re-admitting a merged doc", () => {
    const index = createIndex(
      [{ path: "merged/o/r/m.json", bytes: 30, mtimeMs: 1 }],
      makeConfig(),
    );
    const result = admit(index, {
      path: "merged/o/r/m.json",
      bytes: 40,
      area: "merged",
    });
    expect(result).toEqual({ admitted: true, evict: [] });
    expect(index.areaBytes.merged).toBe(40);
    expectConsistent(index);
  });
});

describe("sanitizeSegment", () => {
  it("lowercases and keeps [a-z0-9._-]", () => {
    expect(sanitizeSegment("Foo")).toBe("foo");
    expect(sanitizeSegment("a-b_c.d9")).toBe("a-b_c.d9");
  });

  it("neutralizes traversal attempts", () => {
    expect(sanitizeSegment("../x")).toBe("..%2fx");
    expect(sanitizeSegment("a/b")).toBe("a%2fb");
    expect(sanitizeSegment("..")).toBe("%2e%2e");
    expect(sanitizeSegment(".")).toBe("%2e");
    expect(sanitizeSegment("a\\b")).toBe("a%5cb");
  });

  it("percent-encodes unicode as UTF-8 bytes, after lowercasing", () => {
    expect(sanitizeSegment("café")).toBe("caf%c3%a9");
    expect(sanitizeSegment("ÉClair")).toBe("%c3%a9clair");
  });

  it("encodes the escape character itself", () => {
    expect(sanitizeSegment("50%off")).toBe("50%25off");
  });

  it("throws on the empty segment", () => {
    expect(() => sanitizeSegment("")).toThrow(TypeError);
  });

  it("never emits a separator or a dot-only segment for hostile inputs", () => {
    const hostile = [
      "..",
      ".",
      "../..",
      "/",
      "//",
      "..\\..",
      "%2e%2e",
      "a/../b",
      " ",
      "…",
    ];
    for (const input of hostile) {
      const out = sanitizeSegment(input);
      expect(out).not.toContain("/");
      expect(out).not.toContain("\\");
      expect(out).not.toBe(".");
      expect(out).not.toBe("..");
      expect(out.length).toBeGreaterThan(0);
    }
  });
});

describe("isValidSha", () => {
  const valid = "a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0";

  it("accepts a 40-char lowercase hex sha", () => {
    expect(valid.length).toBe(40);
    expect(isValidSha(valid)).toBe(true);
    expect(isValidSha("0".repeat(40))).toBe(true);
  });

  it("rejects uppercase and mixed case", () => {
    expect(isValidSha(valid.toUpperCase())).toBe(false);
    expect(isValidSha(`A${valid.slice(1)}`)).toBe(false);
  });

  it("rejects wrong lengths", () => {
    expect(isValidSha(valid.slice(0, 39))).toBe(false);
    expect(isValidSha(`${valid}0`)).toBe(false);
    expect(isValidSha("")).toBe(false);
  });

  it("rejects non-hex characters and surrounding noise", () => {
    expect(isValidSha(`g${valid.slice(1)}`)).toBe(false);
    expect(isValidSha(`${valid}\n`)).toBe(false);
    expect(isValidSha(` ${valid.slice(1)}`)).toBe(false);
  });
});
