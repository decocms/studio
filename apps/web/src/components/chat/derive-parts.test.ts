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
    sandboxPath: "org/public/core/seo-audit",
    files: [
      { relPath: "SKILL.md", content: "# SEO Audit\nCheck titles." },
      { relPath: "references/style.md", content: "Use sentence case." },
    ],
    omittedPaths: [] as string[],
  };

  test("inlines the docs minimally, mirroring an MCP prompt", () => {
    const text = joinText(
      skillDoc({ name: "SEO Audit", kind: "skill", metadata: meta }),
    );
    // Prompt-style label, no imperative prose.
    expect(text).toContain("[/SEO Audit]");
    expect(text).not.toContain("Apply the skill");
    expect(text).not.toContain("do NOT call");
    // Every doc is delimited and labelled by its relative path, content baked.
    expect(text).toContain('<skill-file path="SKILL.md">');
    expect(text).toContain('<skill-file path="references/style.md">');
    expect(text).toContain("Check titles.");
    expect(text).toContain("Use sentence case.");
    // No omitted files → no "Other files" line.
    expect(text).not.toContain("Other files");
  });

  test("lists omitted files (scripts/assets) as paths under the mount", () => {
    const text = joinText(
      skillDoc({
        name: "Audit",
        kind: "skill",
        metadata: {
          ...meta,
          omittedPaths: ["scripts/audit.py", "assets/logo.png"],
        },
      }),
    );
    expect(text).toContain("Other files in `org/public/core/seo-audit/`:");
    expect(text).toContain("scripts/audit.py");
    expect(text).toContain("assets/logo.png");
  });

  test("renders the omitted list even when no docs were inlined", () => {
    const text = joinText(
      skillDoc({
        name: "Scripted",
        kind: "skill",
        metadata: { ...meta, files: [], omittedPaths: ["run.sh"] },
      }),
    );
    expect(text).not.toContain("<skill-file");
    expect(text).toContain("run.sh");
  });

  test("empty (no files, no omitted) produces no skill part", () => {
    const text = joinText(
      skillDoc({
        name: "Empty",
        kind: "skill",
        metadata: { ...meta, files: [], omittedPaths: [] },
      }),
    );
    expect(text).not.toContain("<skill-file");
    expect(text).not.toContain("Other files");
    // Still renders the inline mention label from the walk.
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

describe("derivePartsFromTiptapDoc — task ref mention", () => {
  /** A doc with a task @ref chip, optionally followed by the user's own text. */
  function taskDoc(
    metadata: { title?: string; description?: string | null },
    trailing = " ",
  ) {
    return {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: {
                char: "@",
                kind: "task",
                id: "task-1",
                name: metadata.title,
                metadata,
              },
            },
            { type: "text", text: trailing },
          ],
        },
      ],
    };
  }

  test("expands to title + description, not the '@name' label", () => {
    const text = joinText(
      taskDoc({ title: "Add SRI to scripts", description: "Risk of XSS." }),
    );
    expect(text).toContain("Add SRI to scripts");
    expect(text).toContain("Risk of XSS.");
    // The chip must NOT leak its "@..." label into the message text.
    expect(text).not.toContain("@Add SRI to scripts");
  });

  test("omits the description block when there is none", () => {
    const text = joinText(
      taskDoc({ title: "Just a title", description: null }),
    );
    expect(text).toBe("Just a title");
  });

  test("keeps the user's own words as a separate part", () => {
    const parts = derivePartsFromTiptapDoc(
      taskDoc(
        { title: "Fix login", description: "Broken on Safari." },
        " please prioritize",
      ) as Parameters<typeof derivePartsFromTiptapDoc>[0],
    );
    const texts = parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text);
    // User text is unshifted to the front; the task body is its own part.
    expect(texts).toContain("please prioritize");
    expect(texts.some((t) => t.includes("Broken on Safari."))).toBe(true);
  });
});

describe("derivePartsFromTiptapDoc — malformed mention metadata", () => {
  // A doc's tiptapDoc is persisted JSON and can be created/edited outside the
  // slash/agent-mention UI (e.g. via the thread API), so `metadata` can't be
  // trusted to always hold the object shape the UI would have produced.
  test("does not throw when a '/' mention's metadata array holds a non-object", () => {
    expect(() =>
      joinText(skillDoc({ name: "foo", metadata: [null] })),
    ).not.toThrow();
  });

  test("does not throw when an '@' mention's metadata is a bare primitive", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "mention",
              attrs: { char: "@", name: "bot", metadata: "oops" },
            },
          ],
        },
      ],
    };
    expect(() => joinText(doc)).not.toThrow();
  });
});
