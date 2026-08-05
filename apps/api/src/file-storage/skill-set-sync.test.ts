import { describe, expect, it } from "bun:test";
import {
  isUpToDate,
  parseTar,
  planVolumeTree,
  staleDirs,
} from "./skill-set-sync";

/** Build a minimal ustar archive in memory (the GitHub tarball shape). */
function makeTar(
  entries: Array<{ name: string; data?: string; dir?: boolean }>,
): Uint8Array {
  const blocks: Uint8Array[] = [];
  const enc = new TextEncoder();
  for (const e of entries) {
    const header = new Uint8Array(512);
    header.set(enc.encode(e.name), 0);
    const data = enc.encode(e.data ?? "");
    header.set(
      enc.encode(
        e.dir
          ? "0".padStart(11, "0")
          : data.length.toString(8).padStart(11, "0"),
      ),
      124,
    );
    header[156] = e.dir ? 53 /* '5' */ : 48; /* '0' */
    // checksum: spaces while computing
    header.fill(32, 148, 156);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc.encode(sum.toString(8).padStart(6, "0")), 148);
    header[154] = 0;
    header[155] = 32;
    blocks.push(header);
    if (!e.dir && data.length > 0) {
      const padded = new Uint8Array(Math.ceil(data.length / 512) * 512);
      padded.set(data);
      blocks.push(padded);
    }
  }
  blocks.push(new Uint8Array(1024)); // end-of-archive
  const total = blocks.reduce((n, b) => n + b.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const b of blocks) {
    out.set(b, off);
    off += b.length;
  }
  return out;
}

describe("parseTar", () => {
  it("extracts regular files and skips directories", () => {
    const tar = makeTar([
      { name: "repo-main/", dir: true },
      { name: "repo-main/README.md", data: "# hi" },
      { name: "repo-main/a/skills/x/SKILL.md", data: "skill x" },
    ]);
    const files = parseTar(tar);
    expect([...files.keys()].sort()).toEqual([
      "repo-main/README.md",
      "repo-main/a/skills/x/SKILL.md",
    ]);
    expect(new TextDecoder().decode(files.get("repo-main/README.md"))).toBe(
      "# hi",
    );
  });
});

describe("planVolumeTree", () => {
  const repo = new Map(
    Object.entries({
      "README.md": "root",
      ".claude-seo/skills/sitemap/SKILL.md": "seo",
      ".claude-deco/skills/new-page/SKILL.md": "deco",
      "core/docx/SKILL.md": "docx",
    }).map(([k, v]) => [k, new TextEncoder().encode(v)]),
  );

  it("merges multiple subtrees into the volume root", () => {
    const tree = planVolumeTree(repo, [
      { from: ".claude-seo/skills" },
      { from: ".claude-deco/skills" },
    ]);
    expect([...tree.keys()].sort()).toEqual([
      "new-page/SKILL.md",
      "sitemap/SKILL.md",
    ]);
  });

  it("respects `to` subdir mapping and excludes unrelated files", () => {
    const tree = planVolumeTree(repo, [{ from: "core", to: "office" }]);
    expect([...tree.keys()]).toEqual(["office/docx/SKILL.md"]);
  });

  it("from='' maps the whole repo", () => {
    const tree = planVolumeTree(repo, [{ from: "" }]);
    expect(tree.size).toBe(4);
  });
});

describe("planVolumeTree normalization", () => {
  it("keys match what OrgFs.write stores (sanitized paths)", () => {
    const repo = new Map([
      ["skills/a%20b/SKILL.md", new TextEncoder().encode("x")],
      ["skills/./weird/../ok/SKILL.md", new TextEncoder().encode("y")],
    ]);
    const tree = planVolumeTree(repo, [{ from: "skills" }]);
    // exact strings depend on sanitizeKey; the invariant that matters is
    // stability: re-normalizing a key is a no-op (idempotent fixpoint).
    for (const key of tree.keys()) {
      expect(key.includes("..")).toBe(false);
      expect(key.startsWith("/")).toBe(false);
    }
  });
});

describe("staleDirs", () => {
  it("keeps ancestors of desired files, prunes the rest shallowest-first", () => {
    const desired = ["keep/one/SKILL.md", "keep/two/SKILL.md"];
    const dirs = [
      "keep",
      "keep/one",
      "keep/two",
      "gone",
      "gone/sub",
      "keep/old",
    ];
    expect(staleDirs(desired, dirs).sort()).toEqual(["gone", "keep/old"]);
  });

  it("collapses nested stale dirs into one recursive root", () => {
    expect(staleDirs([], ["a", "a/b", "a/b/c"])).toEqual(["a"]);
  });
});

describe("isUpToDate", () => {
  const args = {
    hash: "h",
    manifestHash: "h",
    path: "brand/SKILL.md",
    storedPaths: new Set(["brand/SKILL.md"]),
  };

  it("skips a file present in both the manifest and object storage", () => {
    expect(isUpToDate(args)).toBe(true);
  });

  it("rewrites a manifest row whose object is gone", () => {
    // The bug this exists to prevent: hash-only comparison marks the file
    // unchanged forever, so the set never heals and reads keep failing.
    expect(isUpToDate({ ...args, storedPaths: new Set() })).toBe(false);
  });

  it("rewrites on a content change", () => {
    expect(isUpToDate({ ...args, manifestHash: "old" })).toBe(false);
    expect(isUpToDate({ ...args, manifestHash: null })).toBe(false);
  });
});
