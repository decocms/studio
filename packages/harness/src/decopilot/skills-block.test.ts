import { describe, expect, it } from "bun:test";
import { buildSkillsBlock, parseSkillFrontmatter } from "./skills-block";

describe("parseSkillFrontmatter", () => {
  it("parses name and description", () => {
    expect(
      parseSkillFrontmatter(
        "---\nname: pdf\ndescription: Read PDFs.\n---\n# pdf\n",
      ),
    ).toEqual({ name: "pdf", description: "Read PDFs." });
  });

  it("strips surrounding quotes", () => {
    expect(
      parseSkillFrontmatter("---\nname: \"x\"\ndescription: 'y, z'\n---\n"),
    ).toEqual({ name: "x", description: "y, z" });
  });

  it("returns {} with no frontmatter", () => {
    expect(parseSkillFrontmatter("# just a heading\n")).toEqual({});
  });

  it("returns {} on unterminated frontmatter", () => {
    expect(parseSkillFrontmatter("---\nname: x\n")).toEqual({});
  });
});

describe("buildSkillsBlock", () => {
  it("returns null when empty", () => {
    expect(buildSkillsBlock([])).toBeNull();
  });

  it("renders a CSV index with header and usage", () => {
    const out = buildSkillsBlock([
      {
        name: "core/pdf",
        description: "Read PDFs.",
        path: "org/public/core/pdf/SKILL.md",
      },
    ]);
    expect(out).toContain("<available-skills>\nname,description,path");
    expect(out).toContain("core/pdf,Read PDFs.,org/public/core/pdf/SKILL.md");
    expect(out).toContain("<skills-usage>");
  });

  it("quotes fields containing commas", () => {
    const out = buildSkillsBlock([
      { name: "core/x", description: "reads a, b, c", path: "p" },
    ]);
    expect(out).toContain('"reads a, b, c"');
  });
});
