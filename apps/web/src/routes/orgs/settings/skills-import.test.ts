import { describe, expect, test } from "bun:test";
import {
  groupByDestination,
  importable,
  optimisticEntry,
  relativePath,
  slugify,
  uploadAllGroups,
} from "./skills-import.ts";

/** A picked file, standing in for what a directory `<input>` hands back. */
function picked(webkitRelativePath: string): File {
  const name = webkitRelativePath.split("/").pop() ?? "";
  const file = new File(["x"], name);
  Object.defineProperty(file, "webkitRelativePath", {
    value: webkitRelativePath,
  });
  return file;
}

describe("relativePath", () => {
  test("strips the picked folder root", () => {
    expect(relativePath(picked("my-skill/SKILL.md"))).toBe("SKILL.md");
    expect(relativePath(picked("my-skill/references/style.md"))).toBe(
      "references/style.md",
    );
  });

  test("falls back to the bare name on a non-directory pick", () => {
    // What a plain file input reports: a bare name, no folder root to strip.
    expect(relativePath(picked("SKILL.md"))).toBe("SKILL.md");
  });
});

describe("importable", () => {
  test("keeps the skill's own files at any depth", () => {
    expect(importable(picked("s/SKILL.md"))).toBe(true);
    expect(importable(picked("s/references/deep/style.md"))).toBe(true);
  });

  test("drops dotfiles, dot-dirs and tooling dirs", () => {
    expect(importable(picked("s/.DS_Store"))).toBe(false);
    expect(importable(picked("s/.git/config"))).toBe(false);
    expect(importable(picked("s/node_modules/left-pad/index.js"))).toBe(false);
    expect(importable(picked("s/scripts/__pycache__/a.pyc"))).toBe(false);
  });
});

describe("slugify", () => {
  test("normalizes a folder name", () => {
    expect(slugify("  My Cool Skill! ")).toBe("my-cool-skill");
  });

  test("never yields an empty slug", () => {
    expect(slugify("!!!")).toBe("skill");
    expect(slugify("")).toBe("skill");
  });
});

describe("groupByDestination", () => {
  test("keeps subdirectories instead of flattening onto the root", () => {
    const groups = groupByDestination(
      [
        picked("my-skill/SKILL.md"),
        picked("my-skill/references/style.md"),
        picked("my-skill/references/tone.md"),
      ],
      "my-skill",
    );
    expect([...groups.keys()].toSorted()).toEqual([
      "skills/my-skill",
      "skills/my-skill/references",
    ]);
    expect(
      groups
        .get("skills/my-skill/references")
        ?.map((f) => f.name)
        .toSorted(),
    ).toEqual(["style.md", "tone.md"]);
  });
});

describe("uploadAllGroups", () => {
  const groups = new Map([
    ["skills/s", [new File([], "SKILL.md")]],
    ["skills/s/a", [new File([], "a.md")]],
    ["skills/s/b", [new File([], "b.md")]],
  ]);

  test("uploads every group", async () => {
    const seen: string[] = [];
    await uploadAllGroups(groups, async ({ dir }) => void seen.push(dir));
    expect(seen.toSorted()).toEqual(["skills/s", "skills/s/a", "skills/s/b"]);
  });

  test("waits for the other groups before rejecting", async () => {
    const landed: string[] = [];
    const put = async ({ dir }: { dir: string }) => {
      if (dir === "skills/s") throw new Error("quota");
      await new Promise((r) => setTimeout(r, 5));
      landed.push(dir);
    };
    await expect(uploadAllGroups(groups, put)).rejects.toThrow("quota");
    // Not the `Promise.all` behaviour: the slow PUTs are done, not in flight.
    expect(landed.toSorted()).toEqual(["skills/s/a", "skills/s/b"]);
  });
});

describe("optimisticEntry", () => {
  test("matches the catalog row the server builds for a home skill", () => {
    expect(
      optimisticEntry(
        "seo-audit",
        "---\nname: SEO Audit\ndescription: Audits a page.\n---\n\nbody",
      ),
    ).toEqual({
      id: "home/skills/seo-audit",
      name: "SEO Audit",
      description: "Audits a page.",
      source: "home",
      volume: "home",
      path: "skills/seo-audit",
      sandboxPath: "org/home/skills/seo-audit",
    });
  });

  test("falls back to the slug when SKILL.md has no frontmatter name", () => {
    const entry = optimisticEntry("my-skill", "# Heading\n\nWhat it does.");
    expect(entry.name).toBe("my-skill");
    expect(entry.description).toBe("What it does.");
  });
});
