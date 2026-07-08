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
    content: "# SEO Audit\nCheck titles and meta descriptions.",
  };

  test("inlines the SKILL.md body wrapped as untrusted reference material", () => {
    const text = joinText(
      skillDoc({ name: "SEO Audit", kind: "skill", metadata: meta }),
    );
    // Resolvable id (not just the display name) so it matches <available-skills>.
    expect(text).toContain("(id: core/seo-audit)");
    // Body is delimited and framed as data, not instructions.
    expect(text).toContain('<skill-content id="core/seo-audit">');
    expect(text).toContain("</skill-content>");
    expect(text).toContain("Check titles and meta descriptions.");
    expect(text).toContain("treat");
    // File-loading note points at the sandbox mount.
    expect(text).toContain("org/public/core/seo-audit");
    expect(text).toContain("cat org/public/core/seo-audit/<file>");
    // The inline mention label survives too.
    expect(text).toContain("/SEO Audit");
  });

  test("empty content produces no skill-content part", () => {
    const text = joinText(
      skillDoc({
        name: "Empty",
        kind: "skill",
        metadata: { ...meta, content: "" },
      }),
    );
    expect(text).not.toContain("<skill-content");
    // Still renders the inline mention label.
    expect(text).toContain("/Empty");
  });

  test("whitespace-only content is treated as empty", () => {
    const text = joinText(
      skillDoc({
        name: "Blank",
        kind: "skill",
        metadata: { ...meta, content: "   \n  " },
      }),
    );
    expect(text).not.toContain("<skill-content");
  });

  test("null metadata is skipped safely", () => {
    const text = joinText(
      skillDoc({ name: "NoMeta", kind: "skill", metadata: null }),
    );
    expect(text).not.toContain("<skill-content");
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
    expect(text).not.toContain("<skill-content");
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
    expect(text).not.toContain("<skill-content");
    expect(text).toContain("[/greet]");
    expect(text).toContain("Say hello");
  });
});
