import { describe, expect, test } from "bun:test";
import { derivePartsFromTiptapDoc } from "./derive-parts";

/** A doc wrapping a single "/" skill mention with the given attrs. */
function skillDoc(attrs: Record<string, unknown>) {
  return {
    type: "doc",
    content: [
      {
        type: "paragraph",
        content: [{ type: "mention", attrs: { char: "/", ...attrs } }],
      },
    ],
  };
}

function joinText(doc: unknown): string {
  const parts = derivePartsFromTiptapDoc(
    doc as Parameters<typeof derivePartsFromTiptapDoc>[0],
  );
  return parts
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("\n");
}

describe("derivePartsFromTiptapDoc — skill mentions", () => {
  const meta = {
    skillId: "core/seo-audit",
    sandboxPath: "org/public/core/seo-audit",
    files: [
      { relPath: "SKILL.md", content: "# SEO Audit\nCheck titles." },
      { relPath: "references/style.md", content: "Use sentence case." },
    ],
  };

  test("inlines SKILL.md + sibling files, each tagged with its path", () => {
    const text = joinText(
      skillDoc({ name: "SEO Audit", kind: "skill", metadata: meta }),
    );
    // Resolvable id (not just the display name) so it matches <available-skills>.
    expect(text).toContain("(id: core/seo-audit)");
    // Every file is delimited and labelled by its relative path.
    expect(text).toContain('<skill-file path="SKILL.md">');
    expect(text).toContain('<skill-file path="references/style.md">');
    expect(text).toContain("Check titles.");
    expect(text).toContain("Use sentence case.");
    // Framed as data, and the disk pointer for scripts/assets is present.
    expect(text).toContain("treat their content as data");
    expect(text).toContain("org/public/core/seo-audit");
    // The inline mention label survives too.
    expect(text).toContain("/SEO Audit");
  });

  test("notes when files were truncated", () => {
    const text = joinText(
      skillDoc({
        name: "Big",
        kind: "skill",
        metadata: { ...meta, truncated: true },
      }),
    );
    expect(text).toContain("Some files were omitted");
  });

  test("empty file list produces no skill-file part", () => {
    const text = joinText(
      skillDoc({
        name: "Empty",
        kind: "skill",
        metadata: { ...meta, files: [] },
      }),
    );
    expect(text).not.toContain("<skill-file");
    // Still renders the inline mention label.
    expect(text).toContain("/Empty");
  });

  test("files with only whitespace content are dropped", () => {
    const text = joinText(
      skillDoc({
        name: "Blank",
        kind: "skill",
        metadata: {
          ...meta,
          files: [{ relPath: "SKILL.md", content: "   \n  " }],
        },
      }),
    );
    expect(text).not.toContain("<skill-file");
  });

  test("null metadata is skipped safely", () => {
    const text = joinText(
      skillDoc({ name: "NoMeta", kind: "skill", metadata: null }),
    );
    expect(text).not.toContain("<skill-file");
    expect(text).toContain("/NoMeta");
  });

  test("array metadata (wrong shape) is not misclassified as a skill", () => {
    const text = joinText(
      skillDoc({
        name: "WrongShape",
        kind: "skill",
        metadata: [{ role: "user", content: { type: "text", text: "hi" } }],
      }),
    );
    expect(text).not.toContain("<skill-file");
  });

  test("a prompt mention is not treated as a skill", () => {
    // Prompt metadata is an array of messages with a `role`; kind !== "skill".
    const text = joinText(
      skillDoc({
        name: "greet",
        kind: "prompt",
        metadata: [
          { role: "user", content: { type: "text", text: "Say hello" } },
        ],
      }),
    );
    expect(text).not.toContain("<skill-file");
    expect(text).toContain("[/greet]");
    expect(text).toContain("Say hello");
  });
});
