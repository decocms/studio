import { setupComponentTest } from "../../../../../test/setup";
setupComponentTest();
import { describe, expect, test } from "bun:test";
import { fireEvent, render, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Editor } from "@tiptap/core";
import { EditorContent, EditorContext } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import {
  insertMention,
  isMentionNodeAt,
  MentionNode,
  skillMdBrowsePath,
} from "./node.tsx";
import { OrgFileOpenContext } from "../../org-file-open-context";

// useT() reads the language preference via TanStack Query.
function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0, staleTime: 0 } },
  });
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

describe("mention chip aria-label", () => {
  test("matches the title-cased text shown on screen, not the raw name", async () => {
    const editor = new Editor({
      extensions: [StarterKit, MentionNode],
      content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    });
    insertMention(
      editor,
      { from: 1, to: 1 },
      {
        id: "1",
        name: "my_prompt_name",
        metadata: null,
        char: "/",
        kind: "prompt",
      },
    );

    const { container } = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
      { wrapper },
    );

    await waitFor(() => {
      expect(container.querySelector('[role="button"]')).toBeInTheDocument();
    });
    const chip = container.querySelector('[role="button"]');

    expect(chip?.textContent).toBe("/My Prompt Name");
    expect(chip?.getAttribute("aria-label")).toBe(
      "Edit My Prompt Name prompt arguments",
    );
  });
});

describe("isMentionNodeAt", () => {
  test("is true right after inserting a mention at that position", () => {
    const editor = new Editor({
      extensions: [StarterKit, MentionNode],
      content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    });
    insertMention(
      editor,
      { from: 1, to: 1 },
      {
        id: "1",
        name: "my_prompt",
        metadata: null,
        char: "/",
        kind: "prompt",
      },
    );

    expect(isMentionNodeAt(editor, 1, "1")).toBe(true);
  });

  // The edit dialog captures `pos` when a chip is clicked, then resolves
  // later (after an async prompt fetch). If the chip was deleted or the doc
  // shifted in the meantime, `pos` no longer points at that mention node —
  // this must be detected so the caller can bail instead of calling
  // `setNodeSelection(pos)`, which throws on a stale/empty position.
  test("is false once the doc changes and the position no longer holds that mention", () => {
    const editor = new Editor({
      extensions: [StarterKit, MentionNode],
      content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    });
    insertMention(
      editor,
      { from: 1, to: 1 },
      {
        id: "1",
        name: "my_prompt",
        metadata: null,
        char: "/",
        kind: "prompt",
      },
    );

    editor.chain().selectAll().deleteSelection().run();

    expect(isMentionNodeAt(editor, 1, "1")).toBe(false);
  });
});

// A skill chip's content is a file in the Library, so clicking it goes there.
describe("skillMdBrowsePath", () => {
  test("points at the skill's SKILL.md under its volume", () => {
    expect(skillMdBrowsePath({ volume: "public-core", path: "slides" })).toBe(
      "public-core/slides/SKILL.md",
    );
    expect(skillMdBrowsePath({ volume: "home", path: "skills/foo" })).toBe(
      "home/skills/foo/SKILL.md",
    );
  });

  // A chip in a draft saved before the fields existed can't say where it came
  // from. It stays inert, which is what it did before — never a wrong path.
  test("is null when the chip cannot say where it came from", () => {
    expect(skillMdBrowsePath(null)).toBeNull();
    expect(skillMdBrowsePath(undefined)).toBeNull();
    expect(
      skillMdBrowsePath({ sandboxPath: "org/public/core/slides" }),
    ).toBeNull();
    expect(skillMdBrowsePath({ volume: "home", path: "" })).toBeNull();
    expect(skillMdBrowsePath({ volume: "", path: "x" })).toBeNull();
  });
});

describe("a skill chip", () => {
  const skillEditor = () => {
    const editor = new Editor({
      extensions: [StarterKit, MentionNode],
      content: { type: "doc", content: [{ type: "paragraph", content: [] }] },
    });
    insertMention(
      editor,
      { from: 1, to: 1 },
      {
        id: "core/jira-review",
        name: "jira-review",
        metadata: { volume: "public-core", path: "jira-review" },
        char: "/",
        kind: "skill",
      },
    );
    return editor;
  };

  test("opens its SKILL.md when clicked", async () => {
    const opened: string[] = [];
    const editor = skillEditor();
    const { container } = render(
      <OrgFileOpenContext.Provider
        value={{
          orgSlug: "acme",
          threadId: undefined,
          open: (p) => opened.push(p),
        }}
      >
        <EditorContext.Provider value={{ editor }}>
          <EditorContent editor={editor} />
        </EditorContext.Provider>
      </OrgFileOpenContext.Provider>,
      { wrapper },
    );

    await waitFor(() => {
      expect(container.querySelector('[role="button"]')).toBeInTheDocument();
    });
    const chip = container.querySelector('[role="button"]') as HTMLElement;
    expect(chip.getAttribute("aria-label")).toBe("Open skill Jira Review");

    fireEvent.click(chip);
    expect(opened).toEqual(["public-core/jira-review/SKILL.md"]);
  });

  // The Library is what a click opens INTO. On a surface without one — the
  // settings prompt field, say — the chip must not look clickable and then
  // swallow the click.
  test("stays inert with no Library to open into", async () => {
    const editor = skillEditor();
    const { container } = render(
      <EditorContext.Provider value={{ editor }}>
        <EditorContent editor={editor} />
      </EditorContext.Provider>,
      { wrapper },
    );

    await waitFor(() => {
      expect(container.querySelector(".tiptap")).toBeInTheDocument();
    });
    expect(container.querySelector('[role="button"]')).not.toBeInTheDocument();
  });
});
