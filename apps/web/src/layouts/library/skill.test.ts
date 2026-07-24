import { describe, expect, it } from "bun:test";
import { parseSkillMd } from "./skill";

const STOREFRONT_STYLE = `---
name: asset-hash-busting
description: Use when Icon or SVG sprite components fetch sprites.svg repeatedly.
---

# SVG Sprites — prevent repeated fetch loop

## Problem

Calling asset() inside the component body recomputes the URL.
`;

const PLAIN_STYLE = `# xlsx — Excel spreadsheets

Use this skill to read or summarize \`.xlsx\` files.

## Scripts
`;

describe("parseSkillMd", () => {
  it("parses frontmatter name + description", () => {
    const meta = parseSkillMd(STOREFRONT_STYLE);
    expect(meta.name).toBe("asset-hash-busting");
    expect(meta.description).toBe(
      "Use when Icon or SVG sprite components fetch sprites.svg repeatedly.",
    );
    expect(meta.body.startsWith("\n# SVG Sprites")).toBe(true);
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

  it("handles empty/heading-only bodies", () => {
    expect(parseSkillMd("# Only a title\n").description).toBeNull();
    expect(parseSkillMd("").description).toBeNull();
  });
});
