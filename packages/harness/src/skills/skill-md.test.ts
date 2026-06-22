import { describe, expect, it } from "bun:test";
import { parseSkillMd } from "./skill-md";

const FRONTMATTER_STYLE = `---
name: slides
description: Create and edit presentation decks as single self-contained HTML files.
---

# slides — presentation decks

Create and edit presentation decks.
`;

const PLAIN_STYLE = `# xlsx — Excel spreadsheets

Use this skill to read or summarize \`.xlsx\` files.

## Scripts
`;

describe("parseSkillMd", () => {
  it("parses frontmatter name + description and strips the fence", () => {
    const meta = parseSkillMd(FRONTMATTER_STYLE);
    expect(meta.name).toBe("slides");
    expect(meta.description).toBe(
      "Create and edit presentation decks as single self-contained HTML files.",
    );
    expect(meta.body.startsWith("\n# slides")).toBe(true);
    expect(meta.body).not.toContain("---");
  });

  it("falls back on plain markdown (no frontmatter)", () => {
    const meta = parseSkillMd(PLAIN_STYLE);
    expect(meta.name).toBeNull();
    expect(meta.description).toBe(
      "Use this skill to read or summarize `.xlsx` files.",
    );
    expect(meta.body).toBe(PLAIN_STYLE);
  });

  it("falls back to first paragraph when frontmatter lacks description", () => {
    const meta = parseSkillMd("---\nname: x\n---\n# Title\n\nFirst para.\n");
    expect(meta.name).toBe("x");
    expect(meta.description).toBe("First para.");
  });

  it("handles empty / heading-only bodies", () => {
    expect(parseSkillMd("# Only a title\n").description).toBeNull();
    expect(parseSkillMd("").description).toBeNull();
    expect(parseSkillMd("").name).toBeNull();
  });
});
