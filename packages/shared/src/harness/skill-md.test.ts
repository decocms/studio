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

  // Hiding a skill from the model on a typo is the failure nobody would go
  // looking for — the skill just quietly stops being offered. So only an
  // explicit `true` hides it, and everything else stays discoverable.
  describe("disable-model-invocation", () => {
    const parse = (fm: string) =>
      parseSkillMd(`---\nname: x\n${fm}\n---\nBody.\n`).disableModelInvocation;

    it("is set only by an explicit true", () => {
      expect(parse("disable-model-invocation: true")).toBe(true);
    });

    it("stays off for anything else", () => {
      expect(parse("disable-model-invocation: false")).toBe(false);
      expect(parse("disable-model-invocation: yes")).toBe(false);
      expect(parse("disable-model-invocation: TRUE")).toBe(false);
      expect(parse("disable_model_invocation: true")).toBe(false);
      expect(parse("name: x")).toBe(false);
    });

    it("is off for a file with no frontmatter at all", () => {
      expect(parseSkillMd("# Plain\n\nBody.\n").disableModelInvocation).toBe(
        false,
      );
    });
  });

  it("reads title, category and inline bundles", () => {
    const meta = parseSkillMd(
      "---\nname: deco-edge-caching\ntitle: Edge caching\ndescription: Cache at the edge.\ncategory: performance\nbundles: [caching, storefront-performance]\n---\n\nBody\n",
    );
    expect(meta.title).toBe("Edge caching");
    expect(meta.category).toBe("performance");
    expect(meta.bundles).toEqual(["caching", "storefront-performance"]);
  });

  it("drops an unknown category and accepts a bare bundle list", () => {
    const meta = parseSkillMd(
      '---\nname: x\ncategory: Performance\nbundles: pr-qa, "go-live"\n---\n',
    );
    expect(meta.category).toBeNull();
    expect(meta.bundles).toEqual(["pr-qa", "go-live"]);
  });

  it("defaults the new fields when frontmatter is absent", () => {
    const meta = parseSkillMd(PLAIN_STYLE);
    expect(meta.title).toBeNull();
    expect(meta.category).toBeNull();
    expect(meta.bundles).toEqual([]);
  });

  it("strips the quotes around a quoted value", () => {
    const meta = parseSkillMd(
      "---\nname: x\ntitle: 'Edge: caching'\ndescription: \"Use when: caching\"\n---\n",
    );
    expect(meta.title).toBe("Edge: caching");
    expect(meta.description).toBe("Use when: caching");
  });
});
